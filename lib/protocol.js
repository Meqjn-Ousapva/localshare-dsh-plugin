/**
 * LocalShare peer protocol.
 *
 * Phase 1 discovery is deliberately explicit: a user supplies a reachable
 * `host:port`, this module verifies it over HTTP, and the two nodes exchange
 * identities so both sides learn each other. The same connection carries
 * read-only conversation shares, and each node also pulls the peer's shares on
 * a heartbeat so one-way reachability (common behind NAT) still delivers.
 */
import { timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { networkInterfaces } from 'node:os'
import { LocalShareError } from './errors.js'
import { sanitizeShare, shareMeta } from './share.js'

export const PROTOCOL = 'localshare/1'
export const BASE_PATH = '/localshare/v1'
export const DEFAULT_PORT = 17817
export const MAX_BODY_BYTES = 1024 * 1024
export { LocalShareError }

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizePort(value, fallback = DEFAULT_PORT) {
  const port = Number(value ?? fallback)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LocalShareError('config/port', `端口无效：${String(value)}`)
  }
  return port
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function safeText(value, max) {
  return typeof value === 'string' ? value.slice(0, max).trim() : ''
}

/**
 * Accept `host`, `host:port`, `[v6]:port`, or an http(s) URL.
 * @param {string} input
 * @param {number} [defaultPort]
 * @returns {{ endpoint: string, host: string, port: number, protocol: string }}
 */
export function parseAddress(input, defaultPort = DEFAULT_PORT) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new LocalShareError('address/empty', '请输入节点地址，例如 192.168.1.10:17817')
  }
  let text = input.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (text.startsWith('[')) text = `http://${text}`
    else if (text.split(':').length > 2) text = `http://[${text}]`
    else text = `http://${text}`
  }
  let url
  try {
    url = new URL(text)
  } catch {
    throw new LocalShareError('address/invalid', `地址格式无效：${input}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalShareError('address/protocol', '只支持 http 或 https 地址')
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new LocalShareError('address/path', '地址只应包含主机和端口，不要带路径')
  }
  const port = url.port === '' ? defaultPort : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LocalShareError('address/port', `端口无效：${String(url.port)}`)
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (host === '') throw new LocalShareError('address/host', '地址缺少主机名')
  const hostPart = host.includes(':') ? `[${host}]` : host
  return { endpoint: `${url.protocol}//${hostPart}:${port}`, host, port, protocol: url.protocol }
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LocalShareError('address/protocol', '只支持 http 或 https 地址')
  }
  return `${url.protocol}//${url.host}`
}

/**
 * @param {string | undefined} value
 * @returns {string}
 */
export function normalizeRemoteIp(value) {
  if (typeof value !== 'string' || value === '') return ''
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

/**
 * @param {string} ip
 * @param {number} port
 * @returns {string}
 */
export function endpointForRemoteIp(ip, port) {
  const clean = normalizeRemoteIp(ip)
  if (clean === '') throw new LocalShareError('peer/address', '无法确定节点来源地址')
  const host = clean.includes(':') ? `[${clean}]` : clean
  return `http://${host}:${port}`
}

/**
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const clean = host.startsWith('[') ? host.slice(1, -1) : host
  return clean === 'localhost' || clean === '::1' || clean.startsWith('127.')
}

/**
 * Prefer an advertised endpoint, but never let a remote peer tell us to dial
 * our own loopback address.
 * @param {string} advertised
 * @param {string} remoteIp
 * @param {number} port
 * @returns {string}
 */
function inboundEndpoint(advertised, remoteIp, port) {
  const fallback = endpointForRemoteIp(remoteIp, port)
  if (advertised === '') return fallback
  try {
    const host = new URL(advertised).hostname
    if (!isLoopbackHost(host) || isLoopbackHost(remoteIp)) return normalizeEndpoint(advertised)
  } catch {
    return fallback
  }
  return fallback
}

/**
 * Non-internal IPv4 addresses other machines on the same network can dial.
 * @returns {string[]}
 */
export function localAddresses() {
  /** @type {string[]} */
  const addresses = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (!addresses.includes(entry.address)) addresses.push(entry.address)
    }
  }
  return addresses
}

