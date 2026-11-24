/**
 * LocalShare Host half.
 *
 * Phase 1 scope: a user supplies an explicit `host:port`, the node verifies it,
 * both sides announce their identity, and chosen conversations stream as
 * read-only snapshots. No broadcast, mDNS, relay, or automatic multi-subnet
 * discovery is attempted here.
 */
import path from 'node:path'
import { LocalShareNode, LocalShareError, DEFAULT_PORT, parseAddress, readJsonBody, sendJson } from './lib/protocol.js'
import { loadIdentity } from './lib/identity.js'
import { buildShareFromQuery, listShareableSessions, shareMeta } from './lib/share.js'
import { attachImportRecords, importShareToSession, inspectStoredSession } from './lib/import.js'
import { loadImports, saveImports } from './lib/imports.js'

const VERSION = '0.1.4'
const UI_PREFIX = '/api/localshare'
const UI_BODY_BYTES = 64 * 1024
const REBUILD_DELAY_MS = 700

export const name = 'localshare'
export const inject = ['webServer', 'connection', 'tools', 'sessionQuery']

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LocalShareError(`request/${field}`, `缺少 ${field}`)
  }
  return value.trim()
}

/**
 * Resolve one local permission preset into its durable knob bundle.
 * @param {any} ctx
 * @param {unknown} name
 * @returns {{ preset: string, sandbox: string, approval: string } | undefined}
 */
