/** Protocol-level tests; no Harness runtime is required. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalShareNode, LocalShareError, parseAddress } from '../lib/protocol.js'
import { loadIdentity } from '../lib/identity.js'
import {
  buildTranscript, deriveTitle, sanitizeShare, listShareableSessions, MAX_SHARE_BYTES,
} from '../lib/share.js'

const ALPHA = 'ls-aaaaaaaaaaaaaaaa'
const BETA = 'ls-bbbbbbbbbbbbbbbb'

/**
 * @param {string} id
 * @param {string} name
 * @param {Record<string, unknown>} [extra]
 */
async function startNode(id, name, extra = {}) {
  const node = new LocalShareNode({
    identity: { id, name, hostname: 'test-host' },
    port: 0,
    bind: '127.0.0.1',
    heartbeatMs: 0,
    requestTimeoutMs: 1500,
    ...extra,
  })
  const port = await node.start()
  return { node, port }
}

test('parseAddress accepts the documented forms and rejects paths', () => {
  assert.equal(parseAddress('192.168.1.5:17817').endpoint, 'http://192.168.1.5:17817')
  assert.equal(parseAddress('http://example.com:9000/').endpoint, 'http://example.com:9000')
  assert.equal(parseAddress('::1', 17817).endpoint, 'http://[::1]:17817')
  assert.equal(parseAddress('[::1]:9000').endpoint, 'http://[::1]:9000')
  assert.equal(parseAddress('peer.local', 17817).endpoint, 'http://peer.local:17817')
  assert.throws(() => parseAddress('http://host:17817/path'), LocalShareError)
  assert.throws(() => parseAddress(''), LocalShareError)
})

test('transcript exports visible text and tool names only', () => {
  const events = [
    { type: 'user/message', time: 1, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'user/message', time: 1, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'runtime context' }] } },
    {
      type: 'assistant/message',
      time: 2,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool-call', name: 'bash', arguments: '{"cmd":"secret"}' },
          ],
        },
      },
    },
    {
      type: 'tool/result',
      time: 3,
      data: { message: { role: 'tool', content: [{ type: 'text', text: 'secret output' }] } },
    },
    { type: 'developer/message', time: 4, data: { message: { content: [{ type: 'text', text: 'hidden' }] } } },
  ]
  const messages = buildTranscript(events)
  assert.deepEqual(messages.map(message => message.role), ['user', 'assistant'])
  assert.match(messages[1].text, /bash/)
  assert.doesNotMatch(JSON.stringify(messages), /secret output|hidden/)
  assert.equal(deriveTitle(messages), 'hello')
})

test('sanitizeShare bounds length and rejects mismatched origins', () => {
  const large = sanitizeShare({
    sessionId: 'session-large',
    messages: Array.from({ length: 300 }, () => ({ role: 'user', text: 'x'.repeat(8000) })),
  }, { id: ALPHA, name: 'Alpha' })
  assert.ok(large.messages.length > 0)
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= MAX_SHARE_BYTES)
  assert.throws(() => sanitizeShare({ sessionId: 'bad id!', messages: [] }, { id: ALPHA }), LocalShareError)
  assert.throws(() => sanitizeShare({ sessionId: 's', originId: BETA, messages: [] }, { id: ALPHA }), LocalShareError)
})

test('identity survives reload and respects an explicit name', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'localshare-identity-'))
  try {
    const first = await loadIdentity({ stateDir: directory, name: 'My Laptop' })
    const second = await loadIdentity({ stateDir: directory, name: 'My Laptop' })
    assert.equal(first.identity.id, second.identity.id)
    assert.equal(second.identity.name, 'My Laptop')
    assert.equal(first.warning, null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('explicit discovery is mutual and shares travel both ways', async (t) => {
  const alpha = await startNode(ALPHA, 'Alpha')
  const beta = await startNode(BETA, 'Beta')
  t.after(async () => {
    await alpha.node.stop()
    await beta.node.stop()
  })

  const view = await alpha.node.addPeer(`127.0.0.1:${beta.port}`)
  assert.equal(view.id, BETA)
  assert.equal(view.online, true)
  assert.equal(alpha.node.peers.size, 1)
  assert.equal(beta.node.peers.size, 1)
  const betaView = beta.node.peerView(beta.node.peers.get(ALPHA))
  assert.equal(betaView.id, ALPHA)
  assert.equal(betaView.direction, 'inbound')
  assert.equal(betaView.online, true)

  await alpha.node.publishShare({
    sessionId: 'session-1',
    title: 'Greeting',
    messages: [{ role: 'user', text: '你好' }],
  })
  assert.equal(beta.node.listShares().incoming.length, 1)
  assert.equal(beta.node.listShares().incoming[0].title, 'Greeting')

  await alpha.node.publishShare({
    sessionId: 'session-1',
    title: 'Greeting v2',
    messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: 'hello' }],
  })
  const incoming = beta.node.listShares().incoming
  assert.equal(incoming.length, 1)
  assert.equal(incoming[0].title, 'Greeting v2')
  assert.equal(incoming[0].messages.length, 2)

  await beta.node.publishShare({
    sessionId: 'session-2',
    title: 'Reply',
    messages: [{ role: 'assistant', text: 'hi' }],
  })
  assert.equal(alpha.node.listShares().incoming.length, 1)
  assert.equal(alpha.node.listShares().incoming[0].peerId, BETA)

  await alpha.node.retractShare('session-1')
  assert.equal(beta.node.listShares().incoming.length, 0)

  await alpha.node.removePeer(BETA)
  assert.equal(alpha.node.peers.size, 0)
  assert.equal(beta.node.peers.size, 0)
})

