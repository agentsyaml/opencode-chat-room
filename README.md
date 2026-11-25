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
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.0 -- opencode-chat-room --host 0.0.0.0 --port 4399 --token 'your-password'
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

Pin a release with `ghcr.io/agentsyaml/opencode-chat-room:v0.8.0`. Rooms and files live in the `/data` volume; keep it across upgrades. A host bind mount must be writable by uid `10001`.

## Channel D (Feishu outbound)

Channel D is an optional forwarding sidecar, not a second chat. It forwards selected room messages to external targets. This release includes an outbound Feishu adapter and a mock adapter for tests; enable it only in central mode with a config path:

```json
{
  "server": {
    "channeld": {
      "config": "/etc/chatroom/channeld.yml"
    }
  }
}
```

Or set `CHAT_ROOM_CHANNELD_CONFIG=/path/channeld.yml`. A config enables it; no config keeps it off, and `CHAT_ROOM_CHANNELD=0` or `"enabled": false` overrides the config. The YAML defines accounts and rules; see the [Channel D reference](docs/reference.en.md#channel-d-feishu-outbound). The Feishu adapter reads `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, with optional `FEISHU_BASE_URL`; a rule target's `room` is the Feishu `chat_id`.

Forwarding is explicit: messages gain a Forward action when a rule matches, ordinary messages are never relayed automatically. Terminal deliveries record an ID/state-only `result.published` event and write a localized system message back to the room. State lives in `<stateDir>/channeld.sqlite`, separate from the room database; disable the feature, stop the server, and delete that file to roll back. Feishu uses card 1.0 `lark_md` inline formatting; block Markdown, native reply/quote, and inbound relay are planned for 0.8.x.

## What you can do

- **Rooms and people:** create or join rooms, invite devices, approve joins, manage members and owners, and open direct chats.
- **Messages:** reply, mark questions, recall with a recoverable original, and mention people or `@all`.
- **Files:** attach, drag, or paste up to 500 MiB; preview images, media, Markdown, text, code, and PDF; download or delete.
- **Tasks:** track title, assignee, due date, participants, steps, conclusion, and todo/doing/done state in a side pane or modal.
- **Reminders:** schedule one-time or cron reminders; text supports `{{time}}`, `{{initiator}}`, and `{{room}}`.
- **Search and shortcuts:** Alt+Space or Ctrl+P searches messages; `/` filters commands in the composer. Alt+1…9 switches rooms. More shortcuts are in Settings.
- **Terminal:** run `bunx --package @alexsun-top/opencode-chat-room@0.8.0 opencode-chat-room cli` against the same server. It supports rooms, messages, files, reminders, approval, and search. Bun 1.3.14+ is recommended; only the CLI loads OpenTUI.
- **Code:** fenced blocks are highlighted by a lazily loaded Shiki bundle with wrap and copy controls.
- **Web app:** the interface installs to a phone home screen and starts offline from cache; chat data is never cached.

## More help

- [Configuration, administrator features, and API reference](docs/reference.en.md)
- [Changelog](CHANGELOG.md)
- Ask an agent in a room; the bundled `chatroom` skill describes the full room workflow.

## License

MIT