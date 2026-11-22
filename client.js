/** LocalShare browser half: the settings page for peers and read-only shares. */
window.__ModuleLoader__.load({
  id: '@local/localshare',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'localshare'
    const API = '/api/localshare'

    const en = {
      nav: 'LocalShare',
      title: 'LocalShare peers',
      intro: 'Discover another machine running DeepSeek Harness by entering its address, then choose a conversation to share read-only. Phase 1 supports explicit addresses only.',
      loading: 'Reading node status...',
      selfTitle: 'This machine',
      nodeId: 'Node ID',
      nodeName: 'Name',
      hostname: 'Hostname',
      addresses: 'Reachable addresses',
      advertise: 'Advertised address',
      listening: 'Listening',
      stopped: 'Not listening',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed; select the text manually',
      open: 'View',
      noAddresses: 'No non-loopback IPv4 address was found. Check the network interface or set advertise in the plugin config.',
      secretOn: 'A shared secret is configured for the peer port.',
      secretOff: 'No shared secret is configured: any host that can reach this port may handshake. Set secret in the plugin config on both machines to restrict it.',
      peersTitle: 'Peers',
      addPeerTitle: 'Add a peer',
      addPeerHint: 'After connecting, both machines list each other. You do not need to add this machine on the other side.',
      address: 'Address',
      addressPlaceholder: 'e.g. 192.168.1.23:17817',
      add: 'Connect',
      connecting: 'Connecting...',
      refresh: 'Refresh',
      peerEmpty: 'No peers yet. Enter the other machine\'s address to handshake.',
      online: 'online',
      offline: 'offline',
      remove: 'Remove',
      peerAdded: 'Peer connected; both sides now see each other.',
      peerRemoved: 'Peer removed.',
      directionMutual: 'mutual',
      directionOutbound: 'added here',
      directionInbound: 'found by peer',
      sessionsTitle: 'Choose a conversation to share',
      sessionsIntro: 'Sharing is a read-only snapshot: visible user and assistant text updates automatically. Tool output, reasoning, system prompts, and tool arguments stay on this machine.',
      loadingSessions: 'Reading conversations...',
      noSessions: 'No ordinary conversation is available to share.',
      share: 'Share',
      unshare: 'Stop sharing',
      sharedBadge: 'Shared',
      sessionLive: 'live',
      shareStarted: 'Conversation shared.',
      shareStopped: 'Conversation no longer shared.',
      incomingTitle: 'Received shares',
      incomingEmpty: 'No conversation has been received from another peer yet.',
      from: 'from',
      messages: 'messages',
      updatedAt: 'updated',
      receivedAt: 'received',
      close: 'Close',
      noMessages: 'This share has no visible text messages.',
      roleUser: 'You',
      roleAssistant: 'Assistant',
      roleTool: 'Tool',
      roleSystem: 'System',
      actionFailed: 'Action failed',
      phaseNote: 'Phase 1: manual discovery. Automatic multi-subnet discovery (mDNS, broadcast, relay) is not enabled yet.',
    }

    const zh = {
      nav: 'LocalShare',
      title: 'LocalShare 节点共享',
      intro: '输入另一台运行 DeepSeek Harness 的机器地址即可发现对方，并选择只读共享的对话。阶段 1 仅支持手动输入地址。',
      loading: '正在读取节点状态…',
      selfTitle: '本机',
      nodeId: '节点 ID',
      nodeName: '名称',
      hostname: '主机名',
      addresses: '可用地址',
      advertise: '对外地址',
      listening: '监听中',
      stopped: '未监听',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请手动选择文本',
      open: '查看',
      noAddresses: '没有找到非回环 IPv4 地址。请检查网络接口，或在插件配置中设置 advertise。',
      secretOn: '节点端口已启用共享密钥。',
      secretOff: '未设置共享密钥：任何能访问该端口的主机都可以握手。建议在两台机器的插件配置中设置相同的 secret。',
      peersTitle: '节点',
      addPeerTitle: '添加节点',
      addPeerHint: '连接后双方会互相出现在节点列表中，无需在另一台机器重复添加。',
      address: '地址',
      addressPlaceholder: '例如 192.168.1.23:17817',
      add: '连接',
      connecting: '连接中…',
      refresh: '刷新',
      peerEmpty: '还没有节点。输入另一台机器的地址进行握手。',
      online: '在线',
      offline: '离线',
      remove: '移除',
      peerAdded: '节点已连接，双方现在都能看到对方。',
      peerRemoved: '节点已移除。',
      directionMutual: '双向',
      directionOutbound: '本机发起',
      directionInbound: '对方发起',
      sessionsTitle: '选择要共享的对话',
      sessionsIntro: '共享是只读快照：可见的用户与助手文本会自动更新。工具输出、推理内容、系统提示和工具参数不会离开本机。',
      loadingSessions: '正在读取会话…',
      noSessions: '没有可共享的普通会话。',
      share: '共享',
      unshare: '停止共享',
      sharedBadge: '共享中',
      sessionLive: '活跃',
      shareStarted: '对话已开始共享。',
      shareStopped: '对话已停止共享。',
      incomingTitle: '收到的共享',
      incomingEmpty: '尚未收到其他节点的共享对话。',
      from: '来自',
      messages: '条消息',
      updatedAt: '更新于',
      receivedAt: '收到于',
      close: '收起',
      noMessages: '这个共享没有可显示的文本消息。',
      roleUser: '你',
      roleAssistant: '助手',
      roleTool: '工具',
      roleSystem: '系统',
      actionFailed: '操作失败',
      phaseNote: '阶段 1：手动发现。自动多网段发现（mDNS、广播、中继）尚未启用。',
    }

    /**
     * @param {number} timestamp
     * @returns {string}
     */
    function formatTime(timestamp) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
    }

    /**
     * @param {string} path
     * @param {RequestInit} [options]
     * @returns {Promise<any>}
     */
    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        cache: 'no-store',
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data?.ok === false) {
        const error = new Error(data?.error?.message ?? `HTTP ${response.status}`)
        error.code = data?.error?.code
        throw error
      }
      return data
    }

    /**
     * @param {string} text
     * @returns {Promise<void>}
     */
    async function copyText(text) {
      if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(text)
          return
        } catch {
          // The served page may be an insecure context; fall back to a selection copy.
        }
      }
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      document.body.append(area)
      area.select()
      const copied = document.execCommand('copy')
      area.remove()
      if (!copied) throw new Error('copy failed')
    }

    /**
     * @param {string} role
     * @param {(key: string) => string} tr
     * @returns {string}
     */
    function roleLabel(role, tr) {
      if (role === 'user') return tr('roleUser')
      if (role === 'assistant') return tr('roleAssistant')
      if (role === 'tool') return tr('roleTool')
      return tr('roleSystem')
    }

    /**
     * @param {{ t?: (key: string) => string }} props
     * @returns {any}
     */
    function LocalShareSection(props) {
      const tr = typeof props.t === 'function' ? props.t : key => key
      const [status, setStatus] = React.useState(null)
      const [statusError, setStatusError] = React.useState(null)
      const [sessions, setSessions] = React.useState(null)
      const [sessionsError, setSessionsError] = React.useState(null)
      const [shares, setShares] = React.useState({ outgoing: [], incoming: [] })
      const [selectedShareKey, setSelectedShareKey] = React.useState(null)
      const [address, setAddress] = React.useState('')
      const [busy, setBusy] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const aliveRef = React.useRef(true)
      const revisionRef = React.useRef(-1)
      const startedRef = React.useRef(0)
      const pollingRef = React.useRef(false)

      const loadStatus = React.useCallback(async () => {
        if (pollingRef.current) return
        pollingRef.current = true
        try {
          const data = await api('/status')
          if (!aliveRef.current) return
          setStatus(data)
          setStatusError(null)
          if (data.startedAt !== startedRef.current) {
            // A Host restart resets the share revision; reload the share bodies
            // even when the numeric revision happens to match again.
            startedRef.current = data.startedAt
            revisionRef.current = -1
          }
          if (data.shares.revision !== revisionRef.current) {
            revisionRef.current = data.shares.revision
            const next = await api('/shares')
            if (aliveRef.current) {
              setShares({ outgoing: next.outgoing ?? [], incoming: next.incoming ?? [] })
            }
          }
        } catch (error) {
          if (aliveRef.current) setStatusError(error instanceof Error ? error.message : String(error))
        } finally {
          pollingRef.current = false
        }
      }, [])

      const loadSessions = React.useCallback(async () => {
        try {
          const data = await api('/sessions')
          if (!aliveRef.current) return
          setSessions(data.sessions ?? [])
          setSessionsError(null)
        } catch (error) {
          if (aliveRef.current) setSessionsError(error instanceof Error ? error.message : String(error))
        }
      }, [])

      React.useEffect(() => {
        aliveRef.current = true
        void loadStatus()
        void loadSessions()
        const timer = setInterval(() => { void loadStatus() }, 4000)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
        }
      }, [loadStatus, loadSessions])

      const run = async (key, operation, successText) => {
        setBusy(key)
        setNotice(null)
        try {
          await operation()
          if (successText !== undefined) setNotice({ kind: 'ok', text: successText })
          await loadStatus()
          await loadSessions()
        } catch (error) {
          setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
        } finally {
          setBusy(null)
        }
      }

      const copy = async (value) => {
        try {
          await copyText(value)
          setNotice({ kind: 'ok', text: tr('copied') })
        } catch {
          setNotice({ kind: 'error', text: tr('copyFailed') })
        }
      }

      const addPeer = (event) => {
        event.preventDefault()
        const value = address.trim()
        if (value === '') return
        void run('add-peer', async () => {
          await api('/peers', { method: 'POST', body: JSON.stringify({ address: value }) })
          setAddress('')
        }, tr('peerAdded'))
      }

      const removePeer = (peer) => {
        void run(`remove:${peer.id}`, async () => {
          await api('/peers', { method: 'DELETE', body: JSON.stringify({ id: peer.id }) })
        }, tr('peerRemoved'))
      }

      const shareSession = (session) => {
        void run(`share:${session.id}`, async () => {
          await api('/share', { method: 'POST', body: JSON.stringify({ sessionId: session.id }) })
        }, tr('shareStarted'))
      }

      const unshareSession = (session) => {
        void run(`unshare:${session.id}`, async () => {
          await api('/share', { method: 'DELETE', body: JSON.stringify({ sessionId: session.id }) })
        }, tr('shareStopped'))
      }

      const refresh = () => {
        void run('refresh', async () => {})
      }

      const self = status?.self
      const config = status?.config
      const peers = status?.peers ?? []
      const selected = selectedShareKey === null
        ? undefined
        : shares.incoming.find(item => item.key === selectedShareKey)

      const copyButton = (value, label) => h('button', {
        type: 'button',
        className: 'ls-button ls-button-small',
        onClick: () => { void copy(value) },
        'aria-label': `${tr('copy')} ${label}`,
      }, tr('copy'))

      return h('section', { className: 'ls-root' },
        h('style', null, CSS),
        h('h2', { className: 'ls-title' }, tr('title')),
        h('p', { className: 'ls-intro' }, tr('intro')),
        notice === null ? null : h('div', {
          className: notice.kind === 'error' ? 'ls-alert ls-alert-error' : 'ls-alert',
          role: 'status',
        }, notice.text),
        statusError === null ? null : h('div', { className: 'ls-alert ls-alert-error', role: 'alert' }, statusError),

        h('section', { className: 'ls-card' },
          h('div', { className: 'ls-card-head' },
            h('h3', { className: 'ls-card-title' }, tr('selfTitle')),
            status === null ? null : h('span', {
              className: status.running ? 'ls-badge ls-badge-ok' : 'ls-badge ls-badge-error',
            }, status.running ? tr('listening') : tr('stopped')),
          ),
          status === null
            ? h('p', { className: 'ls-muted' }, tr('loading'))
            : h(React.Fragment, null,
              status.error === null ? null : h('p', { className: 'ls-error', role: 'alert' }, status.error.message),
              status.warning === null || status.warning === undefined ? null : h('p', { className: 'ls-warn' }, status.warning),
              h('div', { className: 'ls-kv' },
                h('span', { className: 'ls-key' }, tr('nodeId')),
                h('span', { className: 'ls-value' },
                  h('code', { className: 'ls-code' }, self.id),
                  copyButton(self.id, tr('nodeId')),
                ),
              ),
              h('div', { className: 'ls-kv' },
                h('span', { className: 'ls-key' }, tr('nodeName')),
                h('span', { className: 'ls-value' }, self.name),
              ),
              h('div', { className: 'ls-kv' },
                h('span', { className: 'ls-key' }, tr('hostname')),
                h('span', { className: 'ls-value' }, self.hostname || '—'),
              ),
              h('div', { className: 'ls-kv' },
                h('span', { className: 'ls-key' }, tr('addresses')),
                h('div', { className: 'ls-value ls-stack' },
                  Array.isArray(self.addresses) && self.addresses.length > 0
                    ? self.addresses.map(ip => h('div', { className: 'ls-address-row', key: ip },
                      h('code', { className: 'ls-code' }, `${ip}:${self.port}`),
                      copyButton(`${ip}:${self.port}`, ip),
                    ))
                    : h('span', { className: 'ls-muted' }, tr('noAddresses')),
                ),
              ),
              typeof self.endpoint === 'string' && self.endpoint !== '' ? h('div', { className: 'ls-kv' },
                h('span', { className: 'ls-key' }, tr('advertise')),
                h('span', { className: 'ls-value' },
                  h('code', { className: 'ls-code' }, self.endpoint),
                  copyButton(self.endpoint, tr('advertise')),
                ),
              ) : null,
              h('p', { className: config?.secretRequired ? 'ls-muted' : 'ls-warn' },
                config?.secretRequired ? tr('secretOn') : tr('secretOff')),
            ),
        ),

        h('section', { className: 'ls-card' },
          h('h3', { className: 'ls-card-title' }, tr('addPeerTitle')),
          h('p', { className: 'ls-muted' }, tr('addPeerHint')),
          h('form', { className: 'ls-form', onSubmit: addPeer },
            h('input', {
              className: 'ls-input',
              value: address,
              onChange: event => { setAddress(event.target.value) },
              placeholder: tr('addressPlaceholder'),
              'aria-label': tr('address'),
              disabled: busy === 'add-peer',
              autoComplete: 'off',
              spellCheck: false,
            }),
            h('button', {
              className: 'ls-button ls-button-primary',
              type: 'submit',
              disabled: busy === 'add-peer' || address.trim() === '',
            }, busy === 'add-peer' ? tr('connecting') : tr('add')),
          ),
        ),

        h('section', { className: 'ls-card' },
          h('div', { className: 'ls-card-head' },
            h('h3', { className: 'ls-card-title' }, `${tr('peersTitle')} (${peers.length})`),
            h('button', {
              className: 'ls-button',
              type: 'button',
              disabled: busy === 'refresh',
              onClick: refresh,
            }, tr('refresh')),
          ),
          peers.length === 0
            ? h('p', { className: 'ls-muted' }, tr('peerEmpty'))
            : h('div', { className: 'ls-list' }, peers.map(peer => h('div', { className: 'ls-peer', key: peer.id },
              h('span', {
                className: peer.online ? 'ls-dot ls-dot-online' : 'ls-dot ls-dot-offline',
                'aria-hidden': true,
              }),
              h('div', { className: 'ls-peer-body' },
                h('div', { className: 'ls-peer-name' },
                  peer.name,
                  h('span', { className: 'ls-badge' }, peer.direction === 'mutual'
                    ? tr('directionMutual')
                    : peer.direction === 'outbound' ? tr('directionOutbound') : tr('directionInbound')),
                ),
                h('code', { className: 'ls-code' }, peer.address),
                h('div', { className: 'ls-muted' },
                  `${peer.id} · ${peer.online ? tr('online') : tr('offline')}`
                  + (Number.isFinite(peer.latencyMs) ? ` · ${peer.latencyMs}ms` : '')
                  + (peer.error ? ` · ${peer.error}` : ''),
                ),
              ),
              h('button', {
                className: 'ls-button',
                type: 'button',
                disabled: busy === `remove:${peer.id}`,
                onClick: () => { removePeer(peer) },
              }, tr('remove')),
            ))),
        ),

        h('section', { className: 'ls-card' },
          h('div', { className: 'ls-card-head' },
            h('h3', { className: 'ls-card-title' }, tr('sessionsTitle')),
            h('button', {
              className: 'ls-button',
              type: 'button',
              disabled: busy === 'refresh',
              onClick: refresh,
            }, tr('refresh')),
          ),
          h('p', { className: 'ls-muted' }, tr('sessionsIntro')),
          sessionsError === null ? null : h('p', { className: 'ls-error', role: 'alert' }, sessionsError),
          sessions === null
            ? h('p', { className: 'ls-muted' }, tr('loadingSessions'))
            : sessions.length === 0
              ? h('p', { className: 'ls-muted' }, tr('noSessions'))
              : h('div', { className: 'ls-list' }, sessions.map(session => h('div', { className: 'ls-session', key: session.id },
                h('div', { className: 'ls-session-body' },
                  h('div', { className: 'ls-session-title' },
                    session.title,
                    session.shared ? h('span', { className: 'ls-badge ls-badge-ok' }, tr('sharedBadge')) : null,
                    session.live ? h('span', { className: 'ls-badge' }, tr('sessionLive')) : null,
                  ),
                  h('div', { className: 'ls-muted' },
                    `${session.id} · ${formatTime(session.createdAt)}${session.cwd ? ` · ${session.cwd}` : ''}`,
                  ),
                ),
                h('button', {
                  className: session.shared ? 'ls-button' : 'ls-button ls-button-primary',
                  type: 'button',
                  disabled: busy === `share:${session.id}` || busy === `unshare:${session.id}`,
                  onClick: () => { session.shared ? unshareSession(session) : shareSession(session) },
                }, session.shared ? tr('unshare') : tr('share')),
              ))),
        ),

        h('section', { className: 'ls-card' },
          h('div', { className: 'ls-card-head' },
            h('h3', { className: 'ls-card-title' }, `${tr('incomingTitle')} (${shares.incoming.length})`),
          ),
          shares.incoming.length === 0
            ? h('p', { className: 'ls-muted' }, tr('incomingEmpty'))
            : h('div', { className: 'ls-list' }, shares.incoming.map(item => h('div', { key: item.key, className: 'ls-share' },
              h('button', {
                className: 'ls-share-row',
                type: 'button',
                'aria-expanded': selectedShareKey === item.key,
                onClick: () => { setSelectedShareKey(selectedShareKey === item.key ? null : item.key) },
              },
              h('span', { className: 'ls-share-main' },
                h('span', { className: 'ls-share-title' }, item.title),
                h('span', { className: 'ls-muted' },
                  `${tr('from')} ${item.originName} · ${item.messageCount} ${tr('messages')} · ${tr('updatedAt')} ${formatTime(item.updatedAt)}`,
                ),
              ),
              h('span', { className: 'ls-button' }, tr('open')),
              ),
              selected !== undefined && selected.key === item.key
                ? h('div', { className: 'ls-transcript' },
                  h('div', { className: 'ls-transcript-head' },
                    h('strong', null, item.title),
                    h('button', {
                      className: 'ls-button',
                      type: 'button',
                      onClick: () => { setSelectedShareKey(null) },
                    }, tr('close')),
                  ),
                  h('p', { className: 'ls-muted' },
                    `${tr('from')} ${item.originName} (${item.peerId}) · ${tr('receivedAt')} ${formatTime(item.receivedAt)}`,
                  ),
                  Array.isArray(item.messages) && item.messages.length > 0
                    ? item.messages.map((message, index) => h('div', { className: 'ls-message', key: index },
                      h('div', { className: 'ls-role' }, roleLabel(message.role, tr)),
                      h('div', { className: 'ls-message-text' }, message.text),
                    ))
                    : h('p', { className: 'ls-muted' }, tr('noMessages')),
                )
                : null,
            ))),
        ),

        h('p', { className: 'ls-phase' }, tr('phaseNote')),
      )
    }

    const CSS = `
.ls-root { display:flex; flex-direction:column; gap:16px; max-width:760px; color:var(--dsw-alias-label-primary); font-size:14px; }
.ls-title { margin:0; font-size:18px; font-weight:600; }
.ls-intro { margin:0; font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.ls-card { display:flex; flex-direction:column; gap:12px; padding:16px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.ls-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ls-card-title { margin:0; font-size:15px; font-weight:600; }
.ls-muted { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; line-height:1.55; }
.ls-warn { margin:0; color:var(--dsw-alias-state-warn-primary); font-size:12px; line-height:1.55; }
.ls-error { margin:0; color:var(--dsw-alias-state-error-primary); font-size:12px; line-height:1.55; }
.ls-kv { display:flex; align-items:flex-start; gap:12px; }
.ls-key { flex:none; width:92px; padding-top:3px; color:var(--dsw-alias-label-secondary); font-size:12px; }
.ls-value { display:flex; flex:1; min-width:0; flex-wrap:wrap; align-items:center; gap:8px; }
.ls-stack { flex-direction:column; align-items:stretch; gap:6px; }
.ls-address-row { display:flex; align-items:center; gap:8px; }
.ls-code { padding:2px 6px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; line-height:1.5; word-break:break-all; }
.ls-button { padding:7px 10px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:6px; background:transparent; color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:1; white-space:nowrap; cursor:pointer; }
.ls-button:hover:not(:disabled) { border-color:var(--dsw-alias-brand-primary); }
.ls-button:disabled { opacity:.5; cursor:default; }
.ls-button-small { padding:4px 7px; font-size:11px; }
.ls-button-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
.ls-input { flex:1; min-width:0; padding:7px 9px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px; }
.ls-input:focus { outline:1px solid var(--dsw-alias-brand-primary); outline-offset:-1px; }
.ls-form { display:flex; gap:8px; }
.ls-badge { padding:3px 7px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:999px; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1; white-space:nowrap; }
.ls-badge-ok { border-color:var(--dsw-alias-state-success-primary); color:var(--dsw-alias-state-success-primary); }
.ls-badge-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.ls-list { display:flex; flex-direction:column; }
.ls-peer, .ls-session { display:flex; align-items:flex-start; gap:10px; padding:10px 0; border-top:0.5px solid var(--dsw-alias-border-l1); }
.ls-peer:first-child, .ls-session:first-child { padding-top:0; border-top:0; }
.ls-dot { flex:none; width:8px; height:8px; margin-top:6px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); }
.ls-dot-online { background:var(--dsw-alias-state-success-primary); }
.ls-dot-offline { background:var(--dsw-alias-state-idle-primary); }
.ls-peer-body, .ls-session-body { display:flex; flex:1; min-width:0; flex-direction:column; gap:4px; }
.ls-peer-name, .ls-session-title { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; font-weight:600; word-break:break-word; }
.ls-share { border-top:0.5px solid var(--dsw-alias-border-l1); }
.ls-share:first-child { border-top:0; }
.ls-share-row { display:flex; width:100%; align-items:center; gap:10px; padding:10px 0; border:0; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.ls-share-main { display:flex; flex:1; min-width:0; flex-direction:column; gap:4px; }
.ls-share-title { font-size:13px; font-weight:600; word-break:break-word; }
.ls-transcript { display:flex; flex-direction:column; gap:10px; max-height:420px; margin-bottom:12px; padding:12px; overflow:auto; border:0.5px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-2); }
.ls-transcript-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ls-message { display:flex; flex-direction:column; gap:4px; }
.ls-message + .ls-message { padding-top:8px; border-top:0.5px solid var(--dsw-alias-border-l1); }
.ls-role { color:var(--dsw-alias-label-secondary); font-size:11px; font-weight:600; }
.ls-message-text { white-space:pre-wrap; word-break:break-word; font-size:13px; line-height:1.55; }
.ls-alert { padding:8px 10px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:6px; background:var(--dsw-alias-bg-layer-2); font-size:12px; line-height:1.5; }
.ls-alert-error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }
.ls-phase { margin:0; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'localshare: dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'localshare',
          order: 35,
          label: () => ctx.locale.bind(NS)('nav'),
          locale: NS,
        }, LocalShareSection))
      },
    }
  },
})
