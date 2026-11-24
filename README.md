# LocalShare（阶段 1）

在两台（或多台）运行 DeepSeek Harness 的机器之间，通过**显式地址**互相发现，并选择会话做**只读共享**。

阶段 1 只做手动发现：A 输入 B 的 `IP:端口`，A 验证 B 的 LocalShare 身份后把自己也介绍给 B，于是**双方互相出现在节点列表里**。不做广播、mDNS、中继或跨网段自动发现。

## 功能

- 显示本机稳定节点 ID、名称、主机名、可被访问的 IPv4 地址和监听端口。
- 手动添加节点，握手成功后双向可见，心跳检测在线/离线与延迟。
- 选择本机任意普通会话共享给所有已连接节点；会话更新自动同步。
- 接收对方共享的会话，并在设置页中阅读只读转录。
- 把收到的共享**导入为一条新的本机会话**：选择本地工作目录，导入后可继续对话；不复制对方文件。
- Agent 工具 `localshare` 提供同一组操作（status / add_peer / share_session / import_share 等）。
- 可选的共享密钥（`secret`），保护节点端口。

## 安装

克隆仓库并进入 `package.json` 所在的目录：

```bash
git clone <仓库地址> localshare-dsh-plugin
cd localshare-dsh-plugin
pwd   # 记下这个绝对路径
```

然后在带 Web UI 的 DSH profile（通常是 `web`）中，用插件管理器安装**克隆目录的绝对路径**：

```text
plugin_manager action=install_bundle target=/absolute/path/to/localshare-dsh-plugin
```

- `target` 必须是 `package.json` 所在的目录，且建议使用绝对路径。
- 插件没有构建步骤，也没有 npm 运行时依赖；克隆后不需要先执行 `pnpm install`。
- 需要在带 Web UI 的 profile 中安装。Host 半依赖 `webServer` 和 `connection`，纯 CLI/无 Web 的 profile 不会激活它。
- 如果通过 Agent 执行，`install_bundle` 可能需要安装权限或审批；也可以让用户在 Plugin Manager 中选择本地目录安装。
- 安装后打开 **Settings → LocalShare**。如果页面没有立即出现，刷新一次 Web 页面。

更新已安装的克隆：

```bash
git pull
```

链接安装的 Host 代码需要重启 DSH（或在 Plugin Manager 中重新加载插件）才会换成新模块；浏览器端刷新页面即可加载新的 `client.js`。

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
6. 对方可以点“导入”，选择一个本机已有目录，并选择**权限预设**，生成一条新的本地会话；导入后可直接打开并继续对话。

导入只恢复**对话文本**，不会复制对方工作目录中的文件，也不包含原会话的工具调用/工具结果/推理过程；导入后可以继续对话，但模型看不到原来的工具过程。导入表单里的**权限预设**会写入会话的 `permission/preset`、`sandbox/mode`、`approval/policy` 事件；如果不想每次工具调用都点“给权限”，选择标记“不再询问”的预设（例如 `danger-full-access`）。这会放宽导入会话的工具权限，只对可信对话/工作区使用。

0.1.4 起，插件会探测当前主机是否能执行 `read-only` / `workspace-write`：没有可用 sandbox 后端时，这两类预设会被禁用，默认改用 `danger-full-access`，Host 也会在写入前拒绝不可用的预设。0.1.5 修复了没有人类用户消息的共享（assistant-only）的标题事件：这类导入会写成一个空引用列表的 user 标题，避免重启校验时被判为损坏并归档。0.1.6 起，导入写入后会立即通过持久化后端完整回读校验；如果日志不合法，导入会当场报错，而不是先显示、重启后才消失。若希望保留 confinement，需要安装可用的后端（Linux 的 bubblewrap 或 Landlock 内核、macOS 的 sandbox-exec、Windows 的 ACL restricted-token runner）。导入前会显示对方的原始工作目录，但它只作为参考，本机 cwd 由你选择。导入记录保存在 `~/.dsh/localshare/imports.json`，同一来源会话重复导入会直接打开已有会话。

导入成功后会把新会话挂到所选工作区；侧栏显示的是工作区的会话账本，仅写入持久化存储并不会自动出现在侧栏。0.1.1 起会在导入后调用 `Workspace.attachSession`，并在插件启动时自动修复旧版本已导入但未挂接的会话。

已经导入的旧会话如果仍在逐次询问，可在该会话的权限预设控件里切换一次（例如切到“不再询问”的预设），选择会写入会话日志并持久化；新导入则直接在导入表单里选。

0.1.3 起，插件启动时会校验已有导入记录的会话日志。旧版本写出的损坏日志（例如 step 从 0 开始）会被识别：对应会话从工作区移除并归档，导入记录清除，`importsWarning` 提示重新导入；随后该共享会重新显示“导入”按钮，用当前构建重新生成一条合法会话。

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

共享元数据可带可选的 `sourceCwd`（对方原始工作目录，仅展示，不直接作为本机路径）。导入走 Harness 认证的 `POST /api/localshare/import`，请求体为 `{peerId, sessionId, targetDir}`；`targetDir` 必须是本机已存在的绝对路径。Host 会创建新的持久化 Session、注册对应 Workspace，并把来源记录写入 `imports.json`。

Web 页面通过 Harness 认证的 `"/api/localshare/*"` 路由访问 Host 侧操作，并读取完整转录；节点端口只服务 LocalShare 协议。Agent 工具的 `list_shares` 只返回元数据，避免把整段转录塞进模型上下文；`import_share` 需要用户先指定一个已存在的本地目录，并可用 `list_permission_presets` 查询本机可选权限预设。

## 隐私边界

共享只导出**用户亲手编写的消息**（`UserMessage.source.kind === 'user'`）与**助手的可见文本**，以及助手调用的工具名称。以下内容不离开本机：

- 系统提示、开发者消息、推理内容。
- Harness 注入的 runtime context、技能目录、时间快照、子代理通知等非用户消息。
- 工具参数与工具输出。
- 附件原文件与图片字节。
- 工作目录路径不会出现在转录里（会话列表只在本机显示）。
- 导入只写入对话文本，不写入对方文件、不执行导入内容中的工具调用。

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

## 工作目录与文件同步（后续）

对话导入只做 cwd 映射，不做文件同步。后续可选方案：

- **Git 工作区恢复（推荐用于代码对话）**：共享 `remote + commit + subdir`，导入端 clone/fetch 到用户选的目录。
- **引用文件清单**：从工具调用/文本链接提取路径和哈希，只传清单，导入后显示缺失文件。
- **按需文件包**：只传用户勾选的引用文件，必须限制路径穿越、符号链接、密钥、体积和冲突，且不自动执行脚本。
- **完整工作区**：交给 Git/rsync 等外部工具，不在插件里自建双向同步。

## 阶段 2（未实现）

自动、多层级网络发现尚未实现。后续可评估：

- 局域网 mDNS/DNS-SD 或 CoAP 广播（类似 OpenHarmony SoftBus）作为同网段自动发现。
- 一台已知节点作为 rendezvous/中继，交换候选地址。
- NAT 穿透（STUN/TURN、打洞）与跨网段候选地址交换。
- 发现范围、TTL、速率限制与网络风暴防护。

阶段 1 的协议已经把这些能力留成独立层：发现只负责产生“可达地址 + 身份”，共享协议只依赖二者。
