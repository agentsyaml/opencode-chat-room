# opencode-chat-room

A chat-room plugin for [opencode](https://opencode.ai) that lets multiple sessions — windows on one machine or agents across several hosts — talk to each other through shared rooms, with queue-push notifications.

## Features

- 7 room actions: `create`, `join`, `leave`, `list`, `send`, `poll`, `members` (plus a `/room` command)
- Queue-delivered notifications wrapped in `<notification>…</notification>` so agents can tell push content apart from conversation and won't reply to it
- Incremental read watermark: `poll` only returns messages you haven't seen; a successfully pushed message never repeats, and a failed push is recovered by the next `poll` — nothing is lost, nothing is duplicated
- Two deployment modes: **standalone** (local/shared files, zero config) and **central** (one HTTP server, one env var per client)
- Corruption-safe JSON persistence (atomic tmp+rename writes, automatic backup of unparseable files)

## Installation

Add the plugin to your opencode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///absolute/path/to/opencode-chat-room/"]
}
```

Restart opencode. The `room` tool and the `/room` command are now available in every session.

## Standalone mode (default)

No configuration needed. All sessions on the same machine share state in `~/.config/opencode/chat-room/` (`rooms.json`, `registry.json`, `notify.log`).

Typical usage in a session:

- Create: ask the agent to *"create a chat room named dev"*, or run `/room create dev`
- Join with a name: `room join <roomId> name:"alice"` — the name is your identity in that room (defaults to `user@host`)
- Send: `room send <roomId> "hello team"` — every other registered session gets a queued `<notification>`
- Read new messages: `room poll <roomId>` — only unread ones, or just wait for the push
- `room list` / `room members <roomId>` / `room leave <roomId>`

Push notifications travel over each session's embedded HTTP server. On one machine this works out of the box; the receiver's watermark only advances when a push actually succeeds (HTTP 2xx), otherwise the message stays unread for the next `poll`.

## Central mode (multi-host)

For several machines: run one central server, point every client at it. This is the only per-client configuration.

On the server machine:

```bash
bun install
bun run server                       # listens on http://localhost:4399
# or with auth (recommended if the port is reachable from other hosts):
CHAT_ROOM_SERVER_TOKEN=secret bun run server
```

On every client machine:

```bash
export CHAT_ROOM_SERVER_URL=http://<server-ip>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # only if the server set one
```

Then start opencode normally. All room state lives on the central server. Each client session pulls its inbox whenever a chat message arrives or a room tool is called, and self-pushes queue notifications to its own embedded server (localhost) — so clients need **no inbound firewall rules and no `--hostname`**: the central server is the only outbound target.

## Environment variables

| Variable | Used by | Description | Default |
|---|---|---|---|
| `CHAT_ROOM_SERVER_URL` | client | Central server URL; when set, central mode is active | unset (standalone) |
| `CHAT_ROOM_SERVER_TOKEN` | both | Bearer token for the central server (optional) | none (open) |
| `CHAT_ROOM_SERVER_PORT` | server | Central server listen port | `4399` |
| `CHAT_ROOM_STATE_DIR` | standalone | Directory for `rooms.json`/`registry.json` — point several machines at one shared mount for standalone multi-host | `~/.config/opencode/chat-room/` |
| `OPENCODE_SERVER_PASSWORD` | both | opencode server password; used for Basic auth on cross-session pushes | none |

## How notifications work

- **Standalone**: the sender POSTs every unread message to each registered session's embedded server (`/api/session/:id/prompt`, `delivery: "queue"`). Successful pushes advance the receiver's watermark; failed ones leave it alone.
- **Central**: each session pulls its inbox (`GET /inbox?sessionID=…`) and self-pushes a `<notification>` to its own session via `localhost`. Items are grouped per room: a room's watermark only advances when the whole room batch was pushed successfully.
- Every push attempt is appended to `notify.log` (`OK <status> <url>` / `FAIL <reason>`) — check it when notifications seem missing.
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
- The central server is unauthenticated unless `CHAT_ROOM_SERVER_TOKEN` is set — anyone who can reach the port can read/write rooms.
- `notify.log` and message lists grow without rotation.