test('the heartbeat pull covers one-way reachability', async (t) => {
  const alpha = await startNode(ALPHA, 'Alpha')
  const beta = await startNode(BETA, 'Beta')
  t.after(async () => {
    await alpha.node.stop()
    await beta.node.stop()
  })
  await alpha.node.addPeer(`127.0.0.1:${beta.port}`)

  // Beta can no longer dial Alpha, but Alpha can still reach Beta.
  const alphaAtBeta = beta.node.peers.get(ALPHA)
  alphaAtBeta.endpoint = 'http://127.0.0.1:1'
  await beta.node.publishShare({
    sessionId: 'session-pull',
    title: 'Pulled',
    messages: [{ role: 'user', text: 'one way' }],
  })
  assert.equal(alpha.node.listShares().incoming.length, 0)
  await alpha.node.probePeer(BETA)
  const incoming = alpha.node.listShares().incoming
  assert.equal(incoming.length, 1)
  assert.equal(incoming[0].title, 'Pulled')
})

test('a pull reconciles a share retracted while the sender was unreachable', async (t) => {
  const alpha = await startNode(ALPHA, 'Alpha')
  const beta = await startNode(BETA, 'Beta')
  t.after(async () => {
    await alpha.node.stop()
    await beta.node.stop()
  })
  await alpha.node.addPeer(`127.0.0.1:${beta.port}`)
  await alpha.node.publishShare({
    sessionId: 'session-stale',
    title: 'Stale',
    messages: [{ role: 'user', text: 'remove me' }],
  })
  assert.equal(beta.node.listShares().incoming.length, 1)

  // Alpha can no longer push to Beta, so the retract never reaches it.
  alpha.node.peers.get(BETA).endpoint = 'http://127.0.0.1:1'
  await alpha.node.retractShare('session-stale')
  assert.equal(beta.node.listShares().incoming.length, 1)

  // Beta still reaches Alpha; its next pull sees an empty authoritative set.
  await beta.node.probePeer(ALPHA)
  assert.equal(beta.node.listShares().incoming.length, 0)
})

test('a configured secret gates the peer wire', async (t) => {
  const alpha = await startNode(ALPHA, 'Alpha')
  const beta = await startNode(BETA, 'Beta', { secret: 'shared-secret' })
  t.after(async () => {
    await alpha.node.stop()
    await beta.node.stop()
  })
  await assert.rejects(
    () => alpha.node.addPeer(`127.0.0.1:${beta.port}`),
    (error) => error instanceof LocalShareError && error.code === 'auth/secret',
  )
  assert.equal(alpha.node.peers.size, 0)

  const alphaSecret = await startNode(ALPHA, 'Alpha', { secret: 'shared-secret' })
  t.after(async () => { await alphaSecret.node.stop() })
  const peer = await alphaSecret.node.addPeer(`127.0.0.1:${beta.port}`)
  assert.equal(peer.id, BETA)
  assert.equal(beta.node.peers.size, 1)
})

test('listShareableSessions hides subagent sessions and reads titles', async () => {
  const fake = {
    async listSessions() {
      return [
        { header: { id: 'session-1', createdAt: 10, cwd: '/work' }, live: true, persisted: true },
        { header: { id: 'session-sub', createdAt: 20, origin: 'subagent' }, live: true, persisted: true },
      ]
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({
        sessionId: id,
        status: 'fulfilled',
        value: { title: { title: 'Named conversation' } },
      }))
    },
  }
  const sessions = await listShareableSessions(fake)
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, 'session-1')
  assert.equal(sessions[0].title, 'Named conversation')
})
