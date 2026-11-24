/** Import builder and durable-writer tests with an in-memory persistence double. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  buildImportedSessionEvents, importShareToSession, resolveImportTarget,
} from '../lib/import.js'

function fakePersistence() {
  const created = []
  let appended = null
  return {
    created,
    get appended() { return appended },
    async list() { return [] },
    async stat(id) {
      const header = created.find(value => value.id === id)
      return header === undefined ? undefined : { header }
    },
    async create(header) {
      created.push(header)
      return {
        id: header.id,
        header,
        async append(events) { appended = events },
        async flush() {},
        async close() {},
      }
    },
  }
}

function fakeWorkspaces() {
  const calls = []
  const attached = []
  return {
    calls,
    attached,
    async create(directory, title) {
      calls.push({ directory, title })
      return {
        id: 'ws-test',
        path: directory,
        title,
        async attachSession(sessionId) { attached.push(sessionId) },
      }
    },
  }
}

test('import builder creates a closed, unseeded transcript with a title', () => {
  const built = buildImportedSessionEvents({
    title: 'Remote design chat',
    createdAt: 1000,
    sourceCwd: '/remote/project',
    messages: [
      { role: 'user', text: 'hello', time: 1000 },
      { role: 'assistant', text: 'hi', time: 2000 },
      { role: 'system', text: 'should not be imported' },
    ],
  }, { cwd: '/tmp/local-work', version: 4 })
  assert.equal(built.header.isSeeded, false)
  assert.equal(built.header.version, 4)
  assert.equal(built.header.cwd, '/tmp/local-work')
  assert.equal(built.title, 'Remote design chat')
  assert.equal(built.messageCount, 2)
  assert.equal(built.events[0].type, 'turn/start')
  assert.equal(built.events.at(-1).type, 'session/title')
  assert.equal(built.events.at(-1).data.title, 'Remote design chat')
  assert.deepEqual(built.events.at(-1).data.source, { kind: 'fallback' })
  const steps = built.events
    .filter(event => event.type === 'step/start' || event.type === 'step/end')
    .map(event => event.data.step)
  assert.deepEqual(steps, [1, 1, 2, 2])
  const surface = built.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
  assert.equal(surface.length, 2)
  assert.ok(surface.every(event => event.surfaceOp === 'append'))
  assert.equal(surface[0].data.source.kind, 'user')
  assert.equal(surface[1].data.message.source.provider, 'localshare-import')
  assert.deepEqual(
    built.events.map(event => event.seq),
    built.events.map((_, index) => index),
  )
  assert.equal(
    built.events.filter(event => event.type === 'turn/end').every(event => event.data.reason.kind === 'completed'),
    true,
  )
})

test('import builder writes the chosen permission preset knobs', () => {
  const built = buildImportedSessionEvents({
    title: 'Permission check',
    messages: [{ role: 'user', text: 'hello' }],
  }, {
    cwd: '/tmp/local-work',
    permission: { preset: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
  })
  assert.deepEqual(
    built.events.slice(0, 3).map(event => event.type),
    ['permission/preset', 'sandbox/mode', 'approval/policy'],
  )
  assert.deepEqual(built.events[0].data, { preset: 'danger-full-access' })
  assert.deepEqual(built.events[1].data, { mode: 'danger-full-access' })
  assert.deepEqual(built.events[2].data, { policy: 'never' })
  const firstUser = built.events.find(event => event.type === 'user/message')
  assert.deepEqual(built.events.at(-1).data.messageSeqs, [firstUser.seq])
})

test('import builder rejects a share with no visible messages', () => {
  assert.throws(
    () => buildImportedSessionEvents({ title: 'Empty', messages: [] }, { cwd: '/tmp' }),
    error => error.code === 'import/empty',
  )
  assert.throws(
    () => buildImportedSessionEvents({ messages: [{ role: 'system', text: 'hidden' }] }, { cwd: '/tmp' }),
    error => error.code === 'import/empty',
  )
})

test('import writes a durable session and registers the chosen directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'localshare-import-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const persistence = fakePersistence()
  const workspaces = fakeWorkspaces()
  const result = await importShareToSession({
    share: {
      sessionId: 'remote-1',
      title: 'Imported conversation',
      sourceCwd: '/remote/project',
      messages: [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi' },
      ],
    },
    targetDir: directory,
    sessionPersistence: persistence,
    workspaceRegistry: workspaces,
  })
  assert.match(result.localSessionId, /^session-/)
  assert.equal(result.workspaceId, 'ws-test')
  assert.equal(result.title, 'Imported conversation')
  assert.equal(result.messageCount, 2)
  assert.equal(persistence.created.length, 1)
  assert.equal(persistence.created[0].cwd, await resolveImportTarget(directory))
  assert.equal(workspaces.calls.length, 1)
  assert.deepEqual(workspaces.attached, [result.localSessionId])
  assert.equal(persistence.appended.at(-1).type, 'session/title')
  assert.equal(persistence.appended.filter(event => event.type === 'turn/end').length, 1)

  // A second import of the same source is deduplicated by the Host, not this
  // writer; the writer itself simply creates the requested session.
  const second = await importShareToSession({
    share: {
      sessionId: 'remote-2',
      title: 'Second',
      messages: [{ role: 'user', text: 'again' }],
    },
    targetDir: directory,
    sessionPersistence: persistence,
    workspaceRegistry: workspaces,
  })
  assert.notEqual(second.localSessionId, result.localSessionId)
})

test('existing import records are re-attached to their workspace', async () => {
  const attached = []
  const persistence = {
    async stat(id) {
      return id === 'session-good' ? { header: { id } } : undefined
    },
  }
  const workspaces = {
    async create(directory, title) {
      return {
        id: 'ws-repair',
        path: directory,
        title,
        async attachSession(id) { attached.push(id) },
      }
    },
  }
  const { attachImportRecords } = await import('../lib/import.js')
  const warnings = await attachImportRecords([
    { localSessionId: 'session-good', targetDir: '/tmp' },
    { localSessionId: 'session-missing', targetDir: '/tmp' },
  ], { sessionPersistence: persistence, workspaceRegistry: workspaces })
  assert.deepEqual(warnings, [])
  assert.deepEqual(attached, ['session-good'])
})

test('import target must be an existing absolute directory', async () => {
  await assert.rejects(
    () => resolveImportTarget('relative/path'),
    error => error.code === 'import/target-relative',
  )
  await assert.rejects(
    () => resolveImportTarget('/definitely/not/a/localshare/directory'),
    error => error.code === 'import/target-missing',
  )
})