/**
 * @param {unknown} hello
 * @returns {any}
 */
export function validateHello(hello) {
  if (!hello || typeof hello !== 'object' || Array.isArray(hello)) {
    throw new LocalShareError('hello/invalid', '节点返回的身份信息无效', 502)
  }
  if (hello.protocol !== PROTOCOL) {
    throw new LocalShareError('hello/protocol', `节点协议不兼容：${String(hello.protocol ?? '未知')}`, 502)
  }
  if (!isValidPeerId(hello.id)) {
    throw new LocalShareError('hello/id', '节点身份标识无效', 502)
  }
  if (!Number.isInteger(hello.port) || hello.port < 1 || hello.port > 65535) {
    throw new LocalShareError('hello/port', '节点端口无效', 502)
  }
  return hello
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidPeerId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{3,80}$/.test(value)
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<any>}
 */
export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LocalShareError('body/too-large', '请求体过大', 413)
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      throw new LocalShareError('body/too-large', '请求体过大', 413)
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LocalShareError('body/invalid-json', '请求体不是有效 JSON', 400)
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} value
 */
export function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {string} secret
 * @returns {boolean}
 */
function isAuthorized(req, secret) {
  if (secret === '') return true
  const raw = req.headers['x-localshare-secret']
  const provided = Array.isArray(raw) ? raw[0] : raw
  if (typeof provided !== 'string') return false
  const actual = Buffer.from(provided)
  const expected = Buffer.from(secret)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * One JSON request to a peer.
 * @param {string} endpoint
 * @param {string} path
 * @param {{ method?: string, body?: unknown, secret?: string, peerId?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function requestJson(endpoint, path, options = {}) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}${path}`)
  const timeoutMs = options.timeoutMs ?? 4000
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  /** @type {Record<string, string | number>} */
  const headers = { accept: 'application/json' }
  if (payload !== undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = payload.length
  }
  if (options.secret) headers['x-localshare-secret'] = options.secret
  if (options.peerId) headers['x-localshare-peer'] = options.peerId
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  return await new Promise((resolve, reject) => {
    let settled = false
    /** @param {unknown} error */
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const req = transport({
      protocol: url.protocol,
      hostname,
      port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          req.destroy(new LocalShareError('response/too-large', '节点响应过大', 502))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch {
          data = null
        }
        const status = res.statusCode ?? 500
        if (status >= 400) {
          const code = data?.error?.code ?? 'http/error'
          const message = data?.error?.message ?? data?.message ?? `节点返回 HTTP ${status}`
          fail(new LocalShareError(code, message, status))
          return
        }
        settled = true
        resolve(data ?? {})
      })
      res.on('error', error => fail(new LocalShareError('network/response', `读取节点响应失败：${error.message}`, 502)))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new LocalShareError('network/timeout', `连接 ${endpoint} 超时`, 504))
    })
    req.on('error', error => fail(error instanceof LocalShareError
      ? error
      : new LocalShareError('network/failed', `无法连接 ${endpoint}：${error.message}`, 502)))
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        req.destroy(new LocalShareError('network/aborted', '请求已取消', 499))
        return
      }
      options.signal.addEventListener('abort', () => {
        req.destroy(new LocalShareError('network/aborted', '请求已取消', 499))
      }, { once: true })
    }
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/**
 * One LocalShare node: an HTTP peer server plus the peers and shares it knows.
 */
export class LocalShareNode extends EventEmitter {
  /**
   * @param {{ identity: { id: string, name?: string, hostname?: string }, port?: number, bind?: string, secret?: string, advertise?: string, version?: string, heartbeatMs?: number, requestTimeoutMs?: number, maxPeers?: number }} options
   */
  constructor(options = {}) {
    super()
    if (!options.identity || !isValidPeerId(options.identity.id)) {
      throw new LocalShareError('config/identity', 'LocalShare 需要一个有效的节点身份')
    }
    this.identity = {
      id: options.identity.id,
      name: safeText(options.identity.name, 100) || options.identity.id,
      hostname: safeText(options.identity.hostname, 100),
    }
    this.port = normalizePort(options.port)
    this.bind = typeof options.bind === 'string' && options.bind !== '' ? options.bind : '0.0.0.0'
    this.secret = typeof options.secret === 'string' ? options.secret : ''
    this.advertise = typeof options.advertise === 'string' ? options.advertise.trim() : ''
    this.version = typeof options.version === 'string' ? options.version : '0.1.0'
    this.defaultPeerPort = this.port === 0 ? DEFAULT_PORT : this.port
    this.heartbeatMs = Number.isInteger(options.heartbeatMs) ? options.heartbeatMs : 15000
    this.requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) ? options.requestTimeoutMs : 4000
    this.maxPeers = Number.isInteger(options.maxPeers) ? options.maxPeers : 64
    /** @type {Map<string, any>} */
    this.peers = new Map()
    /** @type {Map<string, any>} */
    this.outgoing = new Map()
    /** @type {Map<string, { share: any, peerId: string, peerName: string, receivedAt: number }>} */
    this.incoming = new Map()
    this.revision = 0
    this.outgoingRevision = 0
    this.startedAt = Date.now()
    /** @type {import('node:http').Server | null} */
    this.server = null
    /** @type {number | null} */
    this.listenPort = null
    /** @type {{ code: string, message: string } | null} */
    this.serverError = null
    /** @type {NodeJS.Timeout | null} */
    this.heartbeatTimer = null
  }

  /** @returns {boolean} */
  get running() {
    return this.server !== null && this.listenPort !== null
  }

  /**
   * Bind the peer listener. A port in use is retained as `serverError` by the
   * caller; this method still rejects so activation can report the exact cause.
   * @returns {Promise<number>}
   */
  async start() {
    if (this.server !== null) return this.listenPort ?? this.port
    const server = createServer((req, res) => { void this.handleRequest(req, res) })
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    this.server = server
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(this.port, this.bind)
      })
    } catch (error) {
      this.server = null
      this.serverError = {
        code: error?.code ?? 'listen/failed',
        message: `LocalShare 端口 ${this.port} 监听失败：${error instanceof Error ? error.message : String(error)}`,
      }
      throw error
    }
    const address = server.address()
    if (address === null || typeof address === 'string') throw new LocalShareError('listen/address', '无法确定监听地址')
    this.listenPort = address.port
    this.defaultPeerPort = this.listenPort
    this.startedAt = Date.now()
    this.serverError = null
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => { void this.probeAll() }, this.heartbeatMs)
      this.heartbeatTimer.unref?.()
    }
    return this.listenPort
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    const server = this.server
    this.server = null
    this.listenPort = null
    if (server === null) return
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(() => { resolve() }))
  }

  /** @returns {any} */
  hello() {
    return {
      protocol: PROTOCOL,
      id: this.identity.id,
      name: this.identity.name,
      hostname: this.identity.hostname,
      port: this.listenPort ?? this.port,
      version: this.version,
      startedAt: this.startedAt,
      addresses: localAddresses(),
      endpoint: this.advertise || null,
      capabilities: ['identity', 'session-share'],
      secretRequired: this.secret !== '',
      shareRevision: this.outgoingRevision,
    }
  }

  /**
   * @param {any} peer
   * @returns {any}
   */
  peerView(peer) {
    return {
      id: peer.id,
      name: peer.name,
      hostname: peer.hostname,
      address: peer.endpoint,
      port: peer.port,
      version: peer.version,
      online: peer.online,
      lastSeen: peer.lastSeen,
      addedAt: peer.addedAt,
      direction: peer.inbound && peer.outbound ? 'mutual' : peer.outbound ? 'outbound' : 'inbound',
      latencyMs: peer.latencyMs,
      error: peer.error,
      addresses: [...peer.addresses],
    }
  }

  /** @returns {any} */
  snapshot() {
    return {
      protocol: PROTOCOL,
      running: this.running,
      error: this.serverError,
      startedAt: this.startedAt,
      self: this.hello(),
      peers: [...this.peers.values()].map(peer => this.peerView(peer)),
      shares: {
        revision: this.revision,
        outgoing: [...this.outgoing.values()].map(shareMeta),
        incoming: [...this.incoming.entries()].map(([key, item]) => ({
          key,
          peerId: item.peerId,
          peerName: item.peerName,
          receivedAt: item.receivedAt,
          ...shareMeta(item.share),
        })),
      },
    }
  }

  /** @returns {any} */
  listShares() {
    return {
      revision: this.revision,
      outgoing: [...this.outgoing.values()],
      incoming: [...this.incoming.entries()].map(([key, item]) => ({
        key,
        peerId: item.peerId,
        peerName: item.peerName,
        receivedAt: item.receivedAt,
        ...item.share,
      })),
    }
  }

  /**
   * Explicit discovery: verify the address, register it locally, then announce
   * ourselves so the peer lists us too.
   * @param {string} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<any>}
   */
  async addPeer(input, options = {}) {
    const target = parseAddress(input, this.defaultPeerPort)
    const started = Date.now()
    const hello = validateHello(await requestJson(target.endpoint, `${BASE_PATH}/hello`, {
      secret: this.secret,
      timeoutMs: this.requestTimeoutMs,
      signal: options.signal,
    }))
    if (hello.id === this.identity.id) {
      throw new LocalShareError('peer/self', '这是本机地址，不需要添加')
    }
    const existed = this.peers.has(hello.id)
    if (!existed && this.peers.size >= this.maxPeers) {
      throw new LocalShareError('peer/limit', `节点数量已达上限（${this.maxPeers}）`)
    }
    const latencyMs = Date.now() - started
    const record = this.upsertPeer({ hello, endpoint: target.endpoint, inbound: false, latencyMs })
    this.emit('peer-change', this.peerView(record))
    let response
    try {
      response = await requestJson(target.endpoint, `${BASE_PATH}/peers`, {
        method: 'POST',
        secret: this.secret,
        timeoutMs: this.requestTimeoutMs,
        signal: options.signal,
        body: { hello: this.hello(), shares: [...this.outgoing.values()] },
      })
    } catch (error) {
      if (!existed) {
        this.peers.delete(record.id)
        this.emit('peer-change', this.peerView(record))
      } else {
        this.markPeerFailure(record, error)
      }
      throw error
    }
    if (response?.hello) {
      try {
        this.updatePeerFromHello(record, validateHello(response.hello), latencyMs)
      } catch {
        // The mutual announcement is best-effort; the verified hello already counted.
      }
    }
    this.mergeRemoteShares(record.id, response?.shares)
    record.syncedRevision = Number.isInteger(response?.revision) ? response.revision : -1
    await this.syncOutgoingTo(record)
    return this.peerView(record)
  }

  /**
   * @param {string} id
   * @param {{ notify?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async removePeer(id, options = {}) {
    const record = this.peers.get(id)
    if (record === undefined) return false
    this.peers.delete(id)
    const removedShares = this.removeIncomingForPeer(id)
    if (removedShares) this.revision += 1
    this.emit('peer-change', this.peerView(record))
    if (removedShares) this.emit('share-change')
    if (options.notify !== false) {
      try {
        await requestJson(record.endpoint, `${BASE_PATH}/peers?peerId=${encodeURIComponent(this.identity.id)}`, {
          method: 'DELETE',
          secret: this.secret,
          timeoutMs: Math.min(1500, this.requestTimeoutMs),
        })
      } catch {
        // The peer may be gone already; local removal is authoritative.
      }
    }
    return true
  }

  /**
   * Push one outbound share to every known peer. Reachable peers receive it
   * immediately; the heartbeat pull covers the reverse direction.
   * @param {any} input
   * @returns {Promise<any>}
   */
  async publishShare(input) {
    const share = sanitizeShare(input, { id: this.identity.id, name: this.identity.name })
    this.outgoing.set(share.sessionId, share)
    this.revision += 1
    this.outgoingRevision += 1
    this.emit('share-change', shareMeta(share))
    await Promise.all([...this.peers.values()].map(async (peer) => {
      try {
        await requestJson(peer.endpoint, `${BASE_PATH}/shares`, {
          method: 'POST',
          secret: this.secret,
          timeoutMs: this.requestTimeoutMs,
          body: { share },
        })
        peer.error = null
        peer.lastSeen = Date.now()
      } catch (error) {
        this.markPeerFailure(peer, error)
      }
    }))
    return share
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<boolean>}
   */
  async retractShare(sessionId) {
    if (!this.outgoing.has(sessionId)) return false
    this.outgoing.delete(sessionId)
    this.revision += 1
    this.outgoingRevision += 1
    this.emit('share-change')
    await Promise.all([...this.peers.values()].map(async (peer) => {
      try {
        await requestJson(peer.endpoint, `${BASE_PATH}/shares?sessionId=${encodeURIComponent(sessionId)}&originId=${encodeURIComponent(this.identity.id)}`, {
          method: 'DELETE',
          secret: this.secret,
          timeoutMs: this.requestTimeoutMs,
        })
      } catch {
        // A stale copy disappears on the peer's next heartbeat pull.
      }
    }))
    return true
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async probePeer(id) {
    const record = this.peers.get(id)
    if (record === undefined) return false
    const started = Date.now()
    try {
      const hello = validateHello(await requestJson(record.endpoint, `${BASE_PATH}/hello`, {
        secret: this.secret,
        timeoutMs: this.requestTimeoutMs,
      }))
      if (hello.id !== record.id) {
        throw new LocalShareError('peer/identity', '节点身份与地址不匹配', 502)
      }
      const wasOffline = !record.online
      this.updatePeerFromHello(record, hello, Date.now() - started)
      record.online = true
      record.lastSeen = Date.now()
      record.error = null
      this.emit('peer-change', this.peerView(record))
      if (wasOffline) this.emit('peer-online', this.peerView(record))
      if (!Number.isInteger(record.syncedRevision) || hello.shareRevision !== record.syncedRevision) {
        await this.pullShares(record)
      }
      return true
    } catch (error) {
      this.markPeerFailure(record, error)
      return false
    }
  }

  /** @returns {Promise<boolean[]>} */
  async probeAll() {
    return await Promise.all([...this.peers.keys()].map(id => this.probePeer(id)))
  }

  /**
   * @param {string} peerId
   * @param {any} input
   * @returns {string}
   */
  ingestShare(peerId, input) {
    const peer = this.peers.get(peerId)
    if (peer === undefined) {
      throw new LocalShareError('share/unknown-peer', '未知节点，请先完成握手', 403)
    }
    if (input?.originId !== undefined && input.originId !== peerId) {
      throw new LocalShareError('share/origin-mismatch', '共享来源与节点身份不匹配', 403)
    }
    const share = sanitizeShare({ ...input, originId: peerId, originName: peer.name }, {
      id: peerId,
      name: peer.name,
    })
    const key = `${peerId}:${share.sessionId}`
    const existing = this.incoming.get(key)
    if (existing !== undefined && JSON.stringify(existing.share) === JSON.stringify(share)) return key
    this.incoming.set(key, { share, peerId, peerName: peer.name, receivedAt: Date.now() })
    this.revision += 1
    this.emit('share-received', { key, peerId, share })
    this.emit('share-change', shareMeta(share))
    return key
  }

  /**
   * @param {any} hello
   * @param {string} endpoint
   * @param {boolean} inbound
   * @param {number | undefined} latencyMs
   * @returns {any}
   */
  upsertPeer({ hello, endpoint, inbound, latencyMs }) {
    const existing = this.peers.get(hello.id)
    const now = Date.now()
    const record = existing ?? {
      id: hello.id,
      name: hello.id,
      hostname: '',
      endpoint,
      port: hello.port,
      version: '',
      online: false,
      lastSeen: 0,
      addedAt: now,
      inbound: false,
      outbound: false,
      latencyMs: null,
      error: null,
      addresses: [],
      syncedRevision: -1,
    }
    record.name = safeText(hello.name, 100) || hello.id
    record.hostname = safeText(hello.hostname, 100)
    record.port = hello.port
    record.version = safeText(hello.version, 40)
    record.addresses = Array.isArray(hello.addresses)
      ? hello.addresses.filter(value => typeof value === 'string').slice(0, 16)
      : []
    record.endpoint = endpoint
    record.inbound = record.inbound || inbound === true
    record.outbound = record.outbound || inbound !== true
    record.online = true
    record.lastSeen = now
    record.latencyMs = latencyMs ?? record.latencyMs
    record.error = null
    this.peers.set(record.id, record)
    return record
  }

  /**
   * @param {any} record
   * @param {any} hello
   * @param {number} latencyMs
   */
  updatePeerFromHello(record, hello, latencyMs) {
    record.name = safeText(hello.name, 100) || record.id
    record.hostname = safeText(hello.hostname, 100)
    record.port = hello.port
    record.version = safeText(hello.version, 40)
    record.addresses = Array.isArray(hello.addresses)
      ? hello.addresses.filter(value => typeof value === 'string').slice(0, 16)
      : []
    record.latencyMs = latencyMs
  }

  /**
   * @param {any} record
   * @param {unknown} error
   */
  markPeerFailure(record, error) {
    const wasOnline = record.online
    record.online = false
    record.error = error instanceof Error ? error.message : String(error)
    this.emit('peer-change', this.peerView(record))
    if (wasOnline) this.emit('peer-offline', this.peerView(record))
  }

  /**
   * @param {string} peerId
   * @returns {boolean}
   */
  removeIncomingForPeer(peerId) {
    let removed = false
    for (const [key, item] of this.incoming) {
      if (item.peerId !== peerId) continue
      this.incoming.delete(key)
      removed = true
    }
    return removed
  }

  /**
   * Merge a peer's authoritative outgoing set and drop shares it no longer
   * publishes. This is what makes a retraction survive an offline peer.
   * @param {string} peerId
   * @param {unknown} shares
   * @returns {void}
   */
  mergeRemoteShares(peerId, shares) {
    if (!Array.isArray(shares) || !this.peers.has(peerId)) return
    const seen = new Set()
    for (const share of shares) {
      try {
        seen.add(this.ingestShare(peerId, share))
      } catch {
        // One malformed share does not invalidate the rest of the set.
      }
    }
    let removed = false
    for (const [key, item] of this.incoming) {
      if (item.peerId !== peerId || seen.has(key)) continue
      this.incoming.delete(key)
      removed = true
    }
    if (removed) {
      this.revision += 1
      this.emit('share-change')
    }
  }

  /**
   * @param {any} peer
   * @returns {Promise<void>}
   */
  async pullShares(peer) {
    try {
      const data = await requestJson(peer.endpoint, `${BASE_PATH}/shares`, {
        secret: this.secret,
        timeoutMs: this.requestTimeoutMs,
      })
      this.mergeRemoteShares(peer.id, data?.shares)
      if (Number.isInteger(data?.revision)) peer.syncedRevision = data.revision
    } catch (error) {
      this.markPeerFailure(peer, error)
    }
  }

  /**
   * @param {any} peer
   * @returns {Promise<void>}
   */
  async syncOutgoingTo(peer) {
    for (const share of this.outgoing.values()) {
      try {
        await requestJson(peer.endpoint, `${BASE_PATH}/shares`, {
          method: 'POST',
          secret: this.secret,
          timeoutMs: this.requestTimeoutMs,
          body: { share },
        })
      } catch (error) {
        this.markPeerFailure(peer, error)
        return
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'request/url', message: '请求地址无效' } })
      return
    }
    if (url.pathname !== BASE_PATH && !url.pathname.startsWith(`${BASE_PATH}/`)) {
      sendJson(res, 404, { ok: false, error: { code: 'request/not-found', message: 'Not found' } })
      return
    }
    if (!isAuthorized(req, this.secret)) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/secret', message: '共享密钥不匹配' } })
      return
    }
    try {
      const sub = url.pathname.slice(BASE_PATH.length) || '/'
      if (sub === '/hello' && req.method === 'GET') {
        sendJson(res, 200, this.hello())
        return
      }
      if (sub === '/peers' && req.method === 'POST') {
        await this.handlePeerAnnounce(req, res)
        return
      }
      if (sub === '/peers' && req.method === 'DELETE') {
        this.handlePeerRemoval(res, url.searchParams.get('peerId'))
        return
      }
      if (sub === '/shares' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, revision: this.outgoingRevision, shares: [...this.outgoing.values()] })
        return
      }
      if (sub === '/shares' && req.method === 'POST') {
        await this.handleSharePush(req, res)
        return
      }
      if (sub === '/shares' && req.method === 'DELETE') {
        this.handleShareRetract(res, url.searchParams.get('sessionId'), url.searchParams.get('originId'))
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'request/not-found', message: 'Not found' } })
    } catch (error) {
      const status = error instanceof LocalShareError ? error.status : 500
      sendJson(res, status, {
        ok: false,
        error: {
          code: error instanceof LocalShareError ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async handlePeerAnnounce(req, res) {
    const body = await readJsonBody(req, MAX_BODY_BYTES)
    const hello = validateHello(body?.hello)
    if (hello.id === this.identity.id) {
      throw new LocalShareError('peer/self', '不能与本机握手')
    }
    if (!this.peers.has(hello.id) && this.peers.size >= this.maxPeers) {
      throw new LocalShareError('peer/limit', `节点数量已达上限（${this.maxPeers}）`)
    }
    const remoteIp = normalizeRemoteIp(req.socket.remoteAddress)
    const advertised = typeof hello.endpoint === 'string' ? hello.endpoint : ''
    const endpoint = inboundEndpoint(advertised, remoteIp, hello.port)
    const record = this.upsertPeer({ hello, endpoint, inbound: true, latencyMs: undefined })
    this.emit('peer-change', this.peerView(record))
    this.mergeRemoteShares(record.id, body?.shares)
    sendJson(res, 200, {
      ok: true,
      hello: this.hello(),
      revision: this.outgoingRevision,
      shares: [...this.outgoing.values()],
    })
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string | null} peerId
   */
  handlePeerRemoval(res, peerId) {
    if (typeof peerId !== 'string' || peerId === '') {
      throw new LocalShareError('peer/missing', '缺少节点标识')
    }
    const record = this.peers.get(peerId)
    const removed = this.peers.delete(peerId)
    const removedShares = this.removeIncomingForPeer(peerId)
    if (removedShares) this.revision += 1
    if (record !== undefined) {
      record.online = false
      this.emit('peer-change', this.peerView(record))
    }
    if (removedShares) this.emit('share-change')
    sendJson(res, 200, { ok: true, removed })
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<void>}
   */
  async handleSharePush(req, res) {
    const body = await readJsonBody(req, MAX_BODY_BYTES)
    const originId = body?.share?.originId
    if (typeof originId !== 'string' || originId === '') {
      throw new LocalShareError('share/missing-origin', '共享内容缺少来源标识')
    }
    const key = this.ingestShare(originId, body.share)
    sendJson(res, 200, { ok: true, key })
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string | null} sessionId
   * @param {string | null} originId
   */
  handleShareRetract(res, sessionId, originId) {
    if (typeof sessionId !== 'string' || sessionId === '' || typeof originId !== 'string' || originId === '') {
      throw new LocalShareError('share/missing-id', '缺少共享会话或来源标识')
    }
    const removed = this.incoming.delete(`${originId}:${sessionId}`)
    if (removed) {
      this.revision += 1
      this.emit('share-change')
    }
    sendJson(res, 200, { ok: true, removed })
  }
}
