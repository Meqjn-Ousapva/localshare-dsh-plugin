# LocalShare（阶段 1）

在两台（或多台）运行 DeepSeek Harness 的机器之间，通过**显式地址**互相发现，并选择会话做**只读共享**。

阶段 1 只做手动发现：A 输入 B 的 `IP:端口`，A 验证 B 的 LocalShare 身份后把自己也介绍给 B，于是**双方互相出现在节点列表里**。不做广播、mDNS、中继或跨网段自动发现。

## 功能

- 显示本机稳定节点 ID、名称、主机名、可被访问的 IPv4 地址和监听端口。
- 手动添加节点，握手成功后双向可见，心跳检测在线/离线与延迟。
- 选择本机任意普通会话共享给所有已连接节点；会话更新自动同步。
- 接收对方共享的会话，并在设置页中阅读只读转录。
- Agent 工具 `localshare` 提供同一组操作（status / add_peer / share_session 等）。
- 可选的共享密钥（`secret`），保护节点端口。

## 安装

在 DSH 中使用插件管理器安装本目录（绝对路径）：

```text
plugin_manager action=install_bundle target=/home/meqjn/my-project/localshare-dsh-plugin
```

安装后打开 **Settings → LocalShare**。如果页面没有立即出现，刷新一次 Web 页面。

## 配置

`cordis.patch.yml` 默认写入：

```yaml
- id: localshare
  name: '@local/localshare'
  config:
    port: 17817
    bind: 0.0.0.0
```

安装后可在 profile 的 patch 中覆盖 `config`。常用字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `17817` | 节点 HTTP 端口；两端不要求相同。 |
| `bind` | `0.0.0.0` | 监听地址；只想本机测试时用 `127.0.0.1`。 |
| `name` | 主机名 | 显示给对方的名字。 |
| `advertise` | 空 | 本机对外地址，例如 `http://203.0.113.7:17817`。用于 NAT/端口转发场景。 |
| `secret` | 空 | 共享密钥。两端必须相同；为空表示任何能访问端口的主机都可握手。 |
| `heartbeatMs` | `15000` | 心跳/拉取间隔；`0` 关闭。 |
| `requestTimeoutMs` | `4000` | 节点请求超时。 |
| `maxPeers` | `64` | 节点上限。 |
| `stateDir` | `$DSH_HOME` | 放置 `localshare/identity.json` 的目录。 |
| `id` | 自动 | 覆盖节点 ID（一般不需要）。 |

建议在两台机器上都设置：

```yaml
config:
  secret: '换成你们自己的长随机串'
```

## 使用

1. 两台机器都安装并启用 LocalShare。
2. 在 A 的 **Settings → LocalShare** 中，把 B 的地址（例如 `192.168.1.23:17817`）填入“添加节点”，点击“连接”。
3. 握手成功后，A 和 B 的节点列表都会出现对方，状态变为在线。
4. 在“选择要共享的对话”里点某个会话的“共享”。
5. 对方在“收到的共享”中展开阅读；后续对话更新会自动同步。

### 网络场景

- **同一局域网**：直接使用 B 的局域网 IPv4 地址。
- **虚拟机 NAT**：把宿主/虚拟机的转发端口映射到 LocalShare 端口，填写映射后的地址；必要时设置 `advertise`。
- **iptables 转发**：填写转发后的可达地址；两端端口可以不同。
- **单向可达**：即使 B 无法反向连接 A，B 共享的内容仍会在 A 的心跳中被 A 主动拉取；A 推送给 B 也仍然可用。

## 协议（阶段 1）

所有节点接口位于 `http://<host>:<port>/localshare/v1`，JSON，可选 `x-localshare-secret` 头。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/hello` | 返回协议版本、节点 ID、名称、端口、地址、共享版本号。 |
| `POST` | `/peers` | 对端登记：提交自己的 `hello` 和当前共享，返回本机 `hello` 与共享。 |
| `DELETE` | `/peers?peerId=` | 对端移除通知。 |
| `GET` | `/shares` | 拉取本机所有对外共享（用于反向心跳同步）。 |
| `POST` | `/shares` | 推送/更新一份共享。 |
| `DELETE` | `/shares?sessionId=&originId=` | 撤回一份共享。 |

Web 页面通过 Harness 认证的 `"/api/localshare/*"` 路由访问 Host 侧操作，并读取完整转录；节点端口只服务 LocalShare 协议。Agent 工具的 `list_shares` 只返回元数据，避免把整段转录塞进模型上下文。

## 隐私边界

共享只导出**用户亲手编写的消息**（`UserMessage.source.kind === 'user'`）与**助手的可见文本**，以及助手调用的工具名称。以下内容不离开本机：

- 系统提示、开发者消息、推理内容。
- Harness 注入的 runtime context、技能目录、时间快照、子代理通知等非用户消息。
- 工具参数与工具输出。
- 附件原文件与图片字节。
- 工作目录路径不会出现在转录里（会话列表只在本机显示）。

单份共享上限约 768KB；超出时从最早的消息开始截断，只保留最近的部分。节点握手与同步请求上限 1MB。

节点列表、共享关系和收到的共享目前都只保存在进程内存中，插件重启后清空；本机身份（节点 ID）会持久化。这是阶段 1 的有意取舍，后续可接入 Harness 的 durable storage。

## 安全说明

- 节点端口是普通 HTTP，不含 TLS。适合可信局域网、VPN 或 SSH 隧道；不要在公网裸奔。
- `secret` 通过请求头明文传输，只提供“能否握手”的门槛，不提供传输加密。
- 未设置 `secret` 时，任何能访问端口的主机都能登记为节点并读取当前共享。请按需设置密钥或用防火墙限制端口。
- 共享是只读的；对端不能写回本机会话。

## 开发与测试

```bash
cd /home/meqjn/my-project/localshare-dsh-plugin
node --check index.js
node --check client.js
node --test test/*.test.js
```

测试覆盖地址解析、双向握手、共享推送/撤回、单向可达时的拉取、共享密钥、身份持久化和转录过滤。

## 阶段 2（未实现）

自动、多层级网络发现尚未实现。后续可评估：

- 局域网 mDNS/DNS-SD 或 CoAP 广播（类似 OpenHarmony SoftBus）作为同网段自动发现。
- 一台已知节点作为 rendezvous/中继，交换候选地址。
- NAT 穿透（STUN/TURN、打洞）与跨网段候选地址交换。
- 发现范围、TTL、速率限制与网络风暴防护。

阶段 1 的协议已经把这些能力留成独立层：发现只负责产生“可达地址 + 身份”，共享协议只依赖二者。