function resolvePermissionPreset(ctx, name) {
  if (typeof name !== 'string' || name.trim() === '') return undefined
  const preset = name.trim()
  const service = ctx.get('permissionPresets')
  if (service === undefined) {
    throw new LocalShareError('import/permission-unavailable', '当前 Harness 没有提供权限预设服务')
  }
  try {
    const spec = service.resolve(preset)
    return { preset, sandbox: spec.sandbox, approval: spec.approval }
  } catch (error) {
    throw new LocalShareError('import/permission', `权限预设不可用：${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @param {Record<string, unknown>} config
 * @returns {any}
 */
function normalizeConfig(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const port = Number(source.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LocalShareError('config/port', `本地监听端口无效：${String(source.port)}`)
  }
  const bind = typeof source.bind === 'string' && source.bind.trim() !== '' ? source.bind.trim() : '0.0.0.0'
  const secret = typeof source.secret === 'string' ? source.secret : ''
  if (secret.length > 256) throw new LocalShareError('config/secret', '共享密钥不能超过 256 个字符')
  let advertise = ''
  if (typeof source.advertise === 'string' && source.advertise.trim() !== '') {
    advertise = parseAddress(source.advertise, port === 0 ? DEFAULT_PORT : port).endpoint
  }
  const heartbeatMs = Number(source.heartbeatMs ?? 15000)
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 0 || heartbeatMs > 3600000) {
    throw new LocalShareError('config/heartbeat', '心跳间隔无效')
  }
  const requestTimeoutMs = Number(source.requestTimeoutMs ?? 4000)
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 500 || requestTimeoutMs > 120000) {
    throw new LocalShareError('config/timeout', '请求超时无效')
  }
  const maxPeers = Number(source.maxPeers ?? 64)
  if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > 512) {
    throw new LocalShareError('config/maxPeers', '节点上限无效')
  }
  return {
    port,
    bind,
    secret,
    advertise,
    heartbeatMs,
    requestTimeoutMs,
    maxPeers,
    id: typeof source.id === 'string' ? source.id : undefined,
    name: typeof source.name === 'string' ? source.name : undefined,
    stateDir: typeof source.stateDir === 'string' ? source.stateDir : undefined,
    identityFile: typeof source.identityFile === 'string' ? source.identityFile : undefined,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 * @returns {Promise<void>}
 */
export async function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const { identity, file: identityFile, warning } = await loadIdentity(settings)
  const importsFile = path.join(path.dirname(identityFile), 'imports.json')
  let importRecords = []
  let importsWarning = null
  try {
    importRecords = await loadImports(importsFile)
  } catch (error) {
    importsWarning = `无法读取导入记录 ${importsFile}：${error instanceof Error ? error.message : String(error)}`
  }
  // Imported sessions written by an earlier plugin build may exist in
  // persistence without Workspace membership. Re-attach them once the
  // storage and workspace services are available; attach is idempotent.
  ctx.inject(['sessionPersistence', 'workspaceRegistry'], (scope) => {
    void attachImportRecords(importRecords, {
      sessionPersistence: scope.sessionPersistence,
      workspaceRegistry: scope.workspaceRegistry,
    }).then(async (warnings) => {
      const corruptIds = new Set(warnings.filter(warning => warning.corrupt === true).map(warning => warning.localSessionId))
      if (corruptIds.size > 0) {
        importRecords = importRecords.filter(record => !corruptIds.has(record.localSessionId))
        try {
          await saveImports(importsFile, importRecords)
        } catch {
          // The record removal still applies in memory; a later write can retry.
        }
      }
      const first = warnings[0]
      if (first !== undefined) {
        importsWarning = first.corrupt === true
          ? `旧导入会话 ${first.localSessionId} 的日志已损坏，已从工作区移除并清除导入记录。请重新导入该共享。`
          : `无法挂接已导入会话 ${first.localSessionId}：${first.message}`
      }
    })
    return () => {}
  })
  const node = new LocalShareNode({
    identity,
    port: settings.port,
    bind: settings.bind,
    secret: settings.secret,
    advertise: settings.advertise,
    version: VERSION,
    heartbeatMs: settings.heartbeatMs,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxPeers: settings.maxPeers,
  })

  try {
    await node.start()
  } catch {
    // `node.serverError` carries the listen failure into status and the UI.
  }

  ctx.effect(() => () => { void node.stop() }, 'localshare: peer listener')

  /** @param {string} sessionId */
  const shareSession = async (sessionId) => {
    const share = await buildShareFromQuery(ctx.sessionQuery, sessionId, identity)
    const existing = node.outgoing.get(sessionId)
    if (existing !== undefined) share.sharedAt = existing.sharedAt
    await node.publishShare(share)
    return share
  }

  /** @param {string} sessionId */
  const unshareSession = async (sessionId) => await node.retractShare(sessionId)

  const listSessions = async () => {
    const sessions = await listShareableSessions(ctx.sessionQuery, { limit: 50 })
    return {
      ok: true,
      sessions: sessions.map(session => ({ ...session, shared: node.outgoing.has(session.id) })),
      sharedSessionIds: [...node.outgoing.keys()],
    }
  }

  const sandboxProbes = new Map()
  /** @param {string} mode */
  const sandboxModeUsable = (mode) => {
    if (mode === 'danger-full-access') return Promise.resolve(true)
    if (!sandboxProbes.has(mode)) {
      sandboxProbes.set(mode, (async () => {
        const sandbox = ctx.get('sandbox')
        if (sandbox === undefined) return false
        const policy = ctx.get('sandboxPolicy')
        const workspaceRoot = typeof policy?.workspaceRoot === 'string' && path.isAbsolute(policy.workspaceRoot)
          ? policy.workspaceRoot
          : process.cwd()
        try {
          await sandbox.confine([process.execPath, '--version'], { mode, workspaceRoot })
          return true
        } catch (error) {
          return !(error?.code === 'SANDBOX_UNAVAILABLE'
            || /no sandbox backend is usable/i.test(error instanceof Error ? error.message : String(error)))
        }
      })())
    }
    return sandboxProbes.get(mode)
  }

  const listPermissionPresets = async () => {
    const service = ctx.get('permissionPresets')
    if (service === undefined) return { ok: true, options: [], defaultPreset: null }
    const catalog = service.catalog()
    const options = []
    for (const option of catalog.options) {
      if (option.value === 'custom') continue
      try {
        const spec = service.resolve(option.value)
        options.push({
          ...option,
          sandbox: spec.sandbox,
          approval: spec.approval,
          usable: await sandboxModeUsable(spec.sandbox),
        })
      } catch {
        // An option that cannot resolve right now is not offerable for import.
      }
    }
    return { ok: true, options, defaultPreset: catalog.defaultPreset }
  }

  const importIncomingShare = async (peerId, sessionId, targetDir, permissionPreset) => {
    const item = node.incoming.get(`${peerId}:${sessionId}`)
    if (item === undefined) {
      throw new LocalShareError('import/not-found', '没有找到这条共享，可能已被对方撤回', 404)
    }
    const persistence = ctx.get('sessionPersistence')
    const existing = importRecords.find(record => record.sourcePeerId === peerId && record.sourceSessionId === sessionId)
    if (existing !== undefined) {
      if (persistence !== undefined) {
        const inspection = await inspectStoredSession(persistence, existing.localSessionId)
        if (inspection.status === 'healthy') {
          const workspaces = ctx.get('workspaceRegistry')
          if (workspaces === undefined) return { ...existing, alreadyImported: true }
          const warnings = await attachImportRecords([existing], {
            sessionPersistence: persistence,
            workspaceRegistry: workspaces,
          })
          return {
            ...existing,
            alreadyImported: true,
            ...(warnings[0] === undefined ? {} : { warning: warnings[0].message }),
          }
        }
        if (inspection.status === 'corrupt') {
          const workspaces = ctx.get('workspaceRegistry')
          if (workspaces !== undefined) {
            try {
              await workspaces.archiveSession(existing.localSessionId, { stopActivity: true })
            } catch {
              // Best-effort hide; the old log remains on disk.
            }
            if (typeof workspaces.get === 'function') {
              try {
                const workspace = workspaces.get(existing.workspaceId)
                if (workspace !== undefined) await workspace.detachSession(existing.localSessionId)
              } catch {
                // Best-effort detach.
              }
            }
          }
        }
      }
      importRecords = importRecords.filter(record => record !== existing)
    }
    const permission = resolvePermissionPreset(ctx, permissionPreset)
    if (permission !== undefined && !await sandboxModeUsable(permission.sandbox)) {
      throw new LocalShareError(
        'import/sandbox',
        `当前主机无法使用 sandbox 模式 "${permission.sandbox}"；请选择 danger-full-access 预设，或先安装可用的 sandbox 后端。`,
      )
    }
    if (permission === undefined) {
      const service = ctx.get('permissionPresets')
      const defaultPreset = service?.catalog().defaultPreset
      if (typeof defaultPreset === 'string' && defaultPreset !== '') {
        try {
          const spec = service.resolve(defaultPreset)
          if (!await sandboxModeUsable(spec.sandbox)) {
            throw new LocalShareError(
              'import/sandbox',
              `本机默认预设 "${defaultPreset}" 需要不可用的 sandbox；请在导入时选择 danger-full-access 预设。`,
            )
          }
        } catch (error) {
          if (error instanceof LocalShareError) throw error
        }
      }
    }
    const result = await importShareToSession({
      share: item.share,
      targetDir,
      sessionPersistence: persistence,
      workspaceRegistry: ctx.get('workspaceRegistry'),
      permission,
    })
    const record = {
      localSessionId: result.localSessionId,
      workspaceId: result.workspaceId,
      targetDir: result.targetDir,
      sourcePeerId: peerId,
      sourcePeerName: item.peerName,
      sourceSessionId: sessionId,
      sourceTitle: item.share.title,
      sourceCwd: item.share.sourceCwd ?? null,
      importedAt: result.importedAt,
      messageCount: result.messageCount,
    }
    importRecords.unshift(record)
    if (importRecords.length > 200) importRecords.length = 200
    let saveWarning = null
    try {
      await saveImports(importsFile, importRecords)
    } catch (error) {
      saveWarning = `导入成功，但无法保存导入记录：${error instanceof Error ? error.message : String(error)}`
    }
    return { ...record, alreadyImported: false, warning: saveWarning }
  }

  const status = () => ({
    ok: true,
    ...node.snapshot(),
    identityFile,
    warning,
    imports: importRecords.slice(0, 50),
    importsWarning,
    config: {
      port: settings.port,
      bind: settings.bind,
      advertise: settings.advertise || null,
      secretRequired: settings.secret !== '',
      heartbeatMs: settings.heartbeatMs,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxPeers: settings.maxPeers,
    },
  })

  // Live refresh for conversations that are currently shared. The durable log
  // remains the source of truth; this timer only recomputes the exported view.
  const rebuildTimers = new Map()
  let disposed = false
  /** @param {string} sessionId */
  const rebuildShare = async (sessionId) => {
    if (disposed) return
    const existing = node.outgoing.get(sessionId)
    if (existing === undefined) return
    try {
      const next = await buildShareFromQuery(ctx.sessionQuery, sessionId, identity)
      next.sharedAt = existing.sharedAt
      if (JSON.stringify(next.messages) === JSON.stringify(existing.messages) && next.title === existing.title) return
      await node.publishShare(next)
    } catch {
      // The session may have been archived while shared; keep the last snapshot.
    }
  }
  /** @param {string} sessionId */
  const scheduleRebuild = (sessionId) => {
    if (disposed || !node.outgoing.has(sessionId)) return
    const previous = rebuildTimers.get(sessionId)
    if (previous !== undefined) clearTimeout(previous)
    const timer = setTimeout(() => {
      rebuildTimers.delete(sessionId)
      void rebuildShare(sessionId)
    }, REBUILD_DELAY_MS)
    timer.unref?.()
    rebuildTimers.set(sessionId, timer)
  }
  ctx.on('session/event', (session) => {
    if (node.outgoing.has(session.id)) scheduleRebuild(session.id)
  })
  ctx.effect(() => () => {
    disposed = true
    for (const timer of rebuildTimers.values()) clearTimeout(timer)
    rebuildTimers.clear()
  }, 'localshare: share refresh timers')

  node.on('peer-online', (peer) => {
    const record = node.peers.get(peer.id)
    if (record !== undefined) void node.syncOutgoingTo(record)
  })

  const handleRoute = async (req, res) => {
    let rejection
    try {
      rejection = ctx.connection.requestRejection(req)
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: { code: 'ui/auth', message: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    let sub = '/'
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      sub = url.pathname.slice(UI_PREFIX.length) || '/'
    } catch {
      sendJson(res, 400, { ok: false, error: { code: 'request/url', message: '请求地址无效' } })
      return
    }
    try {
      if (req.method === 'GET' && sub === '/status') {
        sendJson(res, 200, status())
        return
      }
      if (req.method === 'GET' && sub === '/sessions') {
        sendJson(res, 200, await listSessions())
        return
      }
      if (req.method === 'GET' && sub === '/shares') {
        sendJson(res, 200, { ok: true, ...node.listShares() })
        return
      }
      if (req.method === 'GET' && sub === '/permission-presets') {
        sendJson(res, 200, await listPermissionPresets())
        return
      }
      if (req.method === 'POST' && sub === '/peers') {
        const body = await readJsonBody(req, UI_BODY_BYTES)
        const peer = await node.addPeer(requireString(body.address, 'address'))
        sendJson(res, 200, { ok: true, peer })
        return
      }
      if (req.method === 'DELETE' && sub === '/peers') {
        const body = await readJsonBody(req, UI_BODY_BYTES)
        const removed = await node.removePeer(requireString(body.id, 'id'))
        sendJson(res, 200, { ok: true, removed })
        return
      }
      if (req.method === 'POST' && sub === '/share') {
        const body = await readJsonBody(req, UI_BODY_BYTES)
        const share = await shareSession(requireString(body.sessionId, 'sessionId'))
        sendJson(res, 200, { ok: true, share: shareMeta(share) })
        return
      }
      if (req.method === 'DELETE' && sub === '/share') {
        const body = await readJsonBody(req, UI_BODY_BYTES)
        const removed = await unshareSession(requireString(body.sessionId, 'sessionId'))
        sendJson(res, 200, { ok: true, removed })
        return
      }
      if (req.method === 'POST' && sub === '/import') {
        const body = await readJsonBody(req, UI_BODY_BYTES)
        const result = await importIncomingShare(
          requireString(body.peerId, 'peerId'),
          requireString(body.sessionId, 'sessionId'),
          requireString(body.targetDir, 'targetDir'),
          typeof body.permissionPreset === 'string' ? body.permissionPreset : undefined,
        )
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      sendJson(res, 404, { ok: false, error: { code: 'ui/not-found', message: '未知的 LocalShare 接口' } })
    } catch (error) {
      const statusCode = error instanceof LocalShareError ? error.status : 500
      sendJson(res, statusCode, {
        ok: false,
        error: {
          code: error instanceof LocalShareError ? error.code : 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: UI_PREFIX,
    handler: handleRoute,
  }), `localshare: ${UI_PREFIX}`)

  const tool = {
    name: 'localshare',
    description: 'Discover LocalShare peers on other DSH machines by explicit host:port and share read-only conversation transcripts. '
      + 'Actions: status, list_peers, add_peer (address), remove_peer (peerId), list_sessions, share_session (sessionId), '
      + 'unshare_session (sessionId), list_shares (metadata only), import_share (peerId, sessionId, targetDir, permissionPreset). '
      + 'import_share creates a new local Session from a received share in an existing local directory; it copies no peer files. '
      + 'permissionPreset is optional and must come from localshare list_permission_presets; ask the user before choosing a preset whose approval is never. '
      + 'Ask the user which local directory to use before importing. Discovery is manual in this phase; the peer must also run LocalShare.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'list_peers', 'add_peer', 'remove_peer', 'list_sessions', 'share_session', 'unshare_session', 'list_shares', 'list_permission_presets', 'import_share'],
          description: 'Operation to perform.',
        },
        address: { type: 'string', description: 'Peer address for add_peer, e.g. 192.168.1.23:17817.' },
        peerId: { type: 'string', description: 'Peer identity for remove_peer.' },
        sessionId: { type: 'string', description: 'Conversation identity for share_session, unshare_session, or import_share.' },
        targetDir: { type: 'string', description: 'Existing absolute local directory for import_share; ask the user to choose it.' },
        permissionPreset: { type: 'string', description: 'Optional local permission preset for import_share; list_permission_presets returns the available values.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = requireString(args?.action, 'action')
      switch (action) {
        case 'status':
          return status()
        case 'list_peers':
          return { ok: true, peers: node.snapshot().peers }
        case 'add_peer':
          return { ok: true, peer: await node.addPeer(requireString(args.address, 'address')) }
        case 'remove_peer':
          return { ok: true, removed: await node.removePeer(requireString(args.peerId, 'peerId')) }
        case 'list_sessions':
          return await listSessions()
        case 'share_session':
          return { ok: true, share: shareMeta(await shareSession(requireString(args.sessionId, 'sessionId'))) }
        case 'unshare_session':
          return { ok: true, removed: await unshareSession(requireString(args.sessionId, 'sessionId')) }
        case 'list_shares':
          return { ok: true, ...node.snapshot().shares }
        case 'list_permission_presets':
          return await listPermissionPresets()
        case 'import_share':
          return {
            ok: true,
            ...await importIncomingShare(
              requireString(args.peerId, 'peerId'),
              requireString(args.sessionId, 'sessionId'),
              requireString(args.targetDir, 'targetDir'),
              typeof args.permissionPreset === 'string' ? args.permissionPreset : undefined,
            ),
          }
        default:
          throw new LocalShareError('tool/action', `未知操作：${action}`)
      }
    },
  }
  ctx.effect(() => ctx.tools.register(tool), 'localshare: agent tool')
}
