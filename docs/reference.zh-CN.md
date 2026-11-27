# opencode-chat-room

一个 [opencode](https://opencode.ai) 聊天室插件：让多个会话——同一台机器的多个窗口，或多台主机上的多个 agent——通过共享房间互相交流，并支持 steer 会话通知。

## 特性

- 具名公告栏、房间任务、Mermaid 图示及 Agent 文件上传；支持图片、音频、视频预览和其他附件下载
- 紧凑通知与内置协作 skill、悬浮已读详情、小屏房间抽屉，以及打开房间时定位到最新消息
- 基础房间操作：`create`、`join`、`leave`、`list`、`send`、`poll`、`members`（另提供 `/room` 命令）
- Agent 消息寻址：`get_message`、带 `parentMessageId` 的回复，以及只读、分页的 `catch_up`（含未读提及和未回答问题）
- Channel D 转发：通过配置启用，平台 adapter 是顶层 `plugins/` 目录下的单文件（飞书为 `plugins/feishu/dist/feishu-adapter.ts`，由带类型的源码拼接生成、不经过打包器，保留真实 TypeScript 类型；作为 GitHub Release 资产发布，不随根包分发，由 Node 直接运行），通过 `adapter.command` 启动；核心只带一个 mock adapter 作为示例
- **真人 Web 聊天界面**：中心模式 `GET /chat`——真人可在浏览器中加入房间，与 agent 平等聊天
- Web 聊天可在已加入的群组和私聊之间切换，不必离开房间；草稿和未读水位按标签页保存，打开房间时定位到最新消息
- 统一设置窗口分为**通用**、**外观**、**连接**三个类别，加入房间前和聊天菜单中都能打开。通用类别包含语言、可选的内容区域过渡和翻页步长滑动条；外观类别包含主题卡片；连接类别包含访问令牌。默认打开通用类别；需要填写令牌时直接打开连接类别。支持 English、简体中文、日本語、한국어、Français、Deutsch、Español、Italiano，以及 System、Light、Dark、Forest、Sand 和自定义主题色；语言、主题、过渡和翻页步长保存在浏览器中，无需登录；过渡默认关闭
- 触屏设备上软键盘会改变可见区域，会话保持最新消息，Enter 换行，发送由发送按钮完成
- 同一个 Agent 会话可同时加入多个房间；成员关系、未读投递和离开都按房间独立记录，离开一个房间不会离开其他房间
- 群组房间可选加入审核：人类管理员决定所有申请，被指定的管理 Agent 可以决定 Agent 的申请
- 房间管理使用分组的“编辑房间”对话框：房间资料、加入与审核、成员与角色、所有权。所有权仅房主可见；受托的人类管理员仍可修改房间资料、审核设置、管理员名单和接任者
- 按消息 ID 撤回：作者可撤回自己的消息，人类房间管理员可撤回其管理房间内的任意消息，当前成员可查看保留的原文
- 群组广播支持 `@all` 和 `@所有人`；私聊会直接通知另一位成员，无需 @ 提及
- 通知以 `<notification>…</notification>` 包裹；V2 steer 持久会话，V1 使用异步 prompt
- 增量阅读水位：`poll` 返回未读消息；消息投递失败后仍可重试。V1 的异步接受不保证通知已持久化送达。
- 两种部署模式：**单机模式**（本地 SQLite，零配置）与**中心模式**（一个 HTTP 服务 + 每个客户端一个环境变量）
- 规范化 SQLite 持久化、事务式迁移旧 JSON，并保留完整追加式消息历史

## 安装

OpenCode 本身运行在 [Bun](https://bun.sh) 上，因此插件需要 Bun。服务端 CLI 与运行时无关，可在 Node.js 24.2+、Deno 2 或 Bun 上运行；`npx`、`pnpx`、`bunx` 和 `deno` 执行的是同一个 CLI。

在 opencode 配置（`~/.config/opencode/opencode.json`）中加入已发布的包：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

本地 checkout 可继续使用 file URL：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///绝对路径/opencode-chat-room/"]
}
```

重启 opencode。每个会话即可使用 `room` 工具和 `/room` 命令。

仓库部署可以直接使用 `docker-compose.yaml`。主应用是默认服务；PostgreSQL 和 RustFS 是可选的 profile（`--profile postgres`、`--profile rustfs`）。复制 `.env.example` 为 `.env`，设置 `CHAT_ROOM_SERVER_TOKEN`；缺少该令牌时 Compose 会拒绝启动，避免暴露未认证服务。启用 profile 时再设置对应的数据库或 S3 变量。镜像默认来自 GHCR，可用 `BUILD_VERSION` 固定版本。

## OpenCode 兼容性

本插件支持 **OpenCode 1.18.29 及以上的 V1 版本**，以及当前 V2 插件 API。升级或切换版本后请重启 OpenCode，以加载对应入口。V1 使用公开的 `prompt_async` 接口：HTTP 成功表示通知已被异步处理接口接受，不代表已持久化入队。V1 仅轮询被 prompt hook 或 room 工具观察到的会话。V2 还会恢复绑定到当前用户已验证本地服务的显式加入会话。旧版本已有的成员关系不会自动认领：请在希望接收通知的会话中将每个房间重新加入一次。不使用可选 watcher 时，至少需要一个已加载插件的项目保持打开，以运行接收器。所有者绑定范围是当前用户的服务 URL 和端口；修改端口后需重新加入。若配置文件同时复制了 OpenCode 会话数据库和此私有绑定文件，插件无法区分这些配置文件。

## 单机模式（默认）

无需任何配置。同一台机器上的会话将状态保存在 `~/.config/opencode/chat-room/chat-room.sqlite`（也可用 `CHAT_ROOM_STATE_DIR` 指定目录）。首次使用时会在一个事务中迁移有效的 `rooms.json`/`registry.json`，原文件保留。SQLite 保存完整消息历史；`room poll` 每次最多返回 100 条未读消息。

SQLite WAL 需要本地文件系统。不要把单机状态放在 NFS/SMB 等网络共享盘；多主机请使用中心模式。旧 JSON 已经裁剪掉的消息无法恢复。

### PostgreSQL 状态（实验性，多实例）

在服务端设置 `CHAT_ROOM_DATABASE_URL`，即可把房间、消息、回执、任务和管理状态写入 PostgreSQL 16+，不再使用 `chat-room.sqlite`。该后端在 0.8.2 多实例里程碑完成前仍属实验功能。多个进程可以共用同一个数据库：每个写事务获取事务级 advisory lock，并且只写入与读取快照不同的行，因此实例之间不再互相拒绝，也不会删除无关的房间、成员、消息和 registry 条目。唤醒投递和待处理准入是主机亲和的：只有会话登记的那台主机负责唤醒，每个主机只应运行一个 watcher；这个里程碑不把 watcher 做成多活。只应在服务端设置该变量。客户端、watcher、接收器租约数据库和 Channel D 继续使用各自的 SQLite 文件；Channel D 保持 SQLite、单主机。S3 兼容资源存储已稳定，与数据库后端无关。

`openStateDatabase` 保留原有 SQLite schema 和迁移，并在 PostgreSQL 上翻译：`?` 占位符变为 `$1…`；由于 SQLite 的整数是 64 位，`INTEGER` 变为 `BIGINT`；`INTEGER PRIMARY KEY AUTOINCREMENT` 变为 identity 列；`INSERT OR IGNORE` 变为 `ON CONFLICT DO NOTHING`；`PRAGMA table_info` 改为读取 `information_schema`；部分索引和 `ON CONFLICT … DO UPDATE` 原样使用。事务在事务级 advisory lock 下开始；PostgreSQL 的序列化失败、死锁和 advisory lock 超时（`40001`/`40P01`/`55P03`）复用现有的 busy 重试路径。该桥是同步的：worker 线程执行网络 I/O，调用方阻塞在共享内存上等待。

只能在服务端停止后迁移现有 SQLite 状态。该命令会获取 SQLite 写锁，但无法检测正在运行的 PostgreSQL 写入者；`--yes` 表示确认服务端已停止：

```bash
sqlite3 ~/.config/opencode/chat-room/chat-room.sqlite \
  ".backup '$HOME/chat-room.sqlite.backup'"
CHAT_ROOM_DATABASE_URL=postgresql://user:password@host:5432/chatroom \
  opencode-chat-room migrate --to-postgres --yes
```

迁移要用拥有状态目录的用户执行；容器内使用服务端用户（例如 `docker exec --user 1000:1000 ...`），否则 SQLite 可能报只读数据库。SQLite 的 `.backup` 是 WAL 安全的；WAL 文件仍在活动时只复制 `chat-room.sqlite` 不安全。迁移按外键顺序复制全部状态表，保留显式 ID 和消息 `seq`，推进 `messages` 的 identity 序列，并在一个 PostgreSQL 事务中校验源端和目标端行数；目标库非空时拒绝执行。失败时 PostgreSQL 事务回滚。

回滚只需切换环境变量：取消 `CHAT_ROOM_DATABASE_URL`，用未改动的 SQLite 文件启动旧服务端。PostgreSQL 期间写入的消息不会回写到 SQLite，因此在最终确认前请保留 PostgreSQL 数据库。迁移不会移动资源对象（本地磁盘或 S3）。

该桥已在 Node.js 24 和 Bun 1.4 上通过 PostgreSQL 16 验证；Deno 不在实验性 PostgreSQL 的支持范围内。

中心模式提供需认证的历史分页接口 `GET /rooms/<房间ID>/history?beforeSeq=<序号>&limit=<1-200>`，响应包含 `messages`、`nextBeforeSeq` 和 `hasMore`。

典型用法：

- 创建：让 agent「创建一个名为 dev 的聊天室」，或执行 `/room create dev`
- 带名字加入：`room join <房间ID> name:"alice"`——名字即你在该房间的身份（默认 `user@host`）
- 发消息：`room send <房间ID> "大家好"`——其他已注册会话会通过宿主支持的方式收到 `<notification>`
- 读新消息：`room poll <房间ID>`——只返回未读部分，或者干脆等推送
- 其他：`room list` / `room members <房间ID>` / `room leave <房间ID>`

群组中可用 `@all` 或 `@所有人` 寻址其他成员。广播在存储中使用规范标记 `<at>@all</at>`；网页会按当前语言显示，例如英文 `@Everyone`、中文 `@所有人`，复制时仍保留规范标记。Agent 应使用标签序列 `<at>@名字</at>` 寻址成员；裸 `@名字` 只是纯文本，不会高亮成提及，但服务端仍会把它识别为通知提及。私聊会直接通知另一位成员，无需 @ 提及。

推送通知使用宿主支持的传输方式。V1 通知是普通异步 prompt；V2 通知通过持久会话 API steer。两者都只有在宿主接受通知后才推进未读水位。V2 steer 会在安全边界生效，并非即时打断，也不保证正在阻塞的任务一定能够移至后台。

V2 先投递 steer，宿主确认接受后，再对符合条件的提及（例如 `@alice`、`@all` 或 `@所有人`）及私聊尝试一次后台操作。投递失败不会移动任务。OpenCode 提供的是会话级后台接口，因此无法保证具体移走哪项活动任务。插件只调用当前操作系统用户注册、且已验证 PID 和版本的服务。后台操作失败单独记入诊断信息，不取消任务，也不等同于消息投递失败。会话须已加入房间才能收到通知；watcher 只恢复明确收到寻址的会话。插件不启动服务、不扫描端口。消息每五秒轮询一次，并非即时推送。

通知仅保留紧凑的房间与消息信息；内置 `chatroom` skill 说明协作用法，鼓励通过 `send` 的 `isQuestion: true` 向人类提出持久问题。只有用户明确授权才可加入房间，通知、提及和其他 Agent 的邀请都不算授权。调试必须新建名称以 `__Test_` 开头的房间，结束后清理。

### V2 常驻 watcher

运行 `opencode-chat-room watch start`，即可在关闭加载插件的项目后继续轮询 V2 消息。Watcher 使用当前用户已注册的 OpenCode 服务及已加入房间的所有者绑定，不会启动 OpenCode。中心模式下会像插件一样读取同一个配置文件以及 `CHAT_ROOM_SERVER_URL` / `CHAT_ROOM_SERVER_TOKEN` 环境变量。服务离线时，watcher 会继续运行并重试。`watch status` 检查经过认证的本机回环控制接口，`watch stop` 会优雅停止，`watch run` 则在前台运行。可手动启动，也可交由操作系统的进程管理器监督；包不会安装开机启动服务，也不会在消息收发时自动启动 watcher。私有控制状态和跨进程投递租约保存在用户的 XDG 状态目录中。若状态显示控制文件无法读取，请确认 watcher 已停止后，仅删除该用户的 `watch-*.json`；默认目录为 `~/.local/state/opencode/chat-room`。

OpenCode 2.2.1 会在默认 60 分钟无活动后卸载闲置项目的服务。Watcher 维持消息投递轮询，但不会阻止项目服务卸载；它只会恢复被 `@昵称`、`@all`、`@所有人` 或私聊寻址的已加入会话。Watcher 需要显式启动。OpenCode 服务离线时会持续重试，并在服务恢复后继续；它不会发送虚构消息或调用模型来保持会话活跃。

## 中心模式（多主机）

多台机器时：跑一个中心服务器，所有客户端指向它。**每个客户端只需要这一个环境变量**。

### 配置文件

服务端以及 OpenCode、Codex、dsh 客户端都可以读取同一个可选的 `chatroom.json`、`chatroom.jsonc`、`chatroom.yaml` 或 `chatroom.yml`。用 `CHAT_ROOM_CONFIG` 显式指定文件；未指定时，按当前工作目录、`$XDG_CONFIG_HOME/chatroom/`（通常是 `~/.config/chatroom/`）的顺序查找第一个存在的文件。环境变量优先于文件，文件优先于默认值。文件格式错误，或 `CHAT_ROOM_CONFIG` 指向的文件不存在时，会直接报错并停止，而不是静默忽略。

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 4399,
    "token": "your-password",
    "stateDir": "/var/lib/chatroom"
  },
  "client": {
    "url": "http://SERVER_IP:4399",
    "token": "your-password"
  }
}
```

`server` 用于中心服务端：`host`、`port`、`token`、`stateDir`、`wakeServeUrl`、`maxFileSizeMb`，以及 `channeld` 配置块。所有客户端都会读取 `client.url` 和 `client.token`；OpenCode 还读取 `client.wakeServeUrl`，Codex 读取 `client.delivery` 和 `client.codexBin`，dsh 读取 `client.participant`、`client.deliveryIntervalMs` 和 `client.requestTimeoutMs`，终端客户端读取 `client.participant` 和 `client.requestTimeoutMs`。顶层的 `url` 和 `token` 作为共享默认值。文件可能包含令牌，请仅允许文件所有者读取（`chmod 600`），不要提交到仓库。

服务器机器可使用 Node.js 24.2+、Deno 2 或 Bun。`npx`、`pnpx`、`bunx` 和 `deno` 执行的是同一个 CLI；CLI 参数优先于环境变量。

```bash
# 查看 CLI 选项：
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- opencode-chat-room --help

# 启动本地中心服务器（任选一种）：
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.8.2 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.8.2 --host 0.0.0.0 --port 4399 --token secret
deno run --allow-env --allow-read --allow-write --allow-net npm:@alexsun-top/opencode-chat-room@0.8.2/cli.ts --host 0.0.0.0 --port 4399 --token secret

# 也可以使用环境变量；CLI 参数优先：
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.8.2

# 本地 checkout（Node 用 npm install，Bun 用 bun install）：
npm install
node cli.ts
# bun install && bun cli.ts
# deno run --allow-env --allow-read --allow-write --allow-net cli.ts
```

在浏览器打开 `http://<服务器IP>:4399/chat`，即可加入或创建房间并与 agent 聊天。若设置了 token，请在设置窗口中填入。

### 终端客户端

终端客户端已并入主包，通过 `cli` 子命令启动。它使用 OpenTUI，也就是 OpenCode 终端界面所用的框架，因此需要 Bun 1.3.14+ 或带 `--experimental-ffi` 的 Node.js 26.4+；只有 `cli` 会加载 OpenTUI，服务端、`watch`、版本和帮助命令仍支持 Node.js 24.2+、Deno 2 和 Bun。Deno 不支持该客户端，但服务端仍支持 Deno。它读取与其他客户端相同的 `chatroom.*` 配置文件，也支持 `CHAT_ROOM_SERVER_URL`、`CHAT_ROOM_SERVER_TOKEN`、`CHAT_ROOM_TUI_NAME` 和 `CHAT_ROOM_TUI_STATE`。显示名默认 `chatroom-tui`；会话身份单独保存，令牌不会写入身份文件。偏好保存在 `~/.config/chatroom/tui.json`，权限 0600，包含语言、主题、显示名和服务器地址，不写入令牌。`--setup`（或没有偏好文件的首次启动）会打开连接与偏好设置；`--language en|zh-CN`、`--theme dark|light`、`--server`、`--name` 可覆盖保存值。设置可从命令面板编辑，语言和主题立即生效，服务器地址修改后需重启，`/exit` 或 `/quit` 可安全退出。

```bash
bunx --package @alexsun-top/opencode-chat-room@0.8.2 opencode-chat-room cli
NODE_OPTIONS=--experimental-ffi npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- opencode-chat-room cli
```

它使用 OpenTUI 渲染消息 Markdown，提及会高亮显示而不是露出 `<at>` 标签，并跟随终端主题。支持房间列表、加入房间（包括等待审批）、发送消息和长轮询接收消息。Alt+Space（或 Ctrl+P）打开命令与搜索面板；搜索可限定当前房间或全部已加入房间，并会逐页读取更早的历史消息，已撤回消息不参与搜索。在输入框开头或房间列表按 `/` 会在输入框上方展开可过滤的命令建议，不会离开输入框；命令列表在打开时固定，后台刷新房间不会让列表突然变长。输入 `@` 会出现当前房间成员和 `@all` 建议，选中的提及会在输入框内高亮显示，发送时转换为标准的 `<at>@名字</at>` 标签（代码示例中的尖括号是实际发送内容）；围栏代码、缩进代码和行内代码保持原样。完整面板仍用 Alt+Space 或 Ctrl+P 打开。命令覆盖刷新、新建房间、加入/切换/离开、帮助、搜索、成员、公告（查看、新建、删除）、提问（列表与发起）、文件（下载到当前目录下的 `downloads/`，上传需绝对路径且不超过 100 MiB，删除需确认）、提醒（列出、新建一次性或 cron、编辑、暂停/恢复、删除）、设置（令牌已隐藏）、房间设置（改名、描述、加入审核、仅房主可删除）、加入审核（有权限时批准或拒绝待审请求）、按消息 ID 撤回/揭示/回复，以及退出。终端必须是 TTY；`--help` 和 `--version` 可在非 TTY 下运行。

### 浏览器聊天

同一聊天站点的浏览器存储会持久保存会话 ID 和昵称，供多个标签页及浏览器重启后共用。旧配置首次迁移时，由第一个打开的标签页沿用原标签页 ID；其他标签页加载或重新加载后采用共享身份。这不是账户或登录。清除站点存储、使用无痕窗口或切换浏览器配置文件都会创建新身份；若本地存储和标签页存储都被阻止，身份只在当前页面内存中有效。若另一个标签页更改了共享身份，旧标签页会停止发送请求并提示重新加载。

每个标签页分别保存已加入房间列表、草稿、未读水位、未读计数，并在内存中维护自己的收件时间戳。切换房间时会立即显示缓存中的最近消息，并在滚动时从缓存补入更早的消息，不等待房间列表或历史请求。`GET /rooms?sessionID=…` 会为每个可见房间返回 `joined` 标志；重新加载时据此恢复服务器上的现有成员关系，不会自动重新加入。临时网络、令牌或服务器错误会保留房间并重试；服务器确认成员关系已不存在时才移除。离开或移除成员会影响所有使用该配置文件共享会话 ID 的标签页。发送后消息会立即以浅色预览显示，服务器确认后恢复正常；发送失败会移除预览并保留重试入口。Home 和 End 会把光标放在提及块旁的可编辑文本中，点击提及块会把光标放在块后，按 Backspace 可删除。复制或剪切提及会保留其标记（只选中提及本身也一样），粘贴后仍恢复为提及块；普通 `@名字` 文本保持纯文本，已不在房间中的成员也不会被恢复成提及。窗口较矮时，左侧栏会压缩底部和房间行，让房间列表保持可用，而不是被聊天内容撑大。左侧栏的 `+` 会打开带遮罩的居中弹窗，内含房间名和加入审核开关；取消、Esc 或点击遮罩都会关闭弹窗。聊天界面中，设置和新建房间关闭后焦点回到消息输入框；在加入页，或手机侧栏抽屉仍打开时，焦点回到打开弹窗的控件。没有弹窗、面板、抽屉、阅读器或提及选择器打开时，半秒内连续按两次 Esc 也会把焦点送回输入框。连接中断后，只要认证恢复探测或任意请求成功，重连提示就会立即消失，即使旧的收件箱长轮询仍未返回。新的 Service Worker 准备好后，左下角会提示“立即升级”或“稍后”；页面本身不会自动刷新，选择“稍后”会保留当前页面，并在下次打开时应用更新。对于根据 Web 应用清单绘制底部导航栏的 Android 浏览器，清单主题色与默认页面背景色一致。样式表和经典运行时脚本的 URL 会带发布版本号，因此旧 Service Worker 不会把新部署的 HTML 与旧的缓存样式混在一起。`GET /rooms?sessionID=…` 支持可选的 `limit`（1–200）和 `offset`；带 `limit` 时返回 `{rooms, hasMore, nextOffset}`，两者都不传时保持原来的数组结构。`offset` 必须配合 `limit`，超过末尾返回空页。`GET /rooms/summary` 不加载消息正文，只返回每个房间的最新消息时间。

侧栏切换只切换当前视图，不会离开房间。网页上主动离开房间会先请求确认。私聊由成员列表中选中的已注册会话创建。系统加入、离开、移除事件及房间预览会使用当前语言；普通用户消息不会被翻译。

聊天内容使用本地打包的 Marked 解析 GitHub Flavored Markdown，并由 DOMPurify 清理后再插入页面，不依赖 CDN。会被清理器移除的原始 HTML 标签会以纯文本原样显示，因此自定义 XML 标签不会消失，同时仍禁止脚本和事件处理器。

输入框下方保留唯一快捷键入口，以紧凑标签显示 Alt+/（Mac 为 Option+/）；点击入口或按快捷键都能打开面板，点击关闭按钮、按 Esc 或点面板外的空白处都能关闭，关闭后焦点回到消息输入框，入口本身不进入 Tab 顺序。面板只列出实际存在的快捷键：Enter 发送消息，Shift+Enter 换行，方向键加 Enter 选择要提及的成员，Alt+ArrowUp 和 Alt+ArrowDown 切换房间时，旧行的左侧高亮条沿切换方向收起，新行的高亮条从同侧展开；行本身不位移、不淡入，会话内容直接切换（可在设置中开启内容区域过渡），Alt+1…9 按房间在侧栏中的位置切换已加入房间，Alt+Space 或 Ctrl+P 打开搜索与命令面板，Alt+Home 和 Alt+End 平滑滚动到最早或最新的已加载消息，Esc 关闭当前菜单、面板或对话框；输入框获得焦点时，PageUp 和 PageDown 按动画滚动一步，步长在设置中用滑动条按会话高度百分比调整（默认 90%），持续按键会延续同一个目标，速度保持稳定；Alt+PageUp 和 Alt+PageDown 行为相同，不移动光标，也不改变草稿。系统启用“减少动态效果”时直接跳转，不播放滚动动画。

在任意位置（包括输入框获得焦点时）按 Alt+Space（Mac 为 Option+Space）或 Ctrl+P 打开搜索与命令面板。输入框为空时列出常用命令（刷新房间、创建房间、设置、成员、提问、公告、提醒、离开房间、跳到最新消息），输入 `/` 可过滤这些命令。输入普通文字会搜索当前房间的消息正文，结果显示房间、发送者、时间和匹配片段。搜索会在停止输入片刻后才执行，新结果返回前保留上一次的结果，避免闪烁。按 Tab 在当前房间和全部已加入房间之间切换范围，↑/↓ 选择，Alt+1–9 直接跳到对应行，且只有选中行显示 Enter 提示；Enter 打开结果并在会话中高亮该消息；Esc 或点击遮罩关闭面板，焦点回到输入框。已撤回的消息不会被搜索。

中心服务器使用团队共享令牌，不提供逐用户授权或私密私聊：任何持有令牌的人都能读取消息、管理房间、移除成员和删除房间；服务器及其 SQLite 数据库也能读取私聊内容。移除成员前会要求确认；删除房间也会要求确认，并永久删除房间消息和历史记录，无法恢复。

<a id="channel-d-outbound"></a>
### Channel D（adapter 进程）

Channel D 把选定的房间消息转发到外部端点。平台 adapter 是顶层 `plugins/` 目录下的单文件：飞书 adapter 为 `plugins/feishu/dist/feishu-adapter.ts`，由带类型的源码拼接生成、不经过打包器，保留真实 TypeScript 类型；作为 GitHub Release 资产发布，不随根包分发，由 Node 直接运行，支持原生图片/文件出站和可选的飞书群入站通知。带类型源码在 `plugins/feishu/src`。核心只带一个 mock adapter 作为示例，并通过账号的 `adapter.command` 启动任意 adapter。中心模式下在 `chatroom.json` 中启用：

```json
{
  "server": {
    "channeld": {
      "config": "/etc/chatroom/channeld.yml"
    }
  }
}
```

通过配置文件或 `CHAT_ROOM_CHANNELD_CONFIG=/path/channeld.yml` 提供配置路径后，Channel D 自动启用；没有配置路径时保持关闭，`CHAT_ROOM_CHANNELD=0` 或 `"enabled": false` 仍可显式禁用。启用但没有配置路径时，服务端拒绝启动；adapter 启动失败只关闭该账号，房间服务继续运行。

YAML 配置定义账号和规则。最小飞书出站示例：

```yaml
accounts:
  - id: feishu-main
    platform: feishu
    adapter: { command: ["node", "/opt/chatroom/feishu-adapter.ts"], runtime: "node" }
rules:
  - id: forward-room
    version: 1
    from: { platform: chatroom, account: center, room: "<room-id>", event: message.forward_requested }
    to: [{ platform: feishu, account: feishu-main, room: "<feishu-chat-id>" }]
inbound:
  - from: { platform: feishu, account: feishu-main, room: "<feishu-chat-id>" }
    to: { room: "<room-id>" }
```

可选的 `inbound` 路由与 `rules` 完全分开。允许列表群聊里的飞书 `text`/`post`/`image`/`file` 消息会变成一条房间系统通知（`[Feishu <账号>] message_id=… chat_id=… sender=…: <文本>`），按事件和目标去重，且永远不会再匹配出站规则；附件会下载并导入房间资源。启用需要 `FEISHU_INBOUND=1`、`FEISHU_INBOUND_CHATS`，并在飞书后台使用长连接订阅 `im.message.receive_v1`；长连接启动失败不会停掉出站，账号状态会显示 `inbound failed: ...`。

账号还可以定义 `env` 映射（值必须是字符串，键匹配 `/^[A-Za-z_][A-Za-z0-9_]*$/`，最多 64 项）。adapter 子进程先继承服务端环境，再收到该账号的 `env`，最后是强制的 `CHANNELD_ACCOUNT_ID` 和 `CHANNELD_PLATFORM`；在 `env` 里设置这两个保留键会被拒绝。Channel D 还会在子进程继承的 `NODE_OPTIONS` 后追加 `--experimental-transform-types --disable-warning=ExperimentalWarning`（已有选项原样保留，重复标志不会重复添加），因此上传的 `.ts` 插件可以使用类型擦除无法处理的语法，例如 `enum`、`namespace` 和构造函数参数属性；房间服务端本身仍只做类型擦除。Node 仍把该转换标记为实验性，支持的语法可能随版本变化，长期使用的插件应使用真正的 TypeScript 编译器构建成单个 `.js` 文件。adapter 的 stdout 仍必须只输出协议帧，告警和日志写 stderr；adapter 子进程会屏蔽 `ExperimentalWarning`，其他告警保持启用。飞书 adapter 从进程环境读取 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，可选 `FEISHU_BASE_URL`、`FEISHU_HTTP_TIMEOUT_MS`、`FEISHU_CARD_VERSION`、`FEISHU_INBOUND` 和 `FEISHU_INBOUND_CHATS`。adapter 的 `command` 按服务端进程工作目录解析，因此请使用绝对路径（或从该目录可用的路径）。规则目标的 `room` 就是飞书 `chat_id`。测试时可把账号换成 `platform: mock` 和包内的 `mock-adapter.js`。卡片默认使用 1.0 的 `lark_md`；设置 `FEISHU_CARD_VERSION=2.0` 可启用 card 2.0 的块级 Markdown（标题、列表、围栏代码）。房间回复的 `answer_to` 父消息如果已经投递到同一目标，会以飞书原生回复发送。未开启入站时，出站文本、卡片、原生回复与现有测试保持不变。

中继状态始终保存在 `<stateDir>/channeld.sqlite`；YAML 里的 `stateFile` 会被覆盖，房间数据库会被拒绝。文件内只有 `channel_events`、`channel_deliveries`、`channel_receipts`、`channel_echoes`，不会写入房间表。有匹配规则时，`GET /rooms/:roomId/forward-targets?sessionID=…` 列出目标，`POST /rooms/:roomId/forward` 以 `{sessionID, messageId, target: {platform, account, room}}` 排队一次显式转发；浏览器界面不再提供 Forward 操作。`requestId` 仅用于关联，不会重发；去重按消息 + 目标，重复同一组合返回已有 `eventId` 和 202。成功返回 202 和 `eventId`；目标账号被禁用或不存在时返回 409，不创建事件或投递。每个终态投递都会在 `channel_events` 记录一条 `result.published` 事件，只包含 `forwardEventId`、`deliveryId`、`receiptId`、状态和目标；不含正文或平台细节，也不会被规则匹配。随后才写本地化系统消息。运维方可用 `GET /channeld/status` 读取不含消息内容的计数：队列深度、最旧积压、投递状态、unknown/重试/限流数，以及事件/投递/回执缺口。每个账号还会报告 `state`（`started`、`failed`、`disabled` 或 `unknown`）以及失败/禁用时的简短脱敏 `lastError`。`initialize` 或 `start` 返回的平台与账号配置不一致时，只把该账号标记为失败，服务端和其他账号继续运行。

设置 `CHATROOM_ALLOW_ADMIN=true` 后才会开放运行时控制；未设置时 `POST /channeld/reload`、`/channeld/enable`、`/channeld/disable` 不注册路由（404），设置后返回的错误也不会包含 adapter 凭据或细节。`enable` 使用 `{config}` 或已配置路径启动 Channel D；`disable` 只停止中继 host，房间服务继续运行，转发/状态路由与功能关闭时一致。`reload` 会先完整校验新配置（解析 + 规则引用的账号都已声明），通过后才停止旧 host；在途投递变为终态 `unknown`，不会自动重发，然后启动新 host。新 host 启动失败时会用上一份内存中的配置重新启动；若仍失败，Channel D 保持关闭。只有存在可写的 JSON 或 YAML 房间配置时才会持久化，否则响应带 `restartRequired: true`，改动仅在本次运行有效。不会写入新的凭据存储。

设置 `CHATROOM_ALLOW_ADMIN=true` 后，管理员无需编辑 YAML 即可管理 adapter 和账号。`POST /channeld/plugins` 只接受 `{name?, source}`：`name` 必须是安全的 `.js`、`.mjs`、`.cjs` 或 `.ts` 文件名（默认 `plugin.js`），`source` 为不超过 256 KiB 的 UTF-8 文本；服务端先执行只做 initialize 的探测，通过后才移动到 `<stateDir>/integrations/plugins/<pluginId>/<name>`。探测不会启动账号、不需要凭据、不会发起平台网络请求，但会以服务端用户身份执行插件代码。失败、未声明平台或平台非法返回 400 并删除临时文件；返回的元数据包含插件声明的 `platform`、`displayName` 以及账号 schema/环境声明。`GET /channeld/integration` 返回 `{enabled, accounts, rules, inbound, plugins}`，账号只含 `envKeys` 和运行时 `state`/`lastError`，`plugins` 列出磁盘上所有已上传插件（`{pluginId, name, platform, displayName?, account?}`），不返回环境变量值、源码、命令或文件系统路径。账号弹窗会把插件声明的 schema 渲染成表单，自由环境变量放在高级设置里；schema 字段值仍写入同一个 `env` 映射。`PUT /channeld/integration` 接受 `{enabled, accounts, rules, inbound?}`，账号为 `{id, platform, pluginId, env, envDelete}`。省略 `env` 保留账号现值，`{}` 清空，非空对象只设置列出的键并保留其余键。`envDelete` 在合并后删除列出的键；同一个键同时出现在 `env` 和 `envDelete` 中返回 400，未知键名忽略，新账号从空值开始。合并结果仍受 64 个键、每个值 8192 字符的上限约束，保留的 `CHANNELD_*` 键继续被拒绝。服务端先完整校验，再原子写入 `<stateDir>/integrations/channeld.yml`（命令固定为 `adapter.command = ["node", <插件绝对路径>]`），最后通过 controller 重载。`inbound` 省略时保留现有路由，`[]` 清空，非空数组整体替换；来源账号不存在或平台不匹配返回 400。无效输入返回 400，旧运行时和旧托管配置保持不变；删除插件只会停止对应账号，成功重载后删除插件文件。在途投递仍按 `unknown` 处理。规则和入站编辑器默认 YAML，使用按需加载的 Monaco，支持 JSON/YAML schema 校验并把错误定位到行；鼠标滚轮在编辑器滚动边界会交给页面继续滚动；Monaco 加载失败时仍可使用纯文本输入框。由外部 `CHATROOM_CHANNELD_CONFIG` 启动的集成在停用前以只读方式展示，避免托管设置静默覆盖外部文件。

回滚：关闭 Channel D、停止服务、删除 `channeld.sqlite`（连同 WAL/SHM）。房间消息、文件和回执不受影响。需要完全隔离时可以把 `server.channeld.stateFile` 指到其他路径，但不能是房间数据库。

限制：adapter 必须走 stdio 的换行分隔 JSON-RPC，stdout 只放协议帧，日志写 stderr；一个 adapter 进程对应一个账号。adapter 崩溃或输出非法帧时只暂停该账号，并把在途投递标为 `unknown`；重启会恢复遗留的 in-flight 行，`unknown` 需显式重试。飞书出站可用；入站需要 `FEISHU_INBOUND=1`、`FEISHU_INBOUND_CHATS`、`im.message.receive_v1` 长连接订阅，以及 channeld 配置中的 `inbound` 路由。飞书群里的 `text`/`post`/`image`/`file` 消息会按事件和目标写成一条房间系统通知，按事件 ID 幂等，且不会匹配出站规则；附件会导入房间资源。消息里 `[[resource:…]]` 标记的房间图片和文件会以飞书原生 image/file 消息转发（图片 10 MiB、文件 30 MiB），卡片正文会去掉标记。adapter 只在房间写入提交后 ACK；写入失败会回滚事件，让飞书重试。没有 exactly-once，也不会自动重试 `unknown` 出站结果。飞书消息 `uuid` 去重窗口只有一小时，超过窗口再重试多段投递可能重复发送。

### 受保护房间（加入审核）

群组房间可以要求新身份先通过审核才能加入。创建房间时传入 `joinPolicy: "approval"`，或之后在房间的“编辑房间”对话框中切换；默认值为 `"open"`。人类创建者作为 owner 立即加入。只有人类可以拥有房间，因此请从网页或另一个人工会话创建审核房间；由 Agent 创建的审核房间没有人类 owner，无法审核加入申请。在审核房间中，其他人类或 Agent 调用 join 只会生成待审请求，不会成为成员：没有成员身份，也不会收到 inbox 投递；在获批前，网页无法打开房间、发送消息或轮询。在网页房间列表中点击审核房间会先弹出确认，取消则不会发送申请。使用房间内已存在的名称加入会返回 HTTP 409。待审核的 join 会返回 HTTP 202，响应体为 `{ status: "pending", message: "…" }`；应展示这条 message，而不是把它当作加入成功。

房间 owner 和受托的人类管理员可以列出、批准或拒绝全部待审请求。被指定的管理 Agent 只能列出并处理 Agent 的请求，不能批准人类请求。批准时按请求中记录的身份原子地创建成员关系；拒绝会删除该请求，申请人可以重新申请。待审请求不会自动过期：在被批准、拒绝、申请人主动取消或房间改为开放前会一直保留。把策略切回 `"open"` 会清空待审请求。批准后，申请人的入房事件保持未读，因此具备后台投递的 Agent 客户端会在原会话上下文中收到通知；网页轮询状态接口，没有后台投递的客户端使用 `join_status` 查询。网页的“取消申请”按钮会通过下面的 DELETE 接口撤回待审请求。私聊不受影响。

HTTP：`GET /rooms/:roomId/join-requests?sessionID=…` 供人类管理员列出全部请求，或供被指定的管理 Agent 列出 Agent 请求；`POST /rooms/:roomId/join-requests/:requestSessionID/approve` 与 `.../deny` 接受 `{ sessionID }`；`DELETE /rooms/:roomId/join-requests?sessionID=…` 供申请人撤回自己的请求；`GET /rooms/:roomId/join-requests/status?sessionID=…` 为申请人返回 `pending`、`joined` 或 `none`。管理 Agent 使用 `admin` 工具的 `admin_join_requests`、`admin_approve_join` 和 `admin_deny_join` 操作。

审核约束的是正常加入流程，不改变身份模型。人类与 Agent 由客户端声明的字段区分，而持有共享服务器令牌的人本来就能读写和管理所有房间。不要把审核房间当作对令牌持有者伪装身份的防护。

### 问题消息

Agent 可调用 `room`，传入 `action: "send"`、`roomId`、`text` 和 `isQuestion: true` 发送问题。网页发送前勾选“问题”；可以在“问题”面板回答，也可以直接回复问题消息。回答保存成功后，问题移出待回答列表，问题和回答仍保留在历史记录中。新问题到达或被回答后，页面上的问题数字和房间列表标记立即更新，不需要先打开问题面板。

`GET /rooms/:roomId/questions` 返回 `{ questions }`，按时间从旧到新排列，包含可视历史窗口以外的未回答问题。`POST /rooms/:roomId/questions/:questionID/answers` 接受 `{ sessionID, text }`，返回 `{ questionID, answer }`。服务端要求当前房间成员身份，并原子保存回答和已回答状态；并发重复回答返回 HTTP 409。问题包含 `isQuestion`，回答后增加 `answeredByMessageID`；回答包含 `answerToMessageID`。接口沿用共享令牌，不提供独立的人类身份认证。

### 房间提醒

房间成员可在网页房间头部管理提醒；Agent 可通过 `room` 的 `reminder_create`、`reminder_list`、`reminder_update` 和 `reminder_delete` 操作管理。提醒支持一次性时间或五字段 CRON 表达式，模板可使用 `{{time}}`、`{{initiator}}` 和 `{{room}}`。到期时服务器向房间发送系统消息；错过的周期合并为一条，一次性提醒在服务器恢复后补发一次。创建者离房后提醒继续，删除房间时提醒一并删除。

时区默认使用服务器时区，也可指定 IANA 时区。未带偏移的一次性时间按指定或服务器时区解释；带 `Z` 或偏移的时间表示明确时刻，指定的时区用于显示。夏令时中不存在或有歧义的本地时间会被拒绝，可用明确偏移指定时刻。提醒管理沿用共享令牌及房间成员权限。

### 公告栏

公告是房间内持久保存的具名文档，适合记录共享背景、决策和交接。网页通过 **选项 → 公告** 打开，网页和 Agent 均可管理公告。同一房间内名称唯一且区分大小写，去除首尾空白后最多 64 个 Unicode 字符；内容最多 5000 个 Unicode 字符。同名写入更新原公告，并发写入以最后保存的内容为准。

读取任意房间的公告无需加入房间，沿用服务器现有访问凭证；修改和删除要求已有房间成员身份。删除房间时一并删除公告。共享 token 不代表独立用户身份。

### 房间任务

房间任务是群组房间内的轻量任务板。网页通过 **选项 → 任务** 打开。窗口足够宽且足够高时，任务板固定显示在会话右侧；窄屏或矮屏改为弹窗。任务包含标题、描述、可选负责人、状态（待办、进行中、完成）、创建人、更新时间、可选截止日期、参与人员列表、完成步骤和结论文本。成员可以查看和新建；创建者可修改或删除自己的任务及步骤；负责人可以修改状态或勾选步骤；人类房间管理员可管理房间内的全部任务。面板顶部的 **清除已完成** 会删除当前用户有权管理的已完成任务。私聊房间不支持任务。每个房间默认最多 10 个任务；可在服务器上设置 `CHAT_ROOM_MAX_ROOM_TASKS` 调整上限。达到上限后新建返回 409，需要先删除一个已完成的任务再添加。

成员接口为 `GET /rooms/:roomId/tasks?sessionID=…`、`POST /rooms/:roomId/tasks`、`PATCH /rooms/:roomId/tasks/:taskId` 和 `DELETE /rooms/:roomId/tasks/:taskId`。`GET /rooms/:roomId/tasks` 返回 `{ tasks, limit }`，其中 `limit` 是当前房间的任务上限。`DELETE /rooms/:roomId/tasks` 配合 `{ sessionID }` 清除已完成任务并返回 `{ ok: true, count }`。新建发送 `{ sessionID, title, description?, assignee?, dueDate?, participants?, conclusion?, steps? }`，更新只发送需要修改的字段；`dueDate` 为 `YYYY-MM-DD` 或空字符串，`participants` 使用当前参与者名称；更新时可以保留任务里已有、但后来离开房间的参与人员或负责人，每个步骤是一段文字或 `{ text, done }`。空值会清除对应字段，负责人为空表示未指派。删除房间时任务一并删除，任务变更不会发送系统消息。

Agent 使用 `room` 的 `task_list`、`task_create`、`task_update` 和 `task_delete` 操作。对象形式的步骤始终包含布尔值 `done`；`task_list` 会显示创建人、负责人、截止日期、参与人员、步骤进度和结论。

### 消息寻址

`POST /rooms/:roomId/messages` 返回更新后的房间对象，而不是单独的新消息；客户端需要从 `messages` 中定位新行（`room` 工具和 TUI 都这样处理）。`GET /rooms/:roomId/messages/:messageId?sessionID=…` 返回单条消息，包含父消息和附件 ID；已撤回消息只返回墓碑和 `unavailable: "recalled"`。`GET /rooms/:roomId/catch-up?sessionID=…&afterSeq=…&limit=…` 按游标升序读取已持久化历史，并返回 `nextCursor`、`hasMore`、未读提及和未回答问题。两个接口都要求当前成员身份；房间不符、消息不存在或非成员统一返回 404；catch-up 只读，绝不调用模型。

### 消息撤回

`room` 传入 `action: "recall"`、`roomId` 和 `messageId` 可撤回消息。发送该消息的会话可以撤回自己的消息；人类房间管理员可以撤回其管理房间内的任意消息。网页在群组房间中提供管理员撤回；私聊中只提供撤回自己的消息，已撤回的消息可“查看原文”。房间通知由服务器发出，不能撤回。

撤回会从正常历史、未读投递、回复和待回答问题列表中隐藏该消息；重复撤回同一条消息不会报错。消息行、作者和原文仍保留：当前成员可通过 `GET /rooms/:roomId/messages/:messageId/content?sessionID=…` 查看原文，撤回接口为 `POST /rooms/:roomId/messages/:messageId/recall`，接受 `{ sessionID }`。因此撤回不等于保密删除：已经进入 Agent 上下文、已发出的通知或已下载的附件都无法收回。

### Mermaid 图示

在消息中发送标记为 `mermaid` 的 Markdown 围栏代码块即可渲染图示。渲染库随服务器本地提供，不把图示源码发送到外部服务。语法错误时保留可读源码和错误提示，不影响其他消息内容。严格安全模式禁用可执行链接与 HTML 标签。整条消息仍受 5000 字符限制；渲染时检查语法，发送前暂不强制校验。图示使用当前明暗主题的配色，切换主题或语言时就地重新渲染。点击消息或 Markdown 预览里的图，或聚焦后按 Enter，会打开全屏查看器：缩放按钮、滚轮缩放、拖动平移、双击复位，Esc 或点背景关闭。

最近看过的房间图片会由 Service Worker 缓存，加快重复加载和离线显示。媒体缓存与带版本的界面缓存分开，上限 80 条 / 64 MiB，30 天过期；按浏览器身份的哈希分区，切换 token 或身份时清空。命中时保留原始内容类型以及 `nosniff` 和沙箱 CSP 头。聊天消息和房间数据永不从这个缓存返回。

### 代码块

其他围栏代码块由懒加载的 Shiki bundle 在本地高亮，覆盖 16 种语言（含 TSX 和 JSX）；未标记或语言不支持时保持纯文本。明暗主题复用同一套代码颜色变量，bundle 被拦截或加载失败时回退为转义后的纯文本。代码块在悬停或键盘聚焦时显示浮动的语言名称和纯图标自动换行、复制按钮；触屏布局保持可见。长行在代码区域内部横向滚动。自动换行在横向滚动与折行显示之间切换，复制会写入完整原文。语言名称不会发送到外部服务。

### 文件与多媒体

网页支持附件按钮选择文件、向对话拖放文件，以及在输入框粘贴图片。文件先进入待发送区域，显示上传进度、重试和移除操作；确认后再发送，可仅发附件，也可附带文字。Markdown、纯文本、源码、PDF、Word（`.docx`）、Excel（`.xlsx`）和 PowerPoint（`.pptx`）资源可以在文档预览中打开：窗口较宽且较高时，右侧固定为阅读栏并压缩会话区域；窗口较窄或较矮时，改为带遮罩的弹窗。Office 预览按需加载且只读，上限 20 MiB：Word 渲染为格式化 HTML，Excel 按工作表渲染表格（每表最多 2,000 行、100 列），PowerPoint 渲染幻灯片；无法解析的文件仍可下载。所有文档预览都支持全屏；第一次 Esc 退出全屏，再次 Esc 关闭预览。阅读栏和弹窗都可用 Esc 或关闭按钮退出，Download 始终可用，关闭后焦点回到打开按钮或输入框。粘贴的文字保持纯文本，只有提及块是富元素；多行粘贴保留换行，但不会带入浏览器的块级富文本结构，删除提及时会一并替换掉触发它的 @。

切换房间不会把上传结果混入另一房间；消息发送失败时复用已上传的资源 ID。资源标记同样计入消息的 5000 字符限制。网页通过认证接口 `GET /resources/config` 读取当前单文件上限，实际上传仍由服务器最终校验。

未发送附件仅保留在当前页面，刷新后会清除。发送失败后，由失败消息记录保留资源引用供重试，不会同时留在两个可发送草稿中。超限文件重试时会刷新服务器限制。代码块仍可选择文本，工具栏提供自动换行和复制。

中心模式下，Agent 调用 `room`，传入 `action: "upload_resource"`、`roomId` 和本地 `filePath`。插件先申请文件读取权限，再流式上传，返回资源信息和 `[[resource:资源UUID]]` 标记。将标记原样放入普通 `send` 消息即可分享；只有消息中包含该完整标记时附件才会渲染。上传本身不会发送消息或自动加入房间。

获取房间附件时，调用 `room` 并传入 `action: "read_resource"`、`roomId` 和标记中的 UUID（`resourceId`）。标记本身只包含资源 UUID，因此必须同时提供房间 UUID。缺少或参数无效时，工具会指出具体字段以及获取方式，例如房间列表、send 或 poll 返回的消息 ID、资源标记。工具将附件保存到私有临时文件并返回路径，不暴露服务器令牌；Agent 可自行决定是否读取该文件。单个附件上限为 512 MiB 和服务器配置上限中的较小值；无法获取服务器上限时使用 512 MiB 安全上限。成功下载的文件会保留到手动删除或操作系统清理临时目录。资源访问仍使用服务器现有的共享令牌权限。

服务器默认单文件上限为 500 MiB（524288000 字节），通过服务器环境变量 `CHAT_ROOM_MAX_FILE_SIZE_MB` 统一调整。上传要求已有房间成员身份；读取沿用现有 token 配置，对外部署前应设置 `CHAT_ROOM_SERVER_TOKEN`。服务器按实际接收字节限制大小，不依赖请求声明的长度。

网页支持识别到的栅格图片、音频和视频的按需预览；点击图片会在对话上方打开查看器，缩放百分比按图片原始像素计算：大图先适配窗口，100% 表示一个图像像素对应一个 CSS 像素，重置回到适配大小，小图不会被放大。不在上述范围内的格式提供下载；SVG、HTML 不内嵌执行。播放能力取决于浏览器支持的编码。房间选项中的“文件”会打开整个房间的资源清单，显示名称、类型、大小、上传人和上传时间，并可按上传人筛选；成员可预览支持的媒体、下载任意文件，删除权限与角色一致。清单使用仅成员可访问的 `GET /rooms/:roomId/resources?limit=500&offset=0`，带 `x-session-id` 头，按时间倒序返回资源和总数；现有上传、元数据、内容与删除接口不变。资源存放在 SQLite 数据库旁的 `resources/<roomID>/`，备份时须同时保留。删除房间会清理其资源；未引用的上传文件保留到房间删除，暂不提供自动过期或总磁盘配额。

S3 兼容资源存储已在 0.8.1 稳定。设置 `CHAT_ROOM_STORAGE=s3` 可改用 S3 或兼容 S3 的存储。`CHAT_ROOM_S3_BUCKET`、`CHAT_ROOM_S3_ACCESS_KEY_ID` 和 `CHAT_ROOM_S3_SECRET_ACCESS_KEY` 为必填，`CHAT_ROOM_S3_ENDPOINT`、`CHAT_ROOM_S3_REGION`、`CHAT_ROOM_S3_FORCE_PATH_STYLE`、`CHAT_ROOM_S3_PREFIX` 和 `CHAT_ROOM_S3_LOCAL_CACHE` 为可选。对象键为 `<prefix>/<roomID>/<resourceID>`，默认前缀 `chat-room`。启动时执行 `HeadBucket`；桶不可用、凭证被拒或网络失败都会导致启动失败，S3 错误绝不会静默回退到本地存储。上传先写入本地临时文件，再写入 S3 对象，成功后才插入数据库记录，因此上传失败不会留下资源行。大小和 Range 校验始终以数据库记录为准。除非 `CHAT_ROOM_S3_LOCAL_CACHE` 为 `0`、`false` 或 `off`，文件会同时保留在 `resources/<roomID>/`；读取优先使用缓存，没有缓存时读取 S3，因此 S3 故障时已缓存文件仍可下载，而未缓存的读取会返回错误。最小 IAM 权限：`<prefix>/*` 上的 `s3:PutObject`、`s3:GetObject`、`s3:DeleteObject`，以及桶上的 `s3:ListBucket`、`s3:HeadBucket`。

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

这些功能需要中心服务器与客户端插件版本匹配：只更新客户端插件不会升级服务端。请先升级中心服务器、备份其 SQLite 数据库，再重新加载客户端插件。截断通知中完整且可唯一匹配的消息可以记录回执，截断或有歧义的消息不计完整已读；就绪回执每轮轮转上传最多八批，避免临时失败阻塞后续消息。

尚未实现图片消息；设计提案见[图片消息方案](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/image-messages-plan.md)。

每台客户端机器上：

```bash
export CHAT_ROOM_SERVER_URL=http://<服务器IP>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # 仅当服务器设置了 token 时
```

之后正常启动 opencode。房间状态存放在中心服务器；客户端只需出站连接，**不需要放行入站端口，也不需要 `--hostname`**。

## 环境变量

| 变量 | 使用方 | 说明 | 默认值 |
|---|---|---|---|
| `CHAT_ROOM_CONFIG` | 全部 | 显式指定配置文件路径；文件必须存在 | 自动查找第一个 `chatroom.*` |
| `CHAT_ROOM_SERVER_URL` | 客户端 | 中心服务器地址；设置后即进入中心模式 | 未设置（单机模式） |
| `CHAT_ROOM_SERVER_TOKEN` | 双端 | 中心服务器的 Bearer 认证令牌（可选） | 无（开放） |
| `CHAT_ROOM_CHANNELD` | 服务器 | 设为 `1` 或 `true` 时启用 Channel D；覆盖 `server.channeld.enabled` | 关闭 |
| `CHAT_ROOM_CHANNELD_CONFIG` | 服务器 | Channel D 的 YAML/JSON 配置路径；启用时必填 | 未设置 |
| `CHATROOM_ALLOW_ADMIN` | 服务器 | 设为 `true` 时开放“设置 → 平台集成”及集成管理 API | 关闭 |
| `CHAT_ROOM_STORAGE` | 服务器 | 资源存储后端：`local` 或 `s3`；为 `local` 时忽略 S3 设置 | `local` |
| `CHAT_ROOM_S3_BUCKET` | 服务器 | 资源对象所在存储桶；storage 为 `s3` 时必填 | 未设置（必填） |
| `CHAT_ROOM_S3_ACCESS_KEY_ID` | 服务器 | S3 访问密钥 ID；storage 为 `s3` 时必填 | 未设置（必填） |
| `CHAT_ROOM_S3_SECRET_ACCESS_KEY` | 服务器 | S3 访问密钥；storage 为 `s3` 时必填，不会写入日志 | 未设置（必填） |
| `CHAT_ROOM_S3_ENDPOINT` | 服务器 | 自定义 S3 端点，用于 RustFS、MinIO 等兼容存储 | 未设置（AWS） |
| `CHAT_ROOM_S3_REGION` | 服务器 | S3 签名区域 | `us-east-1` |
| `CHAT_ROOM_S3_FORCE_PATH_STYLE` | 服务器 | 使用 path-style 桶地址；取值 `true` 或 `false` | 设置 endpoint 时为 `true` |
| `CHAT_ROOM_S3_PREFIX` | 服务器 | 资源对象的键前缀 | `chat-room` |
| `CHAT_ROOM_S3_LOCAL_CACHE` | 服务器 | 在本地保留 S3 对象缓存；`0`、`false` 或 `off` 关闭 | `1` |
| `HOST` | 服务器 | 主机名别名，仅在未设置 `CHAT_ROOM_SERVER_HOST` 时使用 | 未设置 |
| `CHAT_ROOM_SERVER_PORT` | 服务器 | 中心服务器监听端口；优先于 `PORT` | `4399` |
| `PORT` | 服务器 | 端口别名，仅在未设置 `CHAT_ROOM_SERVER_PORT` 时使用 | 未设置 |
| `CHAT_ROOM_STATE_DIR` | 单机模式 | SQLite 数据库及迁移源 JSON 文件所在目录；必须位于本地文件系统 | `~/.config/opencode/chat-room/` |
| `CHAT_ROOM_DATABASE_URL` | 服务器 | 实验性多实例 PostgreSQL 状态后端的连接 URL；留空则使用 SQLite | 未设置（SQLite） |
| `CHAT_ROOM_MAX_FILE_SIZE_MB` | 服务器 | 单文件上传上限，单位 MiB，必须为正数，按实际流式接收字节限制 | `500` |
| `CHAT_ROOM_MAX_ROOM_TASKS` | 服务器 | 每个房间的最大任务数，必须为正整数，启动时校验 | `10` |
| `OPENCODE_SERVER_PASSWORD` | 双端 | opencode 服务器密码；跨会话推送时用作 Basic 认证 | 无 |
| `CHAT_ROOM_WAKE_SERVE_URL` | 客户端 | 可选的 OpenCode serve 地址，用于兜底唤醒被提及的非活动会话 | 未设置 |

`CHAT_ROOM_STORAGE=s3` 时，缺少任一必填 S3 变量都会阻止启动，并在错误中指明变量名；服务器开始监听前会检查配置的存储桶。为 `local` 时所有 S3 变量都会被忽略。`CHAT_ROOM_MAX_ROOM_TASKS` 无效时同样会阻止启动。凭证值不会写入日志。

## 通知机制

- **单机模式**：V1 向已注册会话的服务发送异步 prompt；V2 轮询共享本地状态，并通过持久会话 API steer 通知。只有宿主接受通知后才推进水位。
- **中心模式**：会话拉取 inbox（`GET /inbox?sessionID=…`），并通过宿主 API steer `<notification>`。消息按房间分组；V1 异步接受或 V2 成功接收后，才推进该房间的投递水位。
- 单机 V1 HTTP 推送尝试会追加到 `notify.log`（`OK <状态码> <URL>` / `FAIL <原因>`）；V2 推送目前不会写入该日志。
- 每条符合条件的通知只尝试一次后台操作。失败会写入进程诊断信息，但不会阻止 steer；消息投递重试与后台操作无关。会话级接口无法保证移走特定任务，后台操作也不会取消现有工作。

## 工具参考

管理员房间及 Agent 授权见 [管理员房间说明](administrator-rooms.md)。派发任务请使用房间消息，定时派发请使用房间提醒。管理员由房间 owner 指定，普通房间 token 不授予管理员权限。

| 操作 | 参数 | 结果 |
|---|---|---|
| `create` | `name`（必填），可选 `joinPolicy` | 创建房间；创建者成为 owner 及第一名成员。`joinPolicy: "approval"` 使后续加入需要审核（仅中心模式） |
| `join` | `roomId`、`name`（必填） | `name` 是 Agent 自己的显示名称，不是房间名；同身份重复加入是幂等的。审核房间返回待审请求，不授予成员身份 |
| `join_status` | `roomId`（必填） | 报告当前会话的 `pending`、`joined` 或 `none` |
| `leave` | `roomId`（必填） | 离开房间并注销推送目标 |
| `list` | — | 全部房间及成员数 |
| `send` | `roomId`、`text`（必填，≤5000）、可选 `isQuestion`、`parentMessageId`、`clientMessageID` | 存储消息并推送给其他成员。父消息必须在同一房间且未撤回；`clientMessageID` 用于重试去重。父消息和客户端 ID 仅中心模式支持 |
| `get_message` | `roomId`、`messageId` | 返回单条消息的作者、序号、父消息、资源 ID 和撤回状态；已撤回消息返回 `unavailable: "recalled"`，不泄露正文和资源。仅中心模式 |
| `catch_up` | `roomId`、可选 `afterSeq`、`limit` | 按序号升序读取游标之后的持久化消息，返回 `nextCursor`、`hasMore`、未读提及和未回答问题。`limit` 1–200，默认 50；严格只读。仅中心模式 |
| `poll` | `roomId`（必填） | 只返回未读消息（跳过已推送的） |
| `recall` | `roomId`、`messageId`（必填） | 软撤回消息：自己的消息，或作为人类管理员撤回其管理房间内的任意消息。房间通知不能撤回。原文仍对当前成员可查看 |
| `members` | `roomId`（必填） | 成员名单 |
| `upload_resource` | `roomId`、`filePath` | 中心模式下上传本地文件并返回资源标记；需要成员身份和文件读取授权 |
| `read_resource` | `roomId`、`resourceId` | 将附件保存到私有临时文件并返回路径；需要成员身份 |
| `delete_resource` | `roomId`、`resourceId` | 删除已上传的资源；人类管理员可删除任意资源，Agent 只能删除自己上传的 |
| `announcement_list` | `roomId` | 无需加入即可列出公告 |
| `announcement_read` | `roomId`、`announcementName` | 无需加入即可读取具名公告 |
| `announcement_write` | `roomId`、`announcementName`、`content` | 创建或替换具名公告；需要成员身份 |
| `announcement_delete` | `roomId`、`announcementName` | 删除公告；需要成员身份 |
| `reminder_list` | `roomId` | 列出房间提醒；需要成员身份 |
| `reminder_create` | `roomId`、`text`、`schedule` | 创建提醒；需要成员身份 |
| `reminder_update` | `roomId`、`reminderId`，以及 `text`、`schedule`、`paused` 中至少一项 | 更新现有提醒 |
| `reminder_delete` | `roomId`、`reminderId` | 删除提醒 |
| `task_list` | `roomId` | 列出房间任务；需要成员身份 |
| `task_create` | `roomId`、`title`，可选 `description`、`assignee`、`dueDate`、`participants`、`conclusion`、`steps` | 创建待办任务；需要成员身份 |
| `task_update` | `roomId`、`taskId`，以及 `title`、`description`、`assignee`、`status`、`dueDate`、`participants`、`conclusion`、`steps` 中至少一项 | 更新任务；创建者或人类管理员可改字段，负责人可改状态或勾选步骤 |
| `task_delete` | `roomId`、`taskId` | 删除任务；创建者或人类管理员可删除 |

注意：`join` 时带 `name:"alice"` 会把该会话在该房间的身份注册为 `alice`；之后的 `send`/`leave` 自动使用该身份。`join` 必须提供非空名称。用新名称再次 `join` 会退役该会话之前的身份（除非另一个会话仍在使用旧名称）；历史消息保留原作者名，受保护房间可能需要重新审核。问题消息和具名加入需要匹配的中心服务器与客户端插件版本。

## 已知限制

- 单机模式通过 SQLite WAL 和跨进程事务保存状态。数据库必须位于本地文件系统；多主机场景请使用中心模式，不要共享 WAL 数据库目录。
- 同一台机器的会话共享 `user@host` 身份；用不同的 `name` 加入以区分成员。
- 中心服务器不设 `CHAT_ROOM_SERVER_TOKEN` 时无认证——任何能访问端口的人都能读写房间。服务端另有输入限制：房间/成员名 ≤ 64 字符、消息文本 ≤ 5000 字符（超限返回 400）。
- SQLite 持续保留历史消息，不自动删除，但每个房间最多保留 1,000,000 条，超过后裁剪最旧的记录。网页每个打开的房间在内存中最多保留 5,000 条消息，向上滚动时加载更早的分页；未读消息和历史记录均分页读取。请定期备份数据库。
- 仅包含某个过渡开发版重试记录的安装会受影响：若旧后台重试记录无法恢复消息时间戳，迁移会采取保守处理，永久停用该服务/房间的后台操作；正常通知 steer 仍会继续。
- `notify.log` 会持续增长，暂无轮转。
- 已修复 Edge/macOS 中复现的 500 条消息窗口滚动导致文本选区丢失问题：轮询时保留仍在窗口内的消息行，只清除窗口外的行。浏览器测试覆盖轮询及裁剪过程中保持选区；未在实体 Windows 设备上测试，也不代表其他选区问题均已解决。
