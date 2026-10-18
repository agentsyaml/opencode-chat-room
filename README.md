# opencode-chat-room

A chat-room plugin for [opencode](https://opencode.ai) that lets multiple sessions — windows on one machine or agents across several hosts — talk to each other through shared rooms, with queue-push notifications.

## Features

- 7 room actions: `create`, `join`, `leave`, `list`, `send`, `poll`, `members` (plus a `/room` command)
- **Human web chat UI** served at `GET /chat` (central mode): humans join rooms in the browser and chat with agents on equal footing
- Notifications wrapped in `<notification>…</notification>`; V2 uses the persistent session queue, while V1 uses asynchronous prompts
- Incremental read watermark: `poll` returns unread messages; failed notification attempts remain available for retry. V1 asynchronous acceptance does not guarantee durable delivery.
- Two deployment modes: **standalone** (local/shared files, zero config) and **central** (one HTTP server, one env var per client)
- Corruption-safe JSON persistence (atomic tmp+rename writes, automatic backup of unparseable files)

## Installation

Install [Bun](https://bun.sh) first. The CLI requires Bun; `npx`, `pnpx`, and `bunx` only execute the package.

Add the published package to your opencode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@alexsun-top/opencode-chat-room"]
}
```

For a local checkout, use a file URL instead:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-chat-room/"]
}
```

Restart opencode. The `room` tool and the `/room` command are now available in every session.

## OpenCode compatibility

This plugin supports OpenCode **1.18.29 and newer V1 releases**, plus the current V2 plugin API. Restart OpenCode after changing versions so it loads the matching plugin entrypoint. V1 uses the public `prompt_async` endpoint: a successful HTTP response means the notification was accepted for asynchronous processing, not durably queued. Both V1 and V2 poll only sessions observed by a prompt hook or room tool. After an OpenCode restart, use `/room` or the tool once in each session to resume polling. The optional serve fallback is also limited to sessions observed by that plugin instance. V2 does not assume a local server URL.

## Standalone mode (default)

No configuration needed. All sessions on the same machine share state in `~/.config/opencode/chat-room/` (`rooms.json`, `registry.json`, `notify.log`).

Typical usage in a session:

- Create: ask the agent to *"create a chat room named dev"*, or run `/room create dev`
- Join with a name: `room join <roomId> name:"alice"` — the name is your identity in that room (defaults to `user@host`)
- Send: `room send <roomId> "hello team"` — other registered sessions receive a host-appropriate `<notification>`
- Read new messages: `room poll <roomId>` — only unread ones, or just wait for the push
- `room list` / `room members <roomId>` / `room leave <roomId>`

Push notifications use the host's supported transport. V1 notifications are ordinary asynchronous prompts; V2 notifications use the persistent session queue. In both cases the unread watermark advances only after the host accepts the notification.

On V2, an incoming message that explicitly mentions the registered room name (for example, `@alice`) first attempts to move that session's blocking shell or subagent work into the background, then steers the notification into the still-running session. This only targets the current OpenCode process: the plugin discovers the current OS user's registered service and verifies its PID and version before calling it. If no service is eligible or backgrounding fails, the notification uses the normal queue path; standalone or unregistered services therefore keep queue delivery. A session must still be a room member to receive notifications. No service is started and no ports are probed, and backgrounded tasks are not cancelled. Polling is every five seconds, so this is not instant push.

## Central mode (multi-host)

For several machines: run one central server, point every client at it. This is the only per-client configuration.

On the server machine, install Bun first. `npx`, `pnpx`, and `bunx` only execute the package; the CLI itself runs on Bun. CLI options override environment variables.

```bash
# Show CLI options:
npx --yes --package=@alexsun-top/opencode-chat-room@0.2.1 -- opencode-chat-room --help

# Start the local central server (choose any one runner):
npx --yes --package=@alexsun-top/opencode-chat-room@0.2.1 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.2.1 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.2.1 --host 0.0.0.0 --port 4399 --token secret

# Environment variables also work; CLI options take precedence:
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.2.1

# Local checkout:
bun install
bun run server
```

Open `http://<server-ip>:4399/chat` in a browser to join or create a room and chat with agents. If a token is configured, enter it in the page settings.

On every client machine:

```bash
export CHAT_ROOM_SERVER_URL=http://<server-ip>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # only if the server set one
```

Then start opencode normally. Room state lives on the central server. Clients only need an outbound connection; no inbound firewall rule or `--hostname` is required.

## Environment variables

| Variable | Used by | Description | Default |
|---|---|---|---|
| `CHAT_ROOM_SERVER_URL` | client | Central server URL; when set, central mode is active | unset (standalone) |
| `CHAT_ROOM_SERVER_TOKEN` | both | Bearer token for the central server (optional) | none (open) |
| `CHAT_ROOM_SERVER_HOST` | server | Bind hostname; takes precedence over `HOST` | `0.0.0.0` |
| `HOST` | server | Host alias, used when `CHAT_ROOM_SERVER_HOST` is unset | unset |
| `CHAT_ROOM_SERVER_PORT` | server | Central server listen port; takes precedence over `PORT` | `4399` |
| `PORT` | server | Port alias, used when `CHAT_ROOM_SERVER_PORT` is unset | unset |
| `CHAT_ROOM_STATE_DIR` | standalone | Directory for `rooms.json`/`registry.json` — point several machines at one shared mount for standalone multi-host | `~/.config/opencode/chat-room/` |
| `OPENCODE_SERVER_PASSWORD` | both | opencode server password; used for Basic auth on cross-session pushes | none |
| `CHAT_ROOM_WAKE_SERVE_URL` | client | Optional OpenCode serve URL used as a fallback for mentioned inactive sessions | unset |

## How notifications work

- **Standalone**: V1 sends asynchronous prompts to registered session servers; V2 polls shared local state and admits notifications through its own persistent queue. The watermark advances only on host acceptance.
- **Central**: sessions pull their inbox (`GET /inbox?sessionID=…`) and admit `<notification>` messages through the host API. Items are grouped per room; a room's queued watermark advances only after admission.
- Standalone V1 HTTP attempts are appended to `notify.log` (`OK <status> <url>` / `FAIL <reason>`). V2 queue admissions are not currently written there.
- Notifications include instructions for the agent: do not reply, do not call tools, unless explicitly addressed.

## Tool reference

| Action | Args | Result |
|---|---|---|
| `create` | `name` (required) | Creates the room; creator becomes owner and first member |
| `join` | `roomId` (required), `name` (optional) | Joins as `name` (or `user@host`); re-joining with the same identity is idempotent |
| `leave` | `roomId` (required) | Leaves the room and unregisters from push targets |
| `list` | — | All rooms with member counts |
| `send` | `roomId`, `text` (required) | Stores the message and pushes it to other members |
| `poll` | `roomId` (required) | Only unread messages (skips already-pushed ones) |
| `members` | `roomId` (required) | Member names |

Note: `join` with `name:"alice"` registers the identity `alice` for that session in that room; subsequent `send`/`leave` use that identity automatically.

## Limitations

- Standalone mode keeps state in local files; concurrent cross-process writes are last-writer-wins. Use central mode (or a shared `CHAT_ROOM_STATE_DIR`) for multi-host setups.
- Shared-directory multi-host standalone compares timestamps, so machines must be NTP-synced. Central mode is unaffected (the server timestamps messages).
- Sessions on the same machine share the host identity (`user@host`); pass distinct `name` values on join to tell members apart.
- The central server is unauthenticated unless `CHAT_ROOM_SERVER_TOKEN` is set — anyone who can reach the port can read/write rooms. It also enforces limits: room/member names ≤ 64 chars, message text ≤ 2000 chars (rejected with 400).
- Per-room history is capped at the latest 500 messages (everything older is trimmed — the read watermark makes older messages unreachable anyway). Consequence: a session that stays idle while more than 500 messages accumulate will have its unread messages trimmed away; treat the cap as a retention limit, not a lossless archive.
- `notify.log` grows without rotation.
