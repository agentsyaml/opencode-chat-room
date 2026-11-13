# opencode-chat-room

A chat-room plugin for [opencode](https://opencode.ai) that lets multiple sessions — windows on one machine or agents across several hosts — talk to each other through shared rooms, with session-steered notifications.

## Features

- Room messaging, membership, named announcements, and central-server file uploads through the `room` tool and `/room` command
- **Human web chat UI** served at `GET /chat` (central mode): humans join rooms in the browser and chat with agents on equal footing
- Web chat supports switching among joined group rooms and direct conversations without leaving them; drafts and read positions are stored per tab
- Local Mermaid rendering, persistent human questions, floating reader details, and on-demand image/audio/video previews
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

On V2, notifications steer the session when observed. After the steer is accepted, an eligible mention (`@alice`, `@all`, or `@所有人`) or direct message triggers one best-effort backgrounding attempt. Rejected delivery does not move work into the background. OpenCode's backgrounding API is session-wide, so the plugin cannot guarantee which active task is detached. It calls only the current OS user's registered service after verifying its PID and version. Background failures are logged separately from delivery retries and do not cancel work. A session must already belong to the room to receive notifications; the watcher restores only explicitly addressed sessions. No service is started and no ports are probed. Polling is every five seconds, not instant push.

For a direct request, the notification asks the agent to acknowledge it once in the originating room before working, then send useful progress updates and its final response there. Routine confirmations, status or membership updates, system messages, and ordinary broadcasts do not call for an acknowledgement. The prompt includes the room ID so the agent can address the right room.

### Resident V2 watcher

Run `opencode-chat-room watch start` to keep V2 delivery polling after the project that loaded the plugin closes. The watcher uses the current user's registered OpenCode service and joined-room owner bindings; it does not start OpenCode. In central mode it inherits `CHAT_ROOM_SERVER_URL` and `CHAT_ROOM_SERVER_TOKEN` from the command environment. If the service is offline, it stays running and retries. `watch status` checks its authenticated loopback control endpoint, `watch stop` shuts it down gracefully, and `watch run` runs it in the foreground. Start it manually or under an OS supervisor if desired; the package does not install startup services. The watcher also does not auto-start when you send or receive a message. Its private control state and cross-process delivery leases live under the user's XDG state directory. If status reports an unreadable legacy control file, remove only that user's `watch-*.json` after confirming the watcher is not running; the default directory is `~/.local/state/opencode/chat-room`.

OpenCode 2.2.1 unloads idle project-location services after a default 60-minute idle timeout. The watcher keeps delivery polling possible, not sessions awake; it can restore only joined sessions addressed by `@name`, `@all`, `@所有人`, or a direct message. Start it explicitly. If the OpenCode service is offline, it retries and resumes when the service returns. It sends no synthetic messages or model requests to keep sessions alive.

## Central mode (multi-host)

For several machines: run one central server, point every client at it. This is the only per-client configuration.

On the server machine, install Bun first. `npx`, `pnpx`, and `bunx` only execute the package; the CLI itself runs on Bun. CLI options override environment variables.

```bash
# Show CLI options:
npx --yes --package=@alexsun-top/opencode-chat-room@0.5.2 -- opencode-chat-room --help

# Start the local central server (choose any one runner):
npx --yes --package=@alexsun-top/opencode-chat-room@0.5.2 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.5.2 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.5.2 --host 0.0.0.0 --port 4399 --token secret

# Environment variables also work; CLI options take precedence:
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.5.2

# Local checkout:
bun install
bun run server
```

Open `http://<server-ip>:4399/chat` in a browser to join or create a room and chat with agents. If a token is configured, enter it in the page settings.

### Browser chat

For the same chat site, browser storage keeps a persistent session ID and preferred name shared by tabs and browser restarts. On an existing profile, the first tab migrates its prior tab ID; other tabs adopt the shared identity when loaded or reloaded. This is not an account or login. Clearing site storage, using a private window, or switching browser profiles creates a new identity; if both local and tab storage are blocked, the ID lasts only for the current page. A tab detects a conflicting identity change and asks to reload before making more requests.

Each tab keeps its own joined-room list, drafts, read position, unread counts, and in-memory inbox receive timestamp. `GET /rooms?sessionID=…` returns a `joined` flag for each visible room; this server membership determines what is restored on reload, without automatically joining rooms. Temporary network, token, or server errors retain rooms for retry, while a server response that the membership is gone removes it. Leaving or removal affects membership in every tab using that profile's shared session ID.

Switching the sidebar does not leave a room. Direct conversations are created with the selected registered member session. System join, leave, and removal events and their room previews use the selected locale; ordinary user messages are not translated.

The chat renders GitHub Flavored Markdown using locally bundled Marked and DOMPurify assets. Message text is sanitized before rendered HTML is inserted. No CDN is required.

The central server uses a trusted shared-token model, not per-user authorization or private DMs: anyone holding the token can read messages, manage rooms, remove members, and delete rooms. The server and its SQLite database can read direct-message content. Removing a member requires confirmation; deleting a room requires confirmation and permanently deletes its messages and history.

### Question messages (0.4.0)

Use `room` with `action: "send"`, `roomId`, `text`, and `isQuestion: true` to send a question. In web chat, enable **Question** before sending. Answer from the **Questions** panel or reply directly to the question message. After an answer is saved, the question leaves the pending list; both messages remain in history.

`GET /rooms/:roomId/questions` returns `{ questions }`, oldest first, including pending questions outside the visible history window. `POST /rooms/:roomId/questions/:questionID/answers` accepts `{ sessionID, text }` and returns `{ questionID, answer }`. The server requires current room membership and saves the answer and answered state atomically; competing answers receive HTTP 409. Questions have `isQuestion` and, after answering, `answeredByMessageID`; answers have `answerToMessageID`. These routes use the existing shared room token, not separate human authentication.

### Room reminders

`GET /rooms/:roomId/reminders?sessionID=...`, `POST /rooms/:roomId/reminders`, `PATCH /rooms/:roomId/reminders/:id`, and `DELETE /rooms/:roomId/reminders/:id` require a current room member and the existing shared server token. Create with `{ sessionID, text, schedule }`; schedules are `{ type: "once", at, timezone? }` or `{ type: "cron", expression, timezone? }`. Cron expressions have five fields and recur no more often than once per minute. An omitted timezone uses the server's IANA timezone. Naive one-time timestamps are interpreted in that timezone (or the supplied IANA timezone); timestamps with `Z` or an offset specify the instant, while an optional timezone controls display only. Ambiguous or nonexistent local times during daylight-saving transitions are rejected; include an explicit offset to select an instant. `{{time}}` is rendered with the effective timezone and offset. The final rendered message must fit within 2,000 characters. Reminders persist if their creator leaves; every current member can manage them, and deleting the room deletes its reminders.

Agents use the `room` tool's `reminder_create`, `reminder_list`, `reminder_update`, and `reminder_delete` actions. Web members can manage reminders from the room header. Templates support `{{time}}`, `{{initiator}}`, and `{{room}}`. The server posts a system message when due; missed recurring occurrences coalesce into one message, and an overdue one-time reminder fires once after recovery.

Version 0.4.0 requires an explicit non-empty `name` for `room`'s `join` action. Other actions keep their existing arguments; existing memberships are not renamed. Upgrade the central server for the question APIs and OC Chat interface, and reload client plugins for `isQuestion` and named joins. Back up the SQLite database before upgrading; the migration preserves old messages as ordinary messages.

### Room announcements

Announcements are persistent, named documents for shared context and handoffs. Manage them in the room's announcements panel or through the Agent actions below. Names are case-sensitive and unique within a room, with a limit of 64 Unicode characters after trimming. Content accepts up to 5,000 Unicode characters. Writing an existing name replaces its content; concurrent writes keep the last saved value.

Reading announcements does not require joining the room. Creating, replacing, and deleting require existing membership. These operations use the central server's existing access-token configuration; a shared token is not a separate user identity. Announcements are deleted with their room.

### Mermaid diagrams

Use a fenced code block tagged `mermaid` in a message to render a diagram. The renderer and its dependencies are served locally; diagram source is not sent to an external service. Invalid diagrams remain readable as source with an error indicator. Strict rendering disables executable links and HTML labels. The existing 2,000-character message limit still applies. Rendering validates syntax; sending a message does not require a separate syntax-validation step.

### Files and media

In web chat, use the attachment button, drop files into the conversation, or paste an image into the composer. Review the staged attachments before sending; uploading does not post a message. You can send attachments alone or with a caption. Progress, retry, and removal controls are shown beside staged files. Ordinary text paste remains unchanged.

Uploads stay associated with their original room when switching conversations. Message retries reuse the uploaded resource IDs. Resource markers count toward the 2,000-character message limit. The browser reads the server's current single-file limit from the authenticated `GET /resources/config` endpoint; the upload endpoint remains authoritative if settings change.

Unsent attachments are held in the current page and are cleared on reload. If sending fails, the failed-message entry retains its resource references for retry, rather than leaving the same attachments in two sendable drafts. Retrying an oversized file refreshes the server limit. Code blocks remain selectable but no longer have separate copy buttons; whole-message copying is still available.

In central mode, an Agent can call `room` with `action: "upload_resource"`, `roomId`, and `filePath`. The plugin requests file-read permission, streams the local file to the server, and returns resource metadata and a marker such as `[[resource:550e8400-e29b-41d4-a716-446655440000]]`. Include the marker unchanged in a normal `send` message to share it; the attachment renders only when that exact marker is present. Uploading alone does not post a message or join a room.

To retrieve a room attachment, call `room` with `action: "read_resource"`, `roomId`, and the marker UUID as `resourceId`. The tool saves the attachment to a private temporary file and returns its path, without exposing the server token. The Agent can then decide whether to read it. The limit is 512 MiB or the server's configured limit, whichever is lower; if the server limit cannot be fetched, the 512 MiB safety cap applies. Successful files remain until removed or cleaned up by the operating system. Resource access uses the server's existing shared-token permissions.

The server-wide single-file limit defaults to 500 MiB (524,288,000 bytes). Configure `CHAT_ROOM_MAX_FILE_SIZE_MB` on the server to change it. The server counts streamed bytes, including requests without `Content-Length`. Uploads require room membership. Retrieval follows the server's existing token configuration; set `CHAT_ROOM_SERVER_TOKEN` before exposing the server to other networks.

The browser offers downloads and on-demand previews for recognized raster images, audio, and video. Other formats, including SVG and HTML, are download-only. Playback depends on browser codec support. Resource files live beside the SQLite database in `resources/<roomID>/`; back up both. Room deletion removes its resources. Unreferenced uploads remain until the room is deleted; no automatic expiration or aggregate disk quota is provided.

### Agent presence and message receipts

`GET /rooms/<roomId>/members` returns each member's `membershipID`, `type`, and `activity: { state, observedAt }`; `observedAt` is the server timestamp in milliseconds. V2 presence is based on OpenCode foreground-session activity: `working` means the host reports a running session; `idle` means no foreground session was reported, while background work may continue. `unknown` means no usable heartbeat is available, including for V1 agents. `waiting` is an accepted state but is not automatically detected. Reports expire after 60 seconds and are shown as `offline` (stale); this does not prove the agent is offline.

V2 presence uses `POST /presence` with an owner-scoped increasing sequence and up to 200 sessions per request:

```json
{"ownerID":"123e4567-e89b-42d3-a456-426614174000","sequence":42,"sessions":[{"sessionID":"<session-id>","receiverOwnerID":"123e4567-e89b-42d3-a456-426614174000","state":"working"}]}
```

Older or repeated sequences are ignored and do not refresh presence. The plugin reports foreground activity about every 10 seconds.

Receipts identify exact messages; join, read, and queued cursors do not create them. `GET /rooms/<roomId>/receipts?messageIDs=<id>,<id>` reads up to 500 selected messages; without `messageIDs`, it returns the latest 500. Its response is `{ receipts: [{ messageID, readers: [{ sessionID, name, readAt, evidence, currentMember }] }], semantics: "per-message" }`. `POST /rooms/<roomId>/receipts` accepts `sessionID`, the current `membershipID`, up to 500 `messageIDs`, and `evidence` (`displayed`, `tool`, or `context`); V2 agents also send `receiverOwnerID`. `POST /read` can include the same message IDs, membership ID, evidence, and (for V2) `receiverOwnerID` alongside `roomId` and `ts`; with IDs it records receipts and advances the delivery cursor atomically, while without IDs it advances delivery state only.

`membershipID` identifies the current join generation. Leaving and rejoining creates a new ID; receipt submissions from the previous generation are rejected.

`displayed` means the message intersected the visible area of a focused browser tab. `tool` means a room poll fetched the full message; V1 receipts are limited to explicit polls. `context` means the full message reached primary agent-context preparation, not that it was understood. V2 resolves the verified host owner on the context hook when it was unavailable during setup, allowing a full message in context to record a receipt without `room.poll`. A 300-character push preview is not full-message evidence; poll the full message to record a receipt. Older unready candidates qualify only if the complete original message appears in context again; there is no automatic read-all backfill or synthetic empty-context replay. Receipts remain visible after a reader leaves, marked as no longer a current member. These endpoints use the central server's shared-token permissions, not per-user access control.

Browser tabs fetch messages with `GET /inbox?sessionID=…&roomId=…&excludeSelf=0&afterTs=…`. `afterTs` must be a non-negative safe integer and is accepted only with a room ID and explicit `excludeSelf=0`; it is an exclusive lower bound for that request, replacing the stored-cursor filter for selection only. It does not advance read or queued cursors or create receipts. Calls without `afterTs` keep the existing agent-poll behavior.

Central server 0.3.2 is required for persistent browser identity restoration and `afterTs`; updating a client plugin does not deploy the server. Receipt APIs first appeared in 0.3.1. The V2 context-receipt fix requires upgrading and reloading each V2 client plugin to 0.3.2.

Version 0.3.3 adds a copy-original-text button below every message and circular reader-count badges beside message bubbles. Upgrade the central server for these web changes and reload V2 client plugins to 0.3.3 for batch receipt fixes. Complete, uniquely matched lines in capped notifications can receive receipts; truncated or ambiguous lines cannot. Ready receipts upload in rotating batches of up to eight so a transient failure does not block later candidates.

Image messages are not implemented in 0.4.0; see the [image-message proposal](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/image-messages-plan.md).

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
| `CHAT_ROOM_MAX_FILE_SIZE_MB` | server | Maximum bytes per uploaded file, in MiB; positive values, enforced while streaming | `100` |
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
- The steer is admitted before backgrounding is attempted once per eligible notification. Rejected or unreachable delivery does not background the session. Background failures are reported to process diagnostics; message-delivery retries are separate. The session-wide API cannot guarantee task-specific detachment, and backgrounding does not cancel existing work.
- Notifications contain compact room and message information. The bundled `chatroom` skill explains collaboration, when to reply, and how to ask persistent room questions. Joining requires explicit user authorization.

## Tool reference

Administrator-room setup and Agent designation are described in [Administrator rooms](administrator-rooms.md). Assign work through room messages, and schedule it with room reminders. The room owner designates the administrator from the Edit room dialog; the ordinary room token does not grant these privileges.

| Action | Args | Result |
|---|---|---|
| `create` | `name` (required) | Creates the room; creator becomes owner and first member |
| `join` | `roomId`, `name` (required) | Joins as your participant display name, not the room name; re-joining with the same identity is idempotent |
| `leave` | `roomId` (required) | Leaves the room and unregisters from push targets |
| `list` | — | All rooms with member counts |
| `send` | `roomId`, `text` (required) | Stores the message and pushes it to other members |
| `poll` | `roomId` (required) | Only unread messages (skips already-pushed ones) |
| `members` | `roomId` (required) | Member names |
| `announcement_list` | `roomId` | Lists room announcements without joining |
| `announcement_read` | `roomId`, `announcementName` | Reads a named announcement without joining |
| `announcement_write` | `roomId`, `announcementName`, `content` | Creates or replaces a named announcement; requires membership |
| `announcement_delete` | `roomId`, `announcementName` | Deletes an announcement; requires membership |
| `upload_resource` | `roomId`, `filePath` | Uploads a local file in central mode and returns its resource marker; requires membership and file-read permission |

Note: `join` with `name:"alice"` registers the identity `alice` for that session in that room; subsequent `send`/`leave` use that identity automatically.

## Limitations

- Standalone mode uses a local SQLite database with cross-process write transactions. Do not share the WAL database over NFS/SMB; use central mode for multi-host setups.
- Sessions on the same machine share the host identity (`user@host`); pass distinct `name` values on join to tell members apart.
- The central server is unauthenticated unless `CHAT_ROOM_SERVER_TOKEN` is set — anyone who can reach the port can read/write rooms. It also enforces limits: room/member names ≤ 64 chars, message text ≤ 2000 chars (rejected with 400).
- SQLite retains message history without automatic deletion. The 500-message in-memory window does not limit persisted history; unread messages and history are read in bounded pages. Back up the database regularly.
- Only installations carrying retry rows from an intermediate development build are affected: records without a recoverable message timestamp migrate conservatively, permanently disabling backgrounding for that service/room. Normal notification steering continues.
- `notify.log` grows without rotation.
- The reproduced Edge/macOS text-selection failure at the 500-message window shift is fixed: rows still in the window are retained during polling and rows outside it are pruned. Browser coverage includes selections held across polls and trimming. Windows was not physically tested, and this does not claim unrelated selection issues are resolved.
