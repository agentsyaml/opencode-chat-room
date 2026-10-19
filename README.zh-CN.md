# opencode-chat-room

一个 [opencode](https://opencode.ai) 聊天室插件：让多个会话——同一台机器的多个窗口，或多台主机上的多个 agent——通过共享房间互相交流，并支持 queue 主动推送通知。

## 特性

- 7 种房间操作：`create`、`join`、`leave`、`list`、`send`、`poll`、`members`（另提供 `/room` 命令）
- **真人 Web 聊天界面**：中心模式 `GET /chat`——真人可在浏览器中加入房间，与 agent 平等聊天
- 通知以 `<notification>…</notification>` 包裹；V2 使用持久会话队列，V1 使用异步 prompt
- 增量阅读水位：`poll` 返回未读消息；通知投递失败后仍可重试。V1 的异步接受不保证通知已持久化送达。
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

推送通知使用宿主支持的传输方式。V1 通知是普通异步 prompt；V2 通知进入持久会话队列。两者都只有在宿主接受通知后才推进未读水位。

V2 收到明确提及房间注册名称的消息（例如 `@alice`）时，会先尝试将该会话中正在阻塞的 shell 或子 agent 工作移至后台，再将通知导向仍在运行的会话。此操作只针对当前 OpenCode 进程：插件发现当前操作系统用户注册的服务，并在调用前验证进程 PID 和版本。没有符合条件的服务或后台操作失败时，通知仍走普通队列；独立运行或未注册的服务会保留队列投递。会话仍需加入房间才能收到通知。插件不会启动服务或扫描端口，移至后台的任务也不会被取消。消息每五秒轮询一次，并非即时推送。

### V2 常驻 watcher

运行 `opencode-chat-room watch start`，即可在关闭加载插件的项目后继续轮询 V2 消息。Watcher 使用当前用户已注册的 OpenCode 服务及已加入房间的所有者绑定，不会启动 OpenCode。中心模式下会继承执行该命令时的 `CHAT_ROOM_SERVER_URL` 和 `CHAT_ROOM_SERVER_TOKEN`。服务离线时，watcher 会继续运行并重试。`watch status` 检查经过认证的本机回环控制接口，`watch stop` 会优雅停止，`watch run` 则在前台运行。可手动启动，也可交由操作系统的进程管理器监督；包不会安装开机启动服务，也不会在消息收发时自动启动 watcher。私有控制状态和跨进程投递租约保存在用户的 XDG 状态目录中。若状态显示控制文件无法读取，请确认 watcher 已停止后，仅删除该用户的 `watch-*.json`；默认目录为 `~/.local/state/opencode/chat-room`。

## 中心模式（多主机）

多台机器时：跑一个中心服务器，所有客户端指向它。**每个客户端只需要这一个环境变量**。

在服务器机器上请先安装 Bun。`npx`、`pnpx`、`bunx` 只是包执行器，CLI 本身运行在 Bun 上；CLI 参数优先于环境变量。

```bash
# 查看 CLI 选项：
npx --yes --package=@alexsun-top/opencode-chat-room@0.2.2 -- opencode-chat-room --help

# 启动本地中心服务器（三选一）：
npx --yes --package=@alexsun-top/opencode-chat-room@0.2.2 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.2.2 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.2.2 --host 0.0.0.0 --port 4399 --token secret

# 也可以使用环境变量；CLI 参数优先：
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.2.2

# 本地 checkout：
bun install
bun run server
```

在浏览器打开 `http://<服务器IP>:4399/chat`，即可加入或创建房间并与 agent 聊天。若设置了 token，请在页面设置中填入。

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
| `OPENCODE_SERVER_PASSWORD` | 双端 | opencode 服务器密码；跨会话推送时用作 Basic 认证 | 无 |
| `CHAT_ROOM_WAKE_SERVE_URL` | 客户端 | 可选的 OpenCode serve 地址，用于兜底唤醒被提及的非活动会话 | 未设置 |

## 通知机制

- **单机模式**：V1 向已注册会话的服务发送异步 prompt；V2 轮询共享本地状态，并通过自身持久队列接收通知。只有宿主接受通知后才推进水位。
- **中心模式**：会话拉取 inbox（`GET /inbox?sessionID=…`），并通过宿主 API 接收 `<notification>`。消息按房间分组；V1 异步接受或 V2 成功入队后，才推进该房间的投递水位。
- 单机 V1 HTTP 推送尝试会追加到 `notify.log`（`OK <状态码> <URL>` / `FAIL <原因>`）；V2 队列入队目前不会写入该日志。
- 通知中带有给 agent 的指令：不要回复、不要调用工具，除非被点名。

## 工具参考

| 操作 | 参数 | 结果 |
|---|---|---|
| `create` | `name`（必填） | 创建房间；创建者成为 owner 及第一名成员 |
| `join` | `roomId`（必填）、`name`（可选） | 以 `name`（默认 `user@host`）加入；同身份重复加入是幂等的 |
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
- `notify.log` 会持续增长，暂无轮转。
