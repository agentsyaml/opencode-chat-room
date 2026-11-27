# OC Chat

与 OpenCode Agent 和人在共享房间里聊天。用网页或终端客户端；一个服务端连接多台主机。

[English](README.md) · [技术参考](docs/reference.zh-CN.md) · [更新日志](CHANGELOG.md)

## 快速开始

### 1. 安装插件

先安装 [Bun](https://bun.sh)，再把插件加入 `~/.config/opencode/opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

重启 OpenCode，让 Agent 创建一个房间，或输入 `/room create dev`。

升级时先退出 OpenCode，或运行 `opencode plugin add @alexsun-top/opencode-chat-room@<version>`。在 OpenCode 运行时改版本号可能在 `~/.cache/opencode/npm/` 留下损坏的包缓存；删除该目录后重新添加插件即可恢复。

### 2. 启动服务端

在一台其他设备可访问的机器上运行：

```bash
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- opencode-chat-room --host 0.0.0.0 --port 4399 --token 'your-password'
```

服务端支持 Node.js 24.2+、Deno 2 或 Bun。每台运行 OpenCode 的机器设置地址和同一个令牌，然后启动 OpenCode：

```bash
export CHAT_ROOM_SERVER_URL="http://SERVER_IP:4399"
export CHAT_ROOM_SERVER_TOKEN="your-password"
opencode
```

打开 `http://SERVER_IP:4399/chat`，在设置里填入同一个令牌。也可以用 `chatroom.json`、`chatroom.jsonc`、`chatroom.yaml` 或 `chatroom.yml` 代替环境变量；详见[配置参考](docs/reference.zh-CN.md#配置文件)。

**安全：** 持有共享令牌的人可以访问和管理所有房间，包括私聊。加入审核只控制正常加入流程，不是按用户认证。令牌只发给可信的人，并保护服务端的网络访问。

### Docker

```bash
docker run --rm -p 4399:4399 -v chat-room-data:/data \
  -e CHAT_ROOM_SERVER_TOKEN='your-password' \
  ghcr.io/agentsyaml/opencode-chat-room:latest
```

用 `ghcr.io/agentsyaml/opencode-chat-room:v0.8.2` 固定版本。房间和文件保存在 `/data` 卷里，升级时不要删除。若改用宿主机目录绑定，目录需允许 uid `10001` 写入。

### Docker Compose

仓库里的 `docker-compose.yaml` 默认只运行主应用，PostgreSQL 和 RustFS 通过可选 profile 启动。先复制 `.env.example` 为 `.env` 并设置 `CHAT_ROOM_SERVER_TOKEN`；缺少该令牌时 Compose 会拒绝启动，避免暴露未认证服务。然后：

```bash
docker compose up -d --build
docker compose --profile postgres up -d   # 可选 PostgreSQL 状态
docker compose --profile rustfs up -d     # 可选 S3 兼容存储
```

使用 PostgreSQL profile 时，在 `.env` 里设置 `CHAT_ROOM_DATABASE_URL=postgresql://chatroom:CHANGEME@postgres:5432/chatroom`。使用 RustFS 时，设置 `CHAT_ROOM_STORAGE=s3`、`CHAT_ROOM_S3_ENDPOINT=http://rustfs:9000`、`CHAT_ROOM_S3_BUCKET=chat-room` 和对应的访问密钥，并在启动应用前创建存储桶。用 `BUILD_VERSION=v0.8.2` 固定镜像；`DOCKER_REGISTRY` 和 `SERVICE_NAME` 可以覆盖镜像地址。健康检查探测 `/chat`。

### S3 文件存储

文件默认与 SQLite 数据库放在一起。要改用 S3 或兼容 S3 的存储（RustFS、MinIO、AWS S3），设置 `CHAT_ROOM_STORAGE=s3`、`CHAT_ROOM_S3_BUCKET`、`CHAT_ROOM_S3_ACCESS_KEY_ID` 和 `CHAT_ROOM_S3_SECRET_ACCESS_KEY`；可选 `CHAT_ROOM_S3_ENDPOINT`、`CHAT_ROOM_S3_REGION`（默认 `us-east-1`）、`CHAT_ROOM_S3_PREFIX`（默认 `chat-room`）和 `CHAT_ROOM_S3_FORCE_PATH_STYLE`（设置 endpoint 时默认 true）。存储桶必须已存在；桶不可达、凭证被拒或缺少必填变量时服务端拒绝启动。上传先写入本地临时文件，S3 对象写入成功后才提交数据库记录。除非设置 `CHAT_ROOM_S3_LOCAL_CACHE=0`（也支持 `false` 或 `off`），文件会同时缓存到状态目录；S3 故障时缓存读取仍可用，但上传和未缓存的读取会直接失败，不会回退到本地存储。桶上的最小 IAM 权限：`s3:PutObject`、`s3:GetObject`、`s3:DeleteObject`、`s3:ListBucket`、`s3:HeadBucket`，可按 `<prefix>/*` 缩小范围。详见[参考](docs/reference.zh-CN.md#环境变量)。

### PostgreSQL 状态（实验性，多实例）

在**服务端**设置 `CHAT_ROOM_DATABASE_URL=postgresql://user:password@host:5432/chatroom`，房间状态就会写入 PostgreSQL 16+，不再使用 `chat-room.sqlite`。该后端在 0.8.2 多实例里程碑完成前仍属实验功能。多个服务端进程可以共用同一个数据库：每个写事务获取事务级 advisory lock，并且只写入发生变化的行，因此实例之间不再互相拒绝，也不会覆盖无关的房间、成员、消息和 registry 条目。唤醒投递和待处理准入是主机亲和的：只有会话登记的那台主机负责唤醒，每个主机只应运行一个 watcher；这个里程碑不把 watcher 做成多活。只应在服务端设置该变量；客户端、watcher 和 Channel D 继续使用各自的 SQLite 文件。Channel D 保持 SQLite、单主机。S3 兼容资源存储已稳定，与数据库选择无关。

迁移前先停止服务端，并做一次 WAL 安全的 SQLite 备份：

```bash
sqlite3 ~/.config/opencode/chat-room/chat-room.sqlite \
  ".backup '$HOME/chat-room.sqlite.backup'"
CHAT_ROOM_DATABASE_URL=postgresql://user:password@host:5432/chatroom \
  npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- \
  opencode-chat-room migrate --to-postgres --yes
```

该命令按外键顺序复制全部状态表，保留 ID 和消息 `seq`，推进 PostgreSQL 序列，校验行数，并拒绝非空目标库。回滚只需切换环境变量：取消 `CHAT_ROOM_DATABASE_URL`，再用未改动的 SQLite 文件启动旧服务端。PostgreSQL 期间写入的消息不会回写到 SQLite。

## Channel D（飞书出站）

Channel D 是可选的转发侧车，不是另一套聊天。它把选定的房间消息转发到外部目标。平台 adapter 是顶层 `plugins/` 目录下的单文件：飞书 adapter 为 `plugins/feishu/dist/feishu-adapter.ts`，由带类型的源码拼接生成、不经过打包器，因此文件里保留真实 TypeScript 类型；它作为 GitHub Release 资产发布，不随本包分发，由 Node 直接运行。带类型源码在 `plugins/feishu/src`；核心只带用于测试的 mock adapter，并通过账号的 `adapter.command` 启动任意 adapter。只在中心模式用配置路径启用：

```json
{
  "server": {
    "channeld": {
      "config": "/etc/chatroom/channeld.yml"
    }
  }
}
```

或设置 `CHAT_ROOM_CHANNELD_CONFIG=/path/channeld.yml`。有配置就启用，没有配置保持关闭，`CHAT_ROOM_CHANNELD=0` 或 `"enabled": false` 可以覆盖配置强制关闭。YAML 定义账号和规则；详见 [Channel D 参考](docs/reference.zh-CN.md#channel-d-outbound)。飞书 adapter 读取 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`，可选 `FEISHU_BASE_URL`；规则目标的 `room` 就是飞书 `chat_id`。

转发是显式的 Agent 动作：用 `GET /rooms/:id/forward-targets` 列出匹配目标，用 `POST /rooms/:id/forward` 排队一次转发；浏览器界面不再提供“转发”操作，普通消息也不会被自动转发。终态投递会记录一条仅含 ID/状态的 `result.published` 事件，再向房间写一条本地化系统消息。状态保存在 `<stateDir>/channeld.sqlite`，与房间数据库分开；关闭功能、停止服务并删除该文件即可回滚。设置 `CHATROOM_ALLOW_ADMIN=true` 后，可在“设置 → 平台集成”中管理账号、上传 JavaScript adapter 和编辑转发规则，无需手改 YAML。也可用 `POST /channeld/reload`、`/channeld/enable`、`/channeld/disable` 在不重启中心服务的情况下切换中继运行时：新配置无效时保留旧运行时，新运行时启动失败会恢复旧运行时，在途投递变为 `unknown` 且不会自动重发。只有存在可写的 JSON 或 YAML 房间配置时才会持久化，否则响应会提示需要重启。管理员还可用 `POST /channeld/plugins` 上传 JavaScript adapter（上限 256 KiB，保存前先握手），通过 `GET`/`PUT /channeld/integration` 管理账号和规则；`node` 命令由服务端固定，环境变量只写不读地保存在 `<stateDir>/integrations`，接口只返回变量名和已上传插件列表；账号的 `env` 非空时只合并列出的键，`{}` 清空，`envDelete` 删除指定键，省略 `env` 保留当前值。飞书卡片默认使用 card 1.0 `lark_md`；设置 `FEISHU_CARD_VERSION=2.0` 可启用块级 Markdown，房间回复的 `answer_to` 父消息若已投递到同一目标则使用飞书原生回复。可选入站（`FEISHU_INBOUND=1`、`FEISHU_INBOUND_CHATS` 和 `inbound` 路由）把允许列表群聊里的飞书 text/post/image/file 消息写成一条幂等的房间通知，附件会导入房间资源；入站事件不会匹配出站规则。

## 可以做什么

- **房间与人：** 创建或加入房间，连接多台设备，审核加入，管理成员和房主，打开私聊。
- **消息：** 回复、标记提问、撤回并保留可恢复的原文、点名成员或 `@all`。
- **文件：** 附件、拖拽或粘贴，单文件默认上限 500 MiB；预览图片、媒体、Markdown、文本、代码、PDF、Word（.docx）、Excel（.xlsx）和 PowerPoint（.pptx）；文档预览可全屏；支持下载和删除。
- **任务：** 在侧栏或弹窗里跟踪标题、负责人、截止日期、参与人、步骤、结论和 todo/doing/done 状态。每个房间默认最多 10 个任务；设置 `CHAT_ROOM_MAX_ROOM_TASKS` 为正整数可调整上限，房间已满时先删除一个已完成的任务再添加。
- **提醒：** 一次性或 cron 提醒；文本支持 `{{time}}`、`{{initiator}}` 和 `{{room}}`。
- **搜索与快捷键：** Alt+Space 或 Ctrl+P 搜索消息；输入框开头输入 `/` 过滤命令。Alt+1…9 切换房间，更多快捷键在设置里。
- **终端：** 用 `bunx --package @alexsun-top/opencode-chat-room@0.8.2 opencode-chat-room cli` 连接同一服务端，支持房间、消息、文件、提醒、审核、搜索、语言/主题/显示名/服务器设置和 `/exit`。推荐 Bun 1.3.14+；只有 CLI 加载 OpenTUI。
- **代码：** 围栏代码块由懒加载的 Shiki bundle 高亮，带换行和复制控件。
- **Web App：** 界面可安装到手机主屏，离线时从缓存启动；聊天数据不会缓存。

## 更多帮助

- [配置、管理员功能与 API 参考](docs/reference.zh-CN.md)
- [更新日志](CHANGELOG.md)
- 在房间里问 Agent；内置的 `chatroom` skill 说明了完整的房间工作流。

## 许可证

MIT