# opencode-chat-room

A chat-room plugin for [opencode](https://opencode.ai) that lets multiple sessions — windows on one machine or agents across several hosts — talk to each other through shared rooms, with session-steered notifications.

## Features

- 7 room actions: `create`, `join`, `leave`, `list`, `send`, `poll`, `members` (plus a `/room` command)
- **Human web chat UI** served at `GET /chat` (central mode): humans join rooms in the browser and chat with agents on equal footing
- Web chat supports switching among joined group rooms and direct conversations without leaving them; drafts and read positions are stored per tab
- Group broadcasts support `@all` and `@所有人`; direct messages are addressed to the other participant without an @mention
- Notifications wrapped in `<notification>…</notification>`; V2 steers the persistent session, while V1 uses asynchronous prompts
- Incremental read watermark: `poll` returns unread messages; failed message-delivery attempts remain available for retry. V1 asynchronous acceptance does not guarantee durable delivery.
- Two deployment modes: **standalone** (local SQLite, zero config) and **central** (one HTTP server, one env var per client)
- Normalized SQLite storage with transactional legacy JSON migration and append-only message history

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

This plugin supports OpenCode **1.18.29 and newer V1 releases**, plus the current V2 plugin API. Restart OpenCode after changing versions so it loads the matching plugin entrypoint. V1 uses the public `prompt_async` endpoint: a successful HTTP response means the notification was accepted for asynchronous processing, not durably queued. V1 polls only sessions observed by a prompt hook or room tool. V2 also restores explicitly joined sessions bound to the current user's verified local service. Existing memberships from earlier versions are not automatically claimed: rejoin each room once in the session you want the current V2 service to receive. Without the optional watcher, at least one project with the plugin loaded must remain open for polling. The owner binding is scoped to the current user's service URL and port; changing ports requires rejoining. Profiles that copy both OpenCode's session database and this private owner binding cannot be distinguished by the plugin.

## Standalone mode (default)

No configuration needed. State is stored in `~/.config/opencode/chat-room/chat-room.sqlite` (or the directory selected by `CHAT_ROOM_STATE_DIR`). On first use, valid `rooms.json` and `registry.json` files are migrated in one transaction and left untouched as backups. Messages are retained in SQLite; `room poll` returns up to 100 unread messages at a time, and the authenticated history endpoint supports keyset pages of up to 200 messages.

SQLite uses WAL and requires a local filesystem. Do not place standalone state on NFS/SMB or another shared network mount; use central mode for multi-host rooms. Messages already trimmed from old JSON files cannot be recovered.

Central deployments expose authenticated history pages at `GET /rooms/<roomId>/history?beforeSeq=<sequence>&limit=<1-200>`; the response includes `messages`, `nextBeforeSeq`, and `hasMore`.

Typical usage in a session:

- Create: ask the agent to *"create a chat room named dev"*, or run `/room create dev`
- Join with a name: `room join <roomId> name:"alice"` — the name is your identity in that room (defaults to `user@host`)
- Send: `room send <roomId> "hello team"` — other registered sessions receive a host-appropriate `<notification>`
- Read new messages: `room poll <roomId>` — only unread ones, or just wait for the push
- `room list` / `room members <roomId>` / `room leave <roomId>`

In group rooms, `@all` or `@所有人` addresses the other room members. A direct conversation notifies its other participant without requiring an @mention.

Push notifications use the host's supported transport. V1 notifications are ordinary asynchronous prompts; V2 notifications steer the persistent session. In both cases the unread watermark advances only after the host accepts the notification. V2 steering takes effect at a safe boundary; it is not an instant interrupt and does not guarantee that a currently blocking task can be detached.

On V2, every notification steers the session when observed. For an eligible mention (`@alice`, `@all`, or `@所有人`) or direct message, the plugin makes one best-effort backgrounding attempt before steering. OpenCode exposes session-wide backgrounding, not an atomic operation bound to a particular shell or subagent task, so the plugin cannot guarantee which active work is detached. It calls only the current OS user's registered OpenCode service after verifying its PID and version. Failure is logged and does not block steering; message-delivery retries are separate. Backgrounding does not cancel work, and success does not guarantee task completion. A session must still be a room member to receive notifications; only explicitly addressed sessions can be restored by the watcher when OpenCode is not running. No service is started and no ports are probed. Polling is every five seconds, so this is not instant push.

For a direct request, the notification asks the agent to acknowledge it once in the originating room before working, then send useful progress updates and its final response there. Routine confirmations, status or membership updates, system messages, and ordinary broadcasts do not call for an acknowledgement. The prompt includes the room ID so the agent can address the right room.

### Resident V2 watcher

Run `opencode-chat-room watch start` to keep V2 delivery polling after the project that loaded the plugin closes. The watcher uses the current user's registered OpenCode service and joined-room owner bindings; it does not start OpenCode. In central mode it inherits `CHAT_ROOM_SERVER_URL` and `CHAT_ROOM_SERVER_TOKEN` from the command environment. If the service is offline, it stays running and retries. `watch status` checks its authenticated loopback control endpoint, `watch stop` shuts it down gracefully, and `watch run` runs it in the foreground. Start it manually or under an OS supervisor if desired; the package does not install startup services. The watcher also does not auto-start when you send or receive a message. Its private control state and cross-process delivery leases live under the user's XDG state directory. If status reports an unreadable legacy control file, remove only that user's `watch-*.json` after confirming the watcher is not running; the default directory is `~/.local/state/opencode/chat-room`.

OpenCode 2.2.1 unloads idle project-location services after a default 60-minute idle timeout. The watcher keeps delivery polling possible, not sessions awake; it can restore only joined sessions addressed by `@name`, `@all`, `@所有人`, or a direct message. Start it explicitly. If the OpenCode service is offline, it retries and resumes when the service returns. It sends no synthetic messages or model requests to keep sessions alive.

## Central mode (multi-host)

For several machines: run one central server, point every client at it. This is the only per-client configuration.

On the server machine, install Bun first. `npx`, `pnpx`, and `bunx` only execute the package; the CLI itself runs on Bun. CLI options override environment variables.

```bash
# Show CLI options:
npx --yes --package=@alexsun-top/opencode-chat-room@0.3.1 -- opencode-chat-room --help

# Start the local central server (choose any one runner):
npx --yes --package=@alexsun-top/opencode-chat-room@0.3.1 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.3.1 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.3.1 --host 0.0.0.0 --port 4399 --token secret

# Environment variables also work; CLI options take precedence:
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.3.1

# Local checkout:
bun install
bun run server
```

Open `http://<server-ip>:4399/chat` in a browser to join or create a room and chat with agents. If a token is configured, enter it in the page settings.

### Browser chat

Rooms you joined remain joined as you switch the sidebar selection; switching views does not leave a room. Direct conversations are created with the selected registered member session. Each tab stores its joined-room list, drafts, and read positions separately, and tracks unread counts within that tab. This is tab-scoped convenience state, not account identity: if browser tab storage is blocked, the generated session identity lasts only for that page lifetime.

The chat renders GitHub Flavored Markdown using locally bundled Marked and DOMPurify assets. Message text is sanitized before rendered HTML is inserted. No CDN is required.

The central server uses a trusted shared-token model, not per-user authorization or private DMs: anyone holding the token can read messages, manage rooms, remove members, and delete rooms. The server and its SQLite database can read direct-message content. Removing a member requires confirmation; deleting a room requires confirmation and permanently deletes its messages and history.

### Agent presence and message receipts

`GET /rooms/<roomId>/members` returns each member's `membershipID`, `type`, and `activity: { state, observedAt }`; `observedAt` is the server timestamp in milliseconds. V2 presence is based on OpenCode foreground-session activity: `working` means the host reports a running session; `idle` means no foreground session was reported, while background work may continue. `unknown` means no usable heartbeat is available, including for V1 agents. `waiting` is an accepted state but is not automatically detected. Reports expire after 60 seconds and are shown as `offline` (stale); this does not prove the agent is offline.

V2 presence uses `POST /presence` with an owner-scoped increasing sequence and up to 200 sessions per request:

```json
{"ownerID":"123e4567-e89b-42d3-a456-426614174000","sequence":42,"sessions":[{"sessionID":"<session-id>","receiverOwnerID":"123e4567-e89b-42d3-a456-426614174000","state":"working"}]}
```

Older or repeated sequences are ignored and do not refresh presence. The plugin reports foreground activity about every 10 seconds.

Receipts identify exact messages; join, read, and queued cursors do not create them. `GET /rooms/<roomId>/receipts?messageIDs=<id>,<id>` reads up to 500 selected messages; without `messageIDs`, it returns the latest 500. Its response is `{ receipts: [{ messageID, readers: [{ sessionID, name, readAt, evidence, currentMember }] }], semantics: "per-message" }`. `POST /rooms/<roomId>/receipts` accepts `sessionID`, the current `membershipID`, up to 500 `messageIDs`, and `evidence` (`displayed`, `tool`, or `context`); V2 agents also send `receiverOwnerID`. `POST /read` can include the same message IDs, membership ID, evidence, and (for V2) `receiverOwnerID` alongside `roomId` and `ts`; with IDs it records receipts and advances the delivery cursor atomically, while without IDs it advances delivery state only.

`membershipID` identifies the current join generation. Leaving and rejoining creates a new ID; receipt submissions from the previous generation are rejected.

`displayed` means the message intersected the visible area of a focused browser tab. `tool` means a room poll fetched the full message; V1 receipts are limited to explicit polls. `context` means the full message reached primary agent-context preparation, not that it was understood. A 300-character push preview is not full-message evidence; poll the full message to record a receipt. Receipts remain visible after a reader leaves, marked as no longer a current member. These endpoints use the central server's shared-token permissions, not per-user access control.

Upgrade the central server and every client plugin separately; updating only a local plugin does not deploy the server APIs. The package does not automatically deploy or reconfigure the server service.

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
| `CHAT_ROOM_STATE_DIR` | standalone | Local directory for `chat-room.sqlite` and legacy JSON migration files; keep it on a local filesystem | `~/.config/opencode/chat-room/` |
| `OPENCODE_SERVER_PASSWORD` | both | opencode server password; used for Basic auth on cross-session pushes | none |
| `CHAT_ROOM_WAKE_SERVE_URL` | client | Optional OpenCode serve URL used as a fallback for mentioned inactive sessions | unset |

## How notifications work

- **Standalone**: V1 sends asynchronous prompts to registered session servers; V2 polls shared local state and steers notifications through its persistent session API. The watermark advances only on host acceptance.
- **Central**: sessions pull their inbox (`GET /inbox?sessionID=…`) and steer `<notification>` messages through the host API. Items are grouped per room; a room's queued watermark advances only after admission.
- Standalone V1 HTTP attempts are appended to `notify.log` (`OK <status> <url>` / `FAIL <reason>`). V2 notification admissions are not currently written there.
- Backgrounding is attempted once per eligible notification. Failures are reported to process diagnostics but do not block steering; message-delivery retries are separate. The session-wide API cannot guarantee task-specific detachment, and backgrounding does not cancel existing work.
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

- Standalone mode uses a local SQLite database with cross-process write transactions. Do not share the WAL database over NFS/SMB; use central mode for multi-host setups.
- Sessions on the same machine share the host identity (`user@host`); pass distinct `name` values on join to tell members apart.
- The central server is unauthenticated unless `CHAT_ROOM_SERVER_TOKEN` is set — anyone who can reach the port can read/write rooms. It also enforces limits: room/member names ≤ 64 chars, message text ≤ 2000 chars (rejected with 400).
- SQLite retains message history without automatic deletion. The 500-message in-memory window does not limit persisted history; unread messages and history are read in bounded pages. Back up the database regularly.
- Only installations carrying retry rows from an intermediate development build are affected: records without a recoverable message timestamp migrate conservatively, permanently disabling backgrounding for that service/room. Normal notification steering continues.
- `notify.log` grows without rotation.
- Known issue: a report of users being unable to select their own text in Edge on macOS and Windows remains unverified. It was not reproduced on a physical Mac with Edge 156 or with mirrored online assets; a recording is still needed.
