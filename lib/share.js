/** Transcript construction and wire-format validation for shared conversations. */
import { LocalShareError } from './errors.js'

/** Upper bound on preserved messages in one share. */
export const MAX_SHARE_MESSAGES = 300
/** Upper bound on one message's text. */
export const MAX_MESSAGE_TEXT = 8000
/** Upper bound on the serialized share pushed to a peer. */
export const MAX_SHARE_BYTES = 768 * 1024

const ROLES = new Set(['user', 'assistant', 'tool', 'system'])

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function textField(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Render one content block as plain transcript text.
 * @param {any} block
 * @returns {string}
 */
export function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'image') return '〔图片〕'
  if (block.type === 'file') {
    const name = typeof block.attachment?.name === 'string' ? block.attachment.name : ''
    return name === '' ? '〔文件〕' : `〔文件 ${name}〕`
  }
  if (block.type === 'tool-call') {
    return typeof block.name === 'string' && block.name !== '' ? `〔调用工具 ${block.name}〕` : '〔调用工具〕'
  }
  return ''
}

/**
 * Join the text-bearing blocks of one message.
 * @param {unknown} content
 * @returns {string}
 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(part => part.trim() !== '').join('\n').trim()
}

/**
 * Fold a session event log into the read-only transcript the peer receives.
 * Only user-visible conversation text and tool names are exported: prompts,
 * reasoning blocks, tool arguments, and tool output stay local.
 * @param {readonly any[]} events
 * @returns {Array<{role: string, text: string, time?: number}>}
 */
export function buildTranscript(events) {
  /** @type {Array<{role: string, text: string, time?: number}>} */
  const messages = []
  if (!Array.isArray(events)) return messages
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    let role
    let content
    if (event.type === 'user/message') {
      // Only a human-authored turn belongs in a shared conversation. The
      // harness also writes runtime context, skill catalogs, time samples, and
      // subagent relays as `user/message`; their source kind distinguishes them.
      if (event.data?.source?.kind !== 'user') continue
      role = 'user'
      content = event.data?.content
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      content = event.data?.message?.content
    } else {
      continue
    }
    const text = contentText(content).slice(0, MAX_MESSAGE_TEXT).trim()
    if (text === '') continue
    const time = finiteNumber(event.time)
    messages.push(time === undefined ? { role, text } : { role, text, time })
  }
  return messages.slice(-MAX_SHARE_MESSAGES)
}

/**
 * A readable fallback title from the first user message.
 * @param {ReadonlyArray<{role: string, text: string}>} messages
 * @param {string} fallback
 * @returns {string}
 */
export function deriveTitle(messages, fallback = '') {
  const first = messages.find(message => message.role === 'user' && message.text.trim() !== '')
  if (first === undefined) return fallback
  const text = first.text.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * Validate and bound one share crossing the wire.
 * @param {any} input
 * @param {{ id?: string, name?: string }} [origin] local identity, or the sending peer for inbound shares
 * @returns {any}
 */
export function sanitizeShare(input, origin = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new LocalShareError('share/invalid', '共享内容格式无效')
  }
  const sessionId = textField(input.sessionId, 200).trim()
  if (sessionId === '' || !/^[A-Za-z0-9._:-]+$/.test(sessionId)) {
    throw new LocalShareError('share/invalid-session', '共享会话标识无效')
  }
  const suppliedOrigin = typeof input.originId === 'string' ? input.originId : undefined
  if (origin.id !== undefined && suppliedOrigin !== undefined && suppliedOrigin !== origin.id) {
    throw new LocalShareError('share/origin-mismatch', '共享来源与节点身份不匹配', 403)
  }
  const originId = textField(origin.id ?? suppliedOrigin, 80).trim()
  if (originId === '' || !/^[A-Za-z0-9._-]+$/.test(originId)) {
    throw new LocalShareError('share/invalid-origin', '共享来源标识无效')
  }
  const originName = textField(input.originName ?? origin.name ?? originId, 100).trim() || originId
  const title = textField(input.title, 200).trim() || sessionId
  /** @type {Array<{role: string, text: string, time?: number}>} */
  const messages = []
  const rawMessages = Array.isArray(input.messages) ? input.messages.slice(-MAX_SHARE_MESSAGES) : []
  for (const message of rawMessages) {
    if (!message || typeof message !== 'object') continue
    const text = textField(message.text, MAX_MESSAGE_TEXT).trim()
    if (text === '') continue
    const role = ROLES.has(message.role) ? message.role : 'assistant'
    const time = finiteNumber(message.time)
    messages.push(time === undefined ? { role, text } : { role, text, time })
  }
  const share = {
    sessionId,
    title,
    originId,
    originName,
    createdAt: finiteNumber(input.createdAt) ?? Date.now(),
    updatedAt: finiteNumber(input.updatedAt) ?? Date.now(),
    sharedAt: finiteNumber(input.sharedAt) ?? Date.now(),
    messages,
  }
  let encoded = JSON.stringify(share)
  while (messages.length > 0 && Buffer.byteLength(encoded) > MAX_SHARE_BYTES) {
    // Drop a batch rather than reserializing once per message.
    messages.splice(0, Math.max(1, Math.floor(messages.length / 10)))
    encoded = JSON.stringify(share)
  }
  share.messageCount = messages.length
  encoded = JSON.stringify(share)
  if (Buffer.byteLength(encoded) > MAX_SHARE_BYTES) {
    throw new LocalShareError('share/too-large', '共享内容过大，请减少会话长度后重试', 413)
  }
  return share
}

