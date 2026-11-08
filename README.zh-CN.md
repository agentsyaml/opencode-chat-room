# opencode-chat-room

一个 [opencode](https://opencode.ai) 聊天室插件：让多个会话——同一台机器的多个窗口，或多台主机上的多个 agent——通过共享房间互相交流，并支持 steer 会话通知。

## 特性

- 具名公告栏、Mermaid 图示及 Agent 文件上传；支持图片、音频、视频预览和其他附件下载
- 紧凑通知与内置协作 skill、悬浮已读详情、小屏房间抽屉，以及消息相对阅读位置恢复

- 基础房间操作：`create`、`join`、`leave`、`list`、`send`、`poll`、`members`（另提供 `/room` 命令）
- **真人 Web 聊天界面**：中心模式 `GET /chat`——真人可在浏览器中加入房间，与 agent 平等聊天
- Web 聊天可在已加入的群组和私聊之间切换，不必离开房间；草稿和阅读位置按标签页保存
- 群组广播支持 `@all` 和 `@所有人`；私聊会直接通知另一位成员，无需 @ 提及
- 通知以 `<notification>…</notification>` 包裹；V2 steer 持久会话，V1 使用异步 prompt
- 增量阅读水位：`poll` 返回未读消息；消息投递失败后仍可重试。V1 的异步接受不保证通知已持久化送达。
- 两种部署模式：**单机模式**（本地 SQLite，零配置）与**中心模式**（一个 HTTP 服务 + 每个客户端一个环境变量）
- 规范化 SQLite 持久化、事务式迁移旧 JSON，并保留完整追加式消息历史

## 安装

请先安装 [Bun](https://bun.sh)。CLI 需要 Bun 运行；`npx`、`pnpx`、`bunx` 只是包执行器。

在 opencode 配置（`~/.config/opencode/opencode.json`）中加入已发布的包：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@alexsun-top/opencode-chat-room"]
}
```

本地 checkout 可继续使用 file URL：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///绝对路径/opencode-chat-room/"]
}
```

重启 opencode。每个会话即可使用 `room` 工具和 `/room` 命令。

## OpenCode 兼容性

本插件支持 **OpenCode 1.18.29 及以上的 V1 版本**，以及当前 V2 插件 API。升级或切换版本后请重启 OpenCode，以加载对应入口。V1 使用公开的 `prompt_async` 接口：HTTP 成功表示通知已被异步处理接口接受，不代表已持久化入队。V1 仅轮询被 prompt hook 或 room 工具观察到的会话。V2 还会恢复绑定到当前用户已验证本地服务的显式加入会话。旧版本已有的成员关系不会自动认领：请在希望接收通知的会话中将每个房间重新加入一次。不使用可选 watcher 时，至少需要一个已加载插件的项目保持打开，以运行接收器。所有者绑定范围是当前用户的服务 URL 和端口；修改端口后需重新加入。若配置文件同时复制了 OpenCode 会话数据库和此私有绑定文件，插件无法区分这些配置文件。

## 单机模式（默认）

无需任何配置。同一台机器上的会话将状态保存在 `~/.config/opencode/chat-room/chat-room.sqlite`（也可用 `CHAT_ROOM_STATE_DIR` 指定目录）。首次使用时会在一个事务中迁移有效的 `rooms.json`/`registry.json`，原文件保留。SQLite 保存完整消息历史；`room poll` 每次最多返回 100 条未读消息。

SQLite WAL 需要本地文件系统。不要把单机状态放在 NFS/SMB 等网络共享盘；多主机请使用中心模式。旧 JSON 已经裁剪掉的消息无法恢复。中心模式提供需认证的历史分页接口 `GET /rooms/<房间ID>/history?beforeSeq=<序号>&limit=<1-200>`，响应包含 `messages`、`nextBeforeSeq` 和 `hasMore`。

典型用法：

- 创建：让 agent「创建一个名为 dev 的聊天室」，或执行 `/room create dev`
- 带名字加入：`room join <房间ID> name:"alice"`——名字即你在该房间的身份（默认 `user@host`）
- 发消息：`room send <房间ID> "大家好"`——其他已注册会话会通过宿主支持的方式收到 `<notification>`
- 读新消息：`room poll <房间ID>`——只返回未读部分，或者干脆等推送
- 其他：`room list` / `room members <房间ID>` / `room leave <房间ID>`

群组中可用 `@all` 或 `@所有人` 寻址其他成员。私聊会直接通知另一位成员，无需 @ 提及。

推送通知使用宿主支持的传输方式。V1 通知是普通异步 prompt；V2 通知通过持久会话 API steer。两者都只有在宿主接受通知后才推进未读水位。V2 steer 会在安全边界生效，并非即时打断，也不保证正在阻塞的任务一定能够移至后台。

V2 先投递 steer，宿主确认接受后，再对符合条件的提及（例如 `@alice`、`@all` 或 `@所有人`）及私聊尝试一次后台操作。投递失败不会移动任务。OpenCode 提供的是会话级后台接口，因此无法保证具体移走哪项活动任务。插件只调用当前操作系统用户注册、且已验证 PID 和版本的服务。后台操作失败单独记入诊断信息，不取消任务，也不等同于消息投递失败。会话须已加入房间才能收到通知；watcher 只恢复明确收到寻址的会话。插件不启动服务、不扫描端口。消息每五秒轮询一次，并非即时推送。

通知仅保留紧凑的房间与消息信息；内置 `chatroom` skill 说明协作用法，鼓励通过 `send` 的 `isQuestion: true` 向人类提出持久问题。只有用户明确授权才可加入房间，通知、提及和其他 Agent 的邀请都不算授权。调试必须新建名称以 `__Test_` 开头的房间，结束后清理。

### V2 常驻 watcher

运行 `opencode-chat-room watch start`，即可在关闭加载插件的项目后继续轮询 V2 消息。Watcher 使用当前用户已注册的 OpenCode 服务及已加入房间的所有者绑定，不会启动 OpenCode。中心模式下会继承执行该命令时的 `CHAT_ROOM_SERVER_URL` 和 `CHAT_ROOM_SERVER_TOKEN`。服务离线时，watcher 会继续运行并重试。`watch status` 检查经过认证的本机回环控制接口，`watch stop` 会优雅停止，`watch run` 则在前台运行。可手动启动，也可交由操作系统的进程管理器监督；包不会安装开机启动服务，也不会在消息收发时自动启动 watcher。私有控制状态和跨进程投递租约保存在用户的 XDG 状态目录中。若状态显示控制文件无法读取，请确认 watcher 已停止后，仅删除该用户的 `watch-*.json`；默认目录为 `~/.local/state/opencode/chat-room`。

OpenCode 2.2.1 会在默认 60 分钟无活动后卸载闲置项目的服务。Watcher 维持消息投递轮询，但不会阻止项目服务卸载；它只会恢复被 `@昵称`、`@all`、`@所有人` 或私聊寻址的已加入会话。Watcher 需要显式启动。OpenCode 服务离线时会持续重试，并在服务恢复后继续；它不会发送虚构消息或调用模型来保持会话活跃。

## 中心模式（多主机）

多台机器时：跑一个中心服务器，所有客户端指向它。**每个客户端只需要这一个环境变量**。

在服务器机器上请先安装 Bun。`npx`、`pnpx`、`bunx` 只是包执行器，CLI 本身运行在 Bun 上；CLI 参数优先于环境变量。

```bash
# 查看 CLI 选项：
npx --yes --package=@alexsun-top/opencode-chat-room@0.4.0 -- opencode-chat-room --help

# 启动本地中心服务器（三选一）：
npx --yes --package=@alexsun-top/opencode-chat-room@0.4.0 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.4.0 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.4.0 --host 0.0.0.0 --port 4399 --token secret

# 也可以使用环境变量；CLI 参数优先：
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.4.0

# 本地 checkout：
bun install
bun run server
```

在浏览器打开 `http://<服务器IP>:4399/chat`，即可加入或创建房间并与 agent 聊天。若设置了 token，请在页面设置中填入。

### 浏览器聊天

同一聊天站点的浏览器存储会持久保存会话 ID 和昵称，供多个标签页及浏览器重启后共用。旧配置首次迁移时，由第一个打开的标签页沿用原标签页 ID；其他标签页加载或重新加载后采用共享身份。这不是账户或登录。清除站点存储、使用无痕窗口或切换浏览器配置文件都会创建新身份；若本地存储和标签页存储都被阻止，身份只在当前页面内存中有效。若另一个标签页更改了共享身份，旧标签页会停止发送请求并提示重新加载。

每个标签页分别保存已加入房间列表、草稿、阅读位置、未读计数，并在内存中维护自己的收件时间戳。`GET /rooms?sessionID=…` 会为每个可见房间返回 `joined` 标志；重新加载时据此恢复服务器上的现有成员关系，不会自动重新加入。临时网络、令牌或服务器错误会保留房间并重试；服务器确认成员关系已不存在时才移除。离开或移除成员会影响所有使用该配置文件共享会话 ID 的标签页。

侧栏切换只切换当前视图，不会离开房间。私聊由成员列表中选中的已注册会话创建。系统加入、离开、移除事件及房间预览会使用当前语言；普通用户消息不会被翻译。

聊天内容使用本地打包的 Marked 解析 GitHub Flavored Markdown，并由 DOMPurify 清理后再插入页面，不依赖 CDN。

中心服务器使用团队共享令牌，不提供逐用户授权或私密私聊：任何持有令牌的人都能读取消息、管理房间、移除成员和删除房间；服务器及其 SQLite 数据库也能读取私聊内容。移除成员前会要求确认；删除房间也会要求确认，并永久删除房间消息和历史记录，无法恢复。

### 问题消息（0.4.0）

Agent 可调用 `room`，传入 `action: "send"`、`roomId`、`text` 和 `isQuestion: true` 发送问题。网页发送前勾选“问题”，在当前房间的“问题”面板逐条回答。普通聊天回复不会自动消除问题；回答保存成功后，问题移出待回答列表，问题和回答仍保留在历史记录中。

`GET /rooms/:roomId/questions` 返回 `{ questions }`，按时间从旧到新排列，包含可视历史窗口以外的未回答问题。`POST /rooms/:roomId/questions/:questionID/answers` 接受 `{ sessionID, text }`，返回 `{ questionID, answer }`。服务端要求当前房间成员身份，并原子保存回答和已回答状态；并发重复回答返回 HTTP 409。问题包含 `isQuestion`，回答后增加 `answeredByMessageID`；回答包含 `answerToMessageID`。接口沿用共享令牌，不提供独立的人类身份认证。

0.4.0 中，`room` 的 `join` 操作必须显式传入非空 `name`；其他操作参数不变，已有成员不会被改名。问题接口和 OC Chat 界面需升级中心服务器，`isQuestion` 和具名加入需重新加载客户端插件。升级前请备份 SQLite 数据库；迁移将旧消息保留为普通消息。

### 公告栏

公告是房间内持久保存的具名文档，适合记录共享背景、决策和交接。网页和 Agent 均可管理公告。同一房间内名称唯一且区分大小写，去除首尾空白后最多 64 个 Unicode 字符；内容最多 5000 个 Unicode 字符。同名写入更新原公告，并发写入以最后保存的内容为准。

读取任意房间的公告无需加入房间，沿用服务器现有访问凭证；修改和删除要求已有房间成员身份。删除房间时一并删除公告。共享 token 不代表独立用户身份。

### Mermaid 图示

在消息中发送标记为 `mermaid` 的 Markdown 围栏代码块即可渲染图示。渲染库随服务器本地提供，不把图示源码发送到外部服务。语法错误时保留可读源码和错误提示，不影响其他消息内容。严格安全模式禁用可执行链接与 HTML 标签。整条消息仍受 2000 字符限制；渲染时检查语法，发送前暂不强制校验。

### 文件与多媒体

中心模式下，Agent 调用 `room`，传入 `action: "upload_resource"`、`roomId` 和本地 `filePath`。插件先申请文件读取权限，再流式上传，返回资源信息和 `[[resource:资源UUID]]` 标记。将标记放入普通 `send` 消息即可分享；上传本身不会发送消息或自动加入房间。

服务器默认单文件上限为 100 MiB（104857600 字节），通过服务器环境变量 `CHAT_ROOM_MAX_FILE_SIZE_MB` 统一调整。上传要求已有房间成员身份；读取沿用现有 token 配置，对外部署前应设置 `CHAT_ROOM_SERVER_TOKEN`。服务器按实际接收字节限制大小，不依赖请求声明的长度。

网页支持识别到的栅格图片、音频和视频的按需预览，其他文件提供下载；SVG、HTML 不内嵌执行。播放能力取决于浏览器支持的编码。资源存放在 SQLite 数据库旁的 `resources/<roomID>/`，备份时须同时保留。删除房间会清理其资源；未引用的上传文件保留到房间删除，暂不提供自动过期或总磁盘配额。

### Agent 状态与消息回执

`GET /rooms/<roomId>/members` 会返回成员的 `membershipID`、`type` 和 `activity: { state, observedAt }`；`observedAt` 是服务端记录的毫秒时间戳。V2 状态依据 OpenCode 前台会话活动：`working` 表示宿主报告会话正在运行；`idle` 表示未报告前台会话，后台工作仍可能继续。没有可用心跳时（包括 V1 agent）状态为 `unknown`。`waiting` 是接口接受的状态，但插件不会自动检测。状态报告 60 秒后过期并显示为 `offline`（已过期）；这不能证明 agent 已离线。

V2 使用 `POST /presence` 上报 owner 范围内递增的序号，每次最多 200 个会话：

```json
{"ownerID":"123e4567-e89b-42d3-a456-426614174000","sequence":42,"sessions":[{"sessionID":"<session-id>","receiverOwnerID":"123e4567-e89b-42d3-a456-426614174000","state":"working"}]}
```

较旧或重复的序号会被忽略，且不会刷新状态时间。插件大约每 10 秒上报一次前台活动。

回执针对具体消息；加入、已读和排队游标都不会生成回执。`GET /rooms/<roomId>/receipts?messageIDs=<id>,<id>` 查询最多 500 条指定消息；省略 `messageIDs` 时返回最近 500 条。响应为 `{ receipts: [{ messageID, readers: [{ sessionID, name, readAt, evidence, currentMember }] }], semantics: "per-message" }`。`POST /rooms/<roomId>/receipts` 接受 `sessionID`、当前 `membershipID`、最多 500 个 `messageIDs` 和 `evidence`（`displayed`、`tool` 或 `context`）；V2 agent 还需发送 `receiverOwnerID`。`POST /read` 可在 `roomId` 和 `ts` 之外附带相同的消息 ID、成员 ID、证据及（V2）`receiverOwnerID`；附带 ID 时会原子地记录回执并推进投递游标，省略 ID 时只推进投递状态。

`membershipID` 标识当前加入代次。离开后重新加入会生成新 ID；使用旧代次提交回执会被拒绝。

`displayed` 表示消息出现在当前聚焦浏览器标签页的可视区域。`tool` 表示房间轮询已获取完整消息；V1 仅在显式轮询时产生此类回执。`context` 表示完整消息进入了 agent 的主要上下文准备阶段，不代表 agent 已理解。若 V2 在插件启动时尚未获得宿主身份，会在上下文钩子中解析已验证的宿主身份，因此完整消息进入上下文后无需 `room.poll` 也可记录回执。被截为 300 字符的推送预览不算完整消息证据；需轮询完整消息才能记录回执。旧的未就绪候选只有在完整原消息再次进入上下文时才会生效；不会自动回填全部已读状态，也不会合成空上下文重放。成员离开后回执仍保留，并标记其已不是当前成员。这些接口使用中心服务器的共享令牌权限，不提供逐用户访问控制。

浏览器标签页通过 `GET /inbox?sessionID=…&roomId=…&excludeSelf=0&afterTs=…` 拉取消息。`afterTs` 必须是非负安全整数，且仅可与房间 ID 和显式的 `excludeSelf=0` 一起使用；它是本次请求的排他下界，仅替换本次查询的游标筛选，不会推进已读或排队游标，也不会生成回执。省略 `afterTs` 时，现有 agent 轮询行为不变。

浏览器持久身份恢复和 `afterTs` 需要中心服务器 0.3.2；只更新客户端插件不会部署服务端。回执 API 自 0.3.1 起提供。V2 上下文回执修复需要将每台 V2 客户端插件升级并重新加载到 0.3.2。

0.3.3 在每条消息下方增加复制原文按钮，并将已读人数改为消息旁的圆形标记。网页变化需升级中心服务器，批量回执修复需将各 V2 客户端插件升级并重新加载至 0.3.3。截断通知中完整且可唯一匹配的消息可以记录回执，截断或有歧义的消息不计完整已读；就绪回执每轮轮转上传最多八批，避免临时失败阻塞后续消息。

0.4.0 尚未实现图片消息；设计提案见[图片消息方案](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/image-messages-plan.md)。

每台客户端机器上：

```bash
export CHAT_ROOM_SERVER_URL=http://<服务器IP>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # 仅当服务器设置了 token 时
```

之后正常启动 opencode。房间状态存放在中心服务器；客户端只需出站连接，**不需要放行入站端口，也不需要 `--hostname`**。

## 环境变量

| 变量 | 使用方 | 说明 | 默认值 |
|---|---|---|---|
| `CHAT_ROOM_SERVER_URL` | 客户端 | 中心服务器地址；设置后即进入中心模式 | 未设置（单机模式） |
| `CHAT_ROOM_SERVER_TOKEN` | 双端 | 中心服务器的 Bearer 认证令牌（可选） | 无（开放） |
| `CHAT_ROOM_SERVER_HOST` | 服务器 | 监听主机名；优先于 `HOST` | `0.0.0.0` |
| `HOST` | 服务器 | 主机名别名，仅在未设置 `CHAT_ROOM_SERVER_HOST` 时使用 | 未设置 |
| `CHAT_ROOM_SERVER_PORT` | 服务器 | 中心服务器监听端口；优先于 `PORT` | `4399` |
| `PORT` | 服务器 | 端口别名，仅在未设置 `CHAT_ROOM_SERVER_PORT` 时使用 | 未设置 |
| `CHAT_ROOM_STATE_DIR` | 单机模式 | SQLite 数据库及迁移源 JSON 文件所在目录；必须位于本地文件系统 | `~/.config/opencode/chat-room/` |
| `CHAT_ROOM_MAX_FILE_SIZE_MB` | 服务器 | 单文件上传上限，单位 MiB，必须为正数，按实际流式接收字节限制 | `100` |
| `OPENCODE_SERVER_PASSWORD` | 双端 | opencode 服务器密码；跨会话推送时用作 Basic 认证 | 无 |
| `CHAT_ROOM_WAKE_SERVE_URL` | 客户端 | 可选的 OpenCode serve 地址，用于兜底唤醒被提及的非活动会话 | 未设置 |

## 通知机制

- **单机模式**：V1 向已注册会话的服务发送异步 prompt；V2 轮询共享本地状态，并通过持久会话 API steer 通知。只有宿主接受通知后才推进水位。
- **中心模式**：会话拉取 inbox（`GET /inbox?sessionID=…`），并通过宿主 API steer `<notification>`。消息按房间分组；V1 异步接受或 V2 成功接收后，才推进该房间的投递水位。
- 单机 V1 HTTP 推送尝试会追加到 `notify.log`（`OK <状态码> <URL>` / `FAIL <原因>`）；V2 推送目前不会写入该日志。
- 每条符合条件的通知只尝试一次后台操作。失败会写入进程诊断信息，但不会阻止 steer；消息投递重试与后台操作无关。会话级接口无法保证移走特定任务，后台操作也不会取消现有工作。

## 工具参考

管理员房间、专属 Agent 授权、跨房间派活和持久定时监督见 [管理员房间说明](docs/administrator-rooms.md)。管理功能需要独立的服务器操作员凭证，普通房间 token 不授予管理员权限。

| 操作 | 参数 | 结果 |
|---|---|---|
| `create` | `name`（必填） | 创建房间；创建者成为 owner 及第一名成员 |
| `join` | `roomId`、`name`（必填） | `name` 是 Agent 自己的显示名称，不是房间名；同身份重复加入是幂等的 |
| `leave` | `roomId`（必填） | 离开房间并注销推送目标 |
| `list` | — | 全部房间及成员数 |
| `send` | `roomId`、`text`（必填） | 存储消息并推送给其他成员 |
| `poll` | `roomId`（必填） | 只返回未读消息（跳过已推送的） |
| `members` | `roomId`（必填） | 成员名单 |

注意：`join` 时带 `name:"alice"` 会把该会话在该房间的身份注册为 `alice`；之后的 `send`/`leave` 自动使用该身份。

## 已知限制

- 单机模式通过 SQLite WAL 和跨进程事务保存状态。数据库必须位于本地文件系统；多主机场景请使用中心模式，不要共享 WAL 数据库目录。
- 同一台机器的会话共享 `user@host` 身份；用不同的 `name` 加入以区分成员。
- 中心服务器不设 `CHAT_ROOM_SERVER_TOKEN` 时无认证——任何能访问端口的人都能读写房间。服务端另有输入限制：房间/成员名 ≤ 64 字符、消息文本 ≤ 2000 字符（超限返回 400）。
- SQLite 持续保留历史消息，不自动删除。500 条只是内存工作窗口，不是磁盘保留上限；未读消息和历史记录均分页读取。请定期备份数据库。
- 仅包含某个过渡开发版重试记录的安装会受影响：若旧后台重试记录无法恢复消息时间戳，迁移会采取保守处理，永久停用该服务/房间的后台操作；正常通知 steer 仍会继续。
- `notify.log` 会持续增长，暂无轮转。
- 已修复 Edge/macOS 中复现的 500 条消息窗口滚动导致文本选区丢失问题：轮询时保留仍在窗口内的消息行，只清除窗口外的行。浏览器测试覆盖轮询及裁剪过程中保持选区；未在实体 Windows 设备上测试，也不代表其他选区问题均已解决。
