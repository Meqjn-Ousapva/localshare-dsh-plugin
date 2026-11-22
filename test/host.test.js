/** Host-half wiring test with a minimal Cordis-shaped context. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'
import { LocalShareNode } from '../lib/protocol.js'

const BETA = 'ls-bbbbbbbbbbbbbbbb'

/**
 * @param {{ url: string, method?: string, body?: unknown }} options
 */
function fakeRequest({ url, method = 'GET', body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value },
    end(value) { this.body = value ?? '' },
  }
}

test('Host apply wires status, sessions, sharing, peers, and the agent tool', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'localshare-host-'))
  const disposers = []
  /** @type {any} */
  let route
  /** @type {any} */
  let tool
  const events = [
    { type: 'user/message', time: 10, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
    { type: 'user/message', time: 11, data: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'hidden runtime context' }] } },
    { type: 'assistant/message', time: 20, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } } },
  ]
  const sessionQuery = {
    async listSessions() {
      return [{ header: { id: 'session-1', createdAt: 1000, cwd: '/work' }, live: true, persisted: true }]
    },
    async readTitle() {
      return { title: 'Demo conversation', eventSeq: 1, updatedAt: 1000, source: { kind: 'user' } }
    },
    async readSession(id) {
      return { session: { id, createdAt: 1000 }, inheritedEventCount: 0, events }
    },
    async readTitleSnapshots(ids) {
      return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: 'Demo conversation' } } }))
    },
  }
  const ctx = {
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    on() {
      return () => {}
    },
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    sessionQuery,
  }

  const peer = new LocalShareNode({
    identity: { id: BETA, name: 'Beta', hostname: 'beta-host' },
    port: 0,
    bind: '127.0.0.1',
    heartbeatMs: 0,
    requestTimeoutMs: 1500,
  })
  const peerPort = await peer.start()
  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose()
      } catch {
        // Best-effort cleanup.
      }
    }
    await peer.stop()
    await rm(directory, { recursive: true, force: true })
  })

  await apply(ctx, {
    port: 0,
    bind: '127.0.0.1',
    heartbeatMs: 0,
    stateDir: directory,
  })
  assert.notEqual(route, undefined)
  assert.notEqual(tool, undefined)

  const callRoute = async (url, method = 'GET', body) => {
    const request = fakeRequest({ url, method, body })
    const response = fakeResponse()
    await route.handler(request, response)
    return { status: response.statusCode, json: response.body === '' ? null : JSON.parse(response.body) }
  }

  const status = await callRoute('/api/localshare/status')
  assert.equal(status.status, 200)
  assert.equal(status.json.ok, true)
  assert.equal(status.json.running, true)
  assert.match(status.json.self.id, /^ls-/)

  const sessions = await callRoute('/api/localshare/sessions')
  assert.equal(sessions.status, 200)
  assert.equal(sessions.json.sessions.length, 1)
  assert.equal(sessions.json.sessions[0].title, 'Demo conversation')

  const shared = await tool.execute({ action: 'share_session', sessionId: 'session-1' })
  assert.equal(shared.ok, true)
  assert.equal(shared.share.messageCount, 2)
  assert.equal(shared.share.title, 'Demo conversation')

  const outgoing = await callRoute('/api/localshare/shares')
  assert.equal(outgoing.json.outgoing.length, 1)
  assert.equal(outgoing.json.outgoing[0].messages[0].text, 'hello')
  assert.equal(outgoing.json.outgoing[0].messages[1].text, 'hi there')
  assert.doesNotMatch(JSON.stringify(outgoing.json), /hidden runtime context/)

  const metadata = await tool.execute({ action: 'list_shares' })
  assert.equal(metadata.outgoing.length, 1)
  assert.equal(metadata.outgoing[0].title, 'Demo conversation')
  assert.equal(metadata.outgoing[0].messages, undefined)

  const added = await tool.execute({ action: 'add_peer', address: `127.0.0.1:${peerPort}` })
  assert.equal(added.ok, true)
  assert.equal(added.peer.id, BETA)
  assert.equal(peer.peers.size, 1)
  assert.equal(peer.listShares().incoming.length, 1)
  assert.equal(peer.listShares().incoming[0].title, 'Demo conversation')

  const listed = await tool.execute({ action: 'list_peers' })
  assert.equal(listed.peers.length, 1)
  assert.equal(listed.peers[0].online, true)

  const unshared = await tool.execute({ action: 'unshare_session', sessionId: 'session-1' })
  assert.equal(unshared.removed, true)
  assert.equal(peer.listShares().incoming.length, 0)

  const removed = await tool.execute({ action: 'remove_peer', peerId: BETA })
  assert.equal(removed.removed, true)
  assert.equal(peer.peers.size, 0)
})