/**
 * Status-row projection without the transcript body.
 * @param {any} share
 * @returns {any}
 */
export function shareMeta(share) {
  const { messages, ...rest } = share
  return { ...rest, messageCount: Array.isArray(messages) ? messages.length : 0 }
}

/**
 * Build one outbound share from the live-preferred session corpus.
 * @param {any} sessionQuery
 * @param {string} sessionId
 * @param {{ id: string, name: string }} origin
 * @returns {Promise<any>}
 */
export async function buildShareFromQuery(sessionQuery, sessionId, origin) {
  if (sessionQuery === undefined || sessionQuery === null) {
    throw new LocalShareError('share/unavailable', '当前 Harness 没有提供会话读取服务')
  }
  let title = ''
  try {
    const observed = await sessionQuery.readTitle(sessionId)
    // readTitle returns the snapshot itself (`title` is a string); tolerate the
    // observation wrapper as well for callers that hand one over.
    const value = typeof observed?.title === 'string' ? observed.title : observed?.title?.title
    if (typeof value === 'string') title = value
  } catch {
    // A title is optional; the transcript falls back to its first user message.
  }
  const snapshot = await sessionQuery.readSession(sessionId)
  const messages = buildTranscript(snapshot?.events)
  const last = Array.isArray(snapshot?.events) ? snapshot.events[snapshot.events.length - 1] : undefined
  return sanitizeShare({
    sessionId,
    title: title || deriveTitle(messages, sessionId),
    originId: origin.id,
    originName: origin.name,
    createdAt: snapshot?.session?.createdAt,
    updatedAt: last?.time ?? Date.now(),
    messages,
  }, origin)
}

/**
 * List the newest ordinary conversations the user can choose to share.
 * @param {any} sessionQuery
 * @param {{ limit?: number }} [options]
 * @returns {Promise<Array<{ id: string, title: string, createdAt: number, live: boolean, cwd: string | null }>>}
 */
export async function listShareableSessions(sessionQuery, options = {}) {
  if (sessionQuery === undefined || sessionQuery === null) {
    throw new LocalShareError('share/unavailable', '当前 Harness 没有提供会话读取服务')
  }
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 50
  const records = await sessionQuery.listSessions()
  const visible = records
    .filter(record => record?.header !== undefined
      && record.header.origin !== 'subagent'
      && record.formatStatus !== 'migration-required')
    .slice(0, limit)
  const titles = new Map()
  if (visible.length > 0) {
    try {
      const observations = await sessionQuery.readTitleSnapshots(visible.map(record => record.header.id))
      for (const observation of observations) {
        if (observation.status !== 'fulfilled') continue
        const title = observation.value?.title?.title
        if (typeof title === 'string' && title.trim() !== '') titles.set(observation.sessionId, title)
      }
    } catch {
      // Individual titles are cosmetic; identifiers remain usable.
    }
  }
  return visible.map((record) => ({
    id: record.header.id,
    title: titles.get(record.header.id) || String(record.header.id).slice(0, 16),
    createdAt: finiteNumber(record.header.createdAt) ?? 0,
    live: record.live === true,
    cwd: typeof record.header.cwd === 'string' ? record.header.cwd : null,
  }))
}
