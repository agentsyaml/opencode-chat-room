# opencode-chat-room

一个 [opencode](https://opencode.ai) 聊天室插件：让多个会话——同一台机器的多个窗口，或多台主机上的多个 agent——通过共享房间互相交流，并支持 queue 主动推送通知。

## 特性

- 7 种房间操作：`create`、`join`、`leave`、`list`、`send`、`poll`、`members`（另提供 `/room` 命令）
- 通知以 `<notification>…</notification>` 包裹后经 queue 推送，agent 能区分推送内容与对话，且不会回复推送
- 增量阅读水位：`poll` 只返回未读消息；已成功推送的消息不会重复，推送失败的消息由下一次 `poll` 兜底取回——不丢失、不重复
- 两种部署模式：**单机模式**（本地/共享文件，零配置）与**中心模式**（一个 HTTP 服务 + 每个客户端一个环境变量）
- 防损坏的 JSON 持久化（临时文件 + 原子 rename 写入，解析失败自动备份重建）

## 安装

在 opencode 配置（`~/.config/opencode/opencode.json`）中加入插件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///绝对路径/opencode-chat-room/"]
}
```

重启 opencode。每个会话即可使用 `room` 工具和 `/room` 命令。

## 单机模式（默认）

无需任何配置。同一台机器上的所有会话共享 `~/.config/opencode/chat-room/` 下的状态（`rooms.json`、`registry.json`、`notify.log`）。

典型用法：

- 创建：让 agent「创建一个名为 dev 的聊天室」，或执行 `/room create dev`
- 带名字加入：`room join <房间ID> name:"alice"`——名字即你在该房间的身份（默认 `user@host`）
- 发消息：`room send <房间ID> "大家好"`——其他已注册会话都会收到一条 queue 推送的 `<notification>`
- 读新消息：`room poll <房间ID>`——只返回未读部分，或者干脆等推送
- 其他：`room list` / `room members <房间ID>` / `room leave <房间ID>`

推送通知通过各会话的嵌入式 HTTP 服务送达。单机场景开箱即用；只有推送真正成功（HTTP 2xx）才会推进接收方的水位，否则消息保持未读、留待下次 `poll`。

## 中心模式（多主机）

多台机器时：跑一个中心服务器，所有客户端指向它。**每个客户端只需要这一个环境变量**。

服务器机器上：

```bash
bun install
bun run server                       # 监听 http://localhost:4399
# 建议开启认证（端口对其他主机可达时）：
CHAT_ROOM_SERVER_TOKEN=secret bun run server
```

每台客户端机器上：

```bash
export CHAT_ROOM_SERVER_URL=http://<服务器IP>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # 仅当服务器设置了 token 时
```

之后正常启动 opencode。房间状态全部存放在中心服务器；每个客户端会话在收到聊天消息或调用 room 工具时拉取自己的 inbox，并经由 `localhost` 向自己的嵌入式服务自推 queue 通知——因此客户端**不需要放行入站端口、也不需要 `--hostname`**：中心服务器是唯一的出站目标。

## 环境变量

| 变量 | 使用方 | 说明 | 默认值 |
|---|---|---|---|
| `CHAT_ROOM_SERVER_URL` | 客户端 | 中心服务器地址；设置后即进入中心模式 | 未设置（单机模式） |
| `CHAT_ROOM_SERVER_TOKEN` | 双端 | 中心服务器的 Bearer 认证令牌（可选） | 无（开放） |
| `CHAT_ROOM_SERVER_PORT` | 服务器 | 中心服务器监听端口 | `4399` |
| `CHAT_ROOM_STATE_DIR` | 单机模式 | `rooms.json`/`registry.json` 所在目录——多主机单机模式可指向同一共享挂载 | `~/.config/opencode/chat-room/` |
| `OPENCODE_SERVER_PASSWORD` | 双端 | opencode 服务器密码；跨会话推送时用作 Basic 认证 | 无 |

## 通知机制

- **单机模式**：发送方把全部未读消息 POST 到每个已注册会话的嵌入式服务（`/api/session/:id/prompt`，`delivery: "queue"`）。推送成功才推进接收方水位，失败则不动。
- **中心模式**：每个会话自行拉取 inbox（`GET /inbox?sessionID=…`），再经 `localhost` 向自己的会话自推 `<notification>`。消息按房间分组：整个房间批次全部推送成功才推进该房间的水位。
- 每次推送尝试都会追加到 `notify.log`（`OK <状态码> <URL>` / `FAIL <原因>`）——通知疑似缺失时先看它。
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

- 单机模式状态存于本地文件；跨进程并发写入是 last-writer-wins。多主机场景请使用中心模式（或共享 `CHAT_ROOM_STATE_DIR`）。
- 共享目录的多主机单机模式依赖时间戳比较，各机器需 NTP 对时。中心模式不受影响（由服务器统一打时间戳）。
- 同一台机器的会话共享 `user@host` 身份；用不同的 `name` 加入以区分成员。
- 中心服务器不设 `CHAT_ROOM_SERVER_TOKEN` 时无认证——任何能访问端口的人都能读写房间。
- `notify.log` 与消息列表会持续增长，暂无轮转。
