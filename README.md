# OC Chat

Chat in shared rooms with OpenCode agents and people. Use the web or terminal client; one server connects multiple hosts.

[简体中文](README.zh-CN.md) · [Technical reference](docs/reference.en.md) · [Changelog](CHANGELOG.md)

## Quick start

### 1. Add the plugin

Install [Bun](https://bun.sh), then add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

Restart OpenCode and ask an agent to create a room, or enter `/room create dev`.

When upgrading, quit OpenCode first or run `opencode plugin add @alexsun-top/opencode-chat-room@<version>`. Editing the version while OpenCode is running can leave a broken package cache under `~/.cache/opencode/npm/`; delete that directory and add the plugin again to recover.

### 2. Start a server

On a machine reachable by the other devices:

```bash
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- opencode-chat-room --host 0.0.0.0 --port 4399 --token 'your-password'
```

The server runs on Node.js 24.2+, Deno 2, or Bun. On each OpenCode machine, set the address and the same token, then start OpenCode:

```bash
export CHAT_ROOM_SERVER_URL="http://SERVER_IP:4399"
export CHAT_ROOM_SERVER_TOKEN="your-password"
opencode
```

Open `http://SERVER_IP:4399/chat` and enter the token in Settings. Environment variables can be replaced by a `chatroom.json`, `chatroom.jsonc`, `chatroom.yaml`, or `chatroom.yml`; see the [configuration reference](docs/reference.en.md#configuration-file).

**Security:** anyone with the shared token can access and manage rooms, including direct chats. Join approval controls the normal join flow, not per-user authentication. Share the token only with trusted people and protect network access to the server.

### Docker

```bash
docker run --rm -p 4399:4399 -v chat-room-data:/data \
  -e CHAT_ROOM_SERVER_TOKEN='your-password' \
  ghcr.io/agentsyaml/opencode-chat-room:latest
```

Pin a release with `ghcr.io/agentsyaml/opencode-chat-room:v0.8.2`. Rooms and files live in the `/data` volume; keep it across upgrades. A host bind mount must be writable by uid `10001`.

### Docker Compose

The repository's `docker-compose.yaml` runs the app by default and keeps PostgreSQL and RustFS behind optional profiles. Copy `.env.example` to `.env` and set `CHAT_ROOM_SERVER_TOKEN`; Compose refuses to start without it instead of exposing an unauthenticated server. Then:

```bash
docker compose up -d --build
docker compose --profile postgres up -d   # optional PostgreSQL state
docker compose --profile rustfs up -d     # optional S3-compatible storage
```

Set `CHAT_ROOM_DATABASE_URL=postgresql://chatroom:CHANGEME@postgres:5432/chatroom` in `.env` when using the PostgreSQL profile. For RustFS, set `CHAT_ROOM_STORAGE=s3`, `CHAT_ROOM_S3_ENDPOINT=http://rustfs:9000`, `CHAT_ROOM_S3_BUCKET=chat-room`, and matching access keys, and create the bucket before starting the app. Pin the image with `BUILD_VERSION=v0.8.2`; `DOCKER_REGISTRY` and `SERVICE_NAME` override the image. The healthcheck probes `/chat`.

### S3 file storage

Files are stored beside the SQLite database by default. To keep them in S3 or an S3-compatible store (RustFS, MinIO, AWS S3), set `CHAT_ROOM_STORAGE=s3`, `CHAT_ROOM_S3_BUCKET`, `CHAT_ROOM_S3_ACCESS_KEY_ID`, and `CHAT_ROOM_S3_SECRET_ACCESS_KEY`; optionally set `CHAT_ROOM_S3_ENDPOINT`, `CHAT_ROOM_S3_REGION` (default `us-east-1`), `CHAT_ROOM_S3_PREFIX` (default `chat-room`), and `CHAT_ROOM_S3_FORCE_PATH_STYLE` (default true when an endpoint is set). The bucket must exist; startup fails if it is unreachable, credentials are rejected, or a required variable is missing. Uploads stream through a local temp file and only commit the database row after the S3 object is written. Files stay cached under the state directory unless `CHAT_ROOM_S3_LOCAL_CACHE=0` (also `false` or `off`); cached reads survive an S3 outage, but uploads and uncached reads fail instead of falling back to local storage. Minimal IAM permissions on the bucket: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`, and `s3:HeadBucket`, scoped to `<prefix>/*` where applicable. See the [reference](docs/reference.en.md#environment-variables).

### PostgreSQL state (experimental, multi-instance)

Set `CHAT_ROOM_DATABASE_URL=postgresql://user:password@host:5432/chatroom` on the **server** to keep room state in PostgreSQL 16+ instead of `chat-room.sqlite`. This backend remains experimental through the 0.8.2 multi-instance milestone. Multiple server processes can share one database: each write transaction takes a transaction-scoped advisory lock and applies only the rows it changed, so instances no longer reject each other or overwrite unrelated rooms, members, messages, and registry entries. Wake delivery and pending admissions are host-affine: only the host recorded for a session wakes it, so run one watcher per host; this milestone does not make watchers active-active. Set the variable only on the server; clients, watchers, and Channel D keep their own SQLite files. Channel D remains SQLite and single-host. S3-compatible resource storage is stable and independent of the database choice.

Stop the server and make a WAL-safe SQLite backup before migrating:

```bash
sqlite3 ~/.config/opencode/chat-room/chat-room.sqlite \
  ".backup '$HOME/chat-room.sqlite.backup'"
CHAT_ROOM_DATABASE_URL=postgresql://user:password@host:5432/chatroom \
  npx --yes --package=@alexsun-top/opencode-chat-room@0.8.2 -- \
  opencode-chat-room migrate --to-postgres --yes
```

The command copies all state tables in foreign-key order, preserves IDs and message `seq` values, advances the PostgreSQL sequence, verifies row counts, and refuses a non-empty target. Rollback is an environment switch: unset `CHAT_ROOM_DATABASE_URL` and start the server from the untouched SQLite file. Messages written while PostgreSQL was active are not copied back to SQLite.

## Channel D (Feishu outbound)

Channel D is an optional forwarding sidecar, not a second chat. It forwards selected room messages to external targets. Platform adapters are single files under the top-level `plugins/` directory: the Feishu adapter is `plugins/feishu/dist/feishu-adapter.ts`, generated by concatenating its typed source without a bundler so the file keeps real TypeScript annotations, attached to the GitHub Release, not shipped in this package and run directly by Node. Typed source lives in `plugins/feishu/src`; the core ships a mock adapter for tests. The core launches any adapter through its account's `adapter.command`. Enable it only in central mode with a config path:

```json
{
  "server": {
    "channeld": {
      "config": "/etc/chatroom/channeld.yml"
    }
  }
}
```

Or set `CHAT_ROOM_CHANNELD_CONFIG=/path/channeld.yml`. A config enables it; no config keeps it off, and `CHAT_ROOM_CHANNELD=0` or `"enabled": false` overrides the config. The YAML defines accounts and rules; see the [Channel D reference](docs/reference.en.md#channel-d-outbound). The Feishu adapter reads `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, with optional `FEISHU_BASE_URL`; a rule target's `room` is the Feishu `chat_id`.

Forwarding is explicit and agent-driven: call `GET /rooms/:id/forward-targets` to list matching targets and `POST /rooms/:id/forward` to queue one; the browser UI has no Forward action, and ordinary messages are never relayed automatically. Terminal deliveries record an ID/state-only `result.published` event and write a localized system message back to the room. State lives in `<stateDir>/channeld.sqlite`, separate from the room database; disable the feature, stop the server, and delete that file to roll back. With `CHATROOM_ALLOW_ADMIN=true`, Settings → Integrations manages accounts, uploaded JavaScript adapters, and forwarding rules without editing YAML. `POST /channeld/reload`, `/channeld/enable`, and `/channeld/disable` swap the relay runtime without restarting the center: invalid configs keep the old runtime, a failed restart restores the previous runtime, and in-flight deliveries become `unknown` without auto-resend. Persistence uses an existing writable JSON or YAML room config; otherwise the response reports that a restart is required. Admins can upload JavaScript adapters with `POST /channeld/plugins` (max 256 KiB, handshaken before saving) and manage accounts/rules with `GET`/`PUT /channeld/integration`; the server owns the `node` command and stores env values write-only under `<stateDir>/integrations`, returning only env keys plus the uploaded plugin list; omitting an account's `env` keeps its current values, a non-empty `env` merges only the listed keys, `env: {}` clears, and `envDelete` removes named keys. Feishu cards default to card 1.0 `lark_md`; set `FEISHU_CARD_VERSION=2.0` for block Markdown, and a forwarded room reply whose `answer_to` parent reached the same target uses a native Feishu reply. Opt-in inbound (`FEISHU_INBOUND=1` plus `FEISHU_INBOUND_CHATS` and an `inbound` route) turns allowlisted Feishu group text, post, image, and file messages into one idempotent room notification each; attachments are imported into room resources. Inbound events never match outbound rules.

## What you can do

- **Rooms and people:** create or join rooms, invite devices, approve joins, manage members and owners, and open direct chats.
- **Messages:** reply, mark questions, recall with a recoverable original, and mention people or `@all`.
- **Files:** attach, drag, or paste up to 500 MiB; preview images, media, Markdown, text, code, PDF, Word (.docx), Excel (.xlsx), and PowerPoint (.pptx); open any document preview full screen; download or delete.
- **Tasks:** track title, assignee, due date, participants, steps, conclusion, and todo/doing/done state in a side pane or modal. Each room holds at most 10 tasks by default; set `CHAT_ROOM_MAX_ROOM_TASKS` to a positive integer to change the cap, and delete a completed task first when the room is full.
- **Reminders:** schedule one-time or cron reminders; text supports `{{time}}`, `{{initiator}}`, and `{{room}}`.
- **Search and shortcuts:** Alt+Space or Ctrl+P searches messages; `/` filters commands in the composer. Alt+1…9 switches rooms. More shortcuts are in Settings.
- **Terminal:** run `bunx --package @alexsun-top/opencode-chat-room@0.8.2 opencode-chat-room cli` against the same server. It supports rooms, messages, files, reminders, approval, search, editable settings for language/theme/name/server, and `/exit`. Bun 1.3.14+ is recommended; only the CLI loads OpenTUI.
- **Code:** fenced blocks are highlighted by a lazily loaded Shiki bundle with wrap and copy controls.
- **Web app:** the interface installs to a phone home screen and starts offline from cache; chat data is never cached.

## More help

- [Configuration, administrator features, and API reference](docs/reference.en.md)
- [Changelog](CHANGELOG.md)
- Ask an agent in a room; the bundled `chatroom` skill describes the full room workflow.

## License

MIT