/** Build and persist a local Session from a received LocalShare transcript. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { LocalShareError } from './errors.js'
import { MAX_MESSAGE_TEXT } from './share.js'

/** Current logical Session format in this Harness generation. */
const DEFAULT_FORMAT_VERSION = 4
/** Upper bound on messages considered for one import. */
const MAX_IMPORT_MESSAGES = 300

/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function finiteTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/**
 * Build a valid, unseeded Session log from the portable transcript. Each
 * imported user+assistant pair becomes one completed turn so the model sees a
 * clean conversation and the session log has no dangling tool calls or turns.
 * @param {any} share
 * @param {{ id?: string, cwd: string, version?: number, now?: number }} options
 * @returns {{ header: any, events: any[], title: string, messageCount: number }}
 */
export function buildImportedSessionEvents(share, options) {
  const cwd = options?.cwd
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new LocalShareError('import/cwd', '导入会话需要一个绝对路径的本地工作目录')
  }
  const id = typeof options?.id === 'string' && options.id !== '' ? options.id : `session-${randomUUID()}`
  const version = Number.isInteger(options?.version) && options.version > 0 ? options.version : DEFAULT_FORMAT_VERSION
  const now = Number.isSafeInteger(options?.now) && options.now >= 0 ? options.now : Date.now()

  /** @type {Array<{ role: 'user' | 'assistant', text: string, time?: number }>} */
  let messages = []
  for (const message of Array.isArray(share?.messages) ? share.messages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = typeof message.text === 'string' ? message.text.slice(0, MAX_MESSAGE_TEXT).trim() : ''
    if (text === '') continue
    const time = finiteTime(message.time)
    messages.push(time === undefined ? { role: message.role, text } : { role: message.role, text, time })
  }
  if (messages.length === 0) {
    throw new LocalShareError('import/empty', '这条共享没有可导入的可见消息')
  }
  messages = messages.slice(-MAX_IMPORT_MESSAGES)

  const rawTitle = typeof share?.title === 'string' ? share.title.slice(0, 200).trim() : ''
  const title = rawTitle
    || messages.find(message => message.role === 'user')?.text.slice(0, 60)
    || 'Imported conversation'

  /** @type {any[]} */
  const events = []
  let sequence = 0
  let turn = 0
  let lastTime = Math.max(0, Math.floor((finiteTime(share?.createdAt) ?? now) - messages.length * 1000))
  let firstUserSeq = -1
  let firstMessageSeq = -1

  const push = (type, time, data, surface = false) => {
    const event = { type, seq: sequence, time, data }
    sequence += 1
    if (surface) event.surfaceOp = 'append'
    events.push(event)
  }
  const assistantMessage = text => ({
    id: `msg-${randomUUID()}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'localshare-import', model: 'imported' },
  })

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const time = message.time === undefined ? lastTime + 1000 : Math.max(lastTime, Math.floor(message.time))
    lastTime = time
    turn += 1
    push('turn/start', time, { turn })
    if (message.role === 'user') {
      push('step/start', time, { turn, step: 1 })
      if (firstMessageSeq < 0) firstMessageSeq = sequence
      if (firstUserSeq < 0) firstUserSeq = sequence
      push('user/message', time, {
        id: `msg-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'user' },
      }, true)
      push('step/end', time, { turn, step: 1 })
      const next = messages[index + 1]
      if (next !== undefined && next.role === 'assistant') {
        index += 1
        const assistantTime = next.time === undefined
          ? lastTime + 1000
          : Math.max(lastTime, Math.floor(next.time))
        lastTime = assistantTime
        push('step/start', assistantTime, { turn, step: 2 })
        push('assistant/message', assistantTime, {
          turn,
          step: 2,
          message: assistantMessage(next.text),
          stream: [],
        }, true)
        push('step/end', assistantTime, { turn, step: 2 })
      }
    } else {
      push('step/start', time, { turn, step: 1 })
      if (firstMessageSeq < 0) firstMessageSeq = sequence
      push('assistant/message', time, {
        turn,
        step: 1,
        message: assistantMessage(message.text),
        stream: [],
      }, true)
      push('step/end', time, { turn, step: 1 })
    }
    push('turn/end', lastTime, { turn, reason: { kind: 'completed' } })
  }

  const titleSeq = firstUserSeq >= 0 ? firstUserSeq : firstMessageSeq
  push('session/title', Math.max(now, lastTime + 1), {
    title,
    messageSeqs: titleSeq >= 0 ? [titleSeq] : [],
    // A user-source title means a manual rename and must carry no messageSeqs;
    // the imported title is a display fallback that cites its first message.
    source: { kind: 'fallback' },
  })

  return {
    header: { version, id, createdAt: now, cwd, isSeeded: false },
    events,
    title,
    messageCount: messages.length,
  }
}

/**
 * Resolve and canonicalize a user-selected local directory.
 * @param {unknown} input
 * @returns {Promise<string>}
 */
export async function resolveImportTarget(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new LocalShareError('import/target-required', '请选择本机工作目录')
  }
  let text = input.trim()
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(homedir(), text.slice(1))
  if (!path.isAbsolute(text)) {
    throw new LocalShareError('import/target-relative', '请选择绝对路径的本地目录')
  }
  let real
  try {
    real = await fs.realpath(text)
  } catch {
    throw new LocalShareError('import/target-missing', `本机目录不存在或不可访问：${text}`)
  }
  let stat
  try {
    stat = await fs.stat(real)
  } catch {
    throw new LocalShareError('import/target-missing', `本机目录不存在或不可访问：${text}`)
  }
  if (!stat.isDirectory()) {
    throw new LocalShareError('import/target-file', `目标不是目录：${real}`)
  }
  return real
}

/**
 * @param {any} sessionPersistence
 * @returns {Promise<number>}
 */
async function readFormatVersion(sessionPersistence) {
  try {
    const snapshots = await sessionPersistence.list()
    for (const snapshot of snapshots) {
      const version = snapshot?.header?.version
      if (Number.isInteger(version) && version > 0) return version
    }
  } catch {
    // A fresh profile may have no stored session yet; the current format is the fallback.
  }
  return DEFAULT_FORMAT_VERSION
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isAlreadyExists(error) {
  return error instanceof Error
    && (error.name === 'SessionAlreadyExistsError' || error.code === 'session/already-exists')
}

/**
 * Ensure imported Sessions are accounted by their Workspaces. A Workspace row
 * only lists the session ids in its own account; writing a Session to
 * persistence alone does not change the sidebar. This is idempotent and is
 * used both at activation (repairing old imports) and on a repeated import.
 * @param {readonly any[]} records
 * @param {{ sessionPersistence: any, workspaceRegistry: any }} services
 * @returns {Promise<Array<{ localSessionId: string, message: string }>>}
 */
export async function attachImportRecords(records, { sessionPersistence, workspaceRegistry }) {
  const warnings = []
  if (sessionPersistence === undefined || sessionPersistence === null
    || workspaceRegistry === undefined || workspaceRegistry === null) return warnings
  for (const record of records) {
    try {
      if (await sessionPersistence.stat(record.localSessionId) === undefined) continue
      const workspace = await workspaceRegistry.create(
        record.targetDir,
        path.basename(record.targetDir) || 'LocalShare import',
      )
      await workspace.attachSession(record.localSessionId)
    } catch (error) {
      warnings.push({
        localSessionId: record.localSessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return warnings
}

/**
 * Create a durable local Session from one incoming share and register the
 * chosen directory as a Workspace. No peer files are copied.
 * @param {{ share: any, targetDir: string, sessionPersistence: any, workspaceRegistry: any }} input
 * @returns {Promise<{ localSessionId: string, workspaceId: string, targetDir: string, title: string, messageCount: number, importedAt: number }>}
 */
export async function importShareToSession({ share, targetDir, sessionPersistence, workspaceRegistry }) {
  if (sessionPersistence === undefined || sessionPersistence === null) {
    throw new LocalShareError('import/unavailable', '当前 Harness 没有提供会话持久化服务')
  }
  if (workspaceRegistry === undefined || workspaceRegistry === null) {
    throw new LocalShareError('import/unavailable', '当前 Harness 没有提供工作区服务')
  }
  const realDir = await resolveImportTarget(targetDir)
  const version = await readFormatVersion(sessionPersistence)
  const workspace = await workspaceRegistry.create(realDir, path.basename(realDir) || 'LocalShare import')
  const now = Date.now()
  /** @type {any} */
  let handle
  /** @type {ReturnType<typeof buildImportedSessionEvents> | undefined} */
  let built
  /** @type {unknown} */
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = `session-${randomUUID()}`
    built = buildImportedSessionEvents(share, { id, cwd: realDir, version, now })
    try {
      handle = await sessionPersistence.create(built.header)
      break
    } catch (error) {
      lastError = error
      if (isAlreadyExists(error)) continue
      throw error
    }
  }
  if (handle === undefined || built === undefined) {
    throw lastError instanceof Error
      ? lastError
      : new LocalShareError('import/create', '无法创建导入会话')
  }
  try {
    await handle.append(built.events)
    await handle.flush()
  } finally {
    await handle.close().catch(() => {})
  }
  // A persisted Session is not visible in the sidebar until its Workspace
  // accounts it. `create` only registers the directory; attach is the normal
  // membership write the live Agent lifecycle also performs.
  try {
    await workspace.attachSession(built.header.id)
  } catch (error) {
    throw new LocalShareError(
      'import/attach',
      `会话已写入，但无法挂到工作区：${error instanceof Error ? error.message : String(error)}`,
      500,
    )
  }
  return {
    localSessionId: built.header.id,
    workspaceId: workspace.id,
    targetDir: realDir,
    title: built.title,
    messageCount: built.messageCount,
    importedAt: now,
  }
}
