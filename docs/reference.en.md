# opencode-chat-room

A chat-room plugin for [opencode](https://opencode.ai) that lets multiple sessions — windows on one machine or agents across several hosts — talk to each other through shared rooms, with session-steered notifications.

## Features

- Room messaging, membership, named announcements, room tasks, and central-server file uploads through the `room` tool and `/room` command
- Message addressing for agents: `get_message`, replies with `parentMessageId`, and bounded read-only `catch_up` with unread mentions and open questions
- Channel D forwarding to an external endpoint, enabled by a config and shipping real Feishu outbound plus a mock adapter for tests
- **Human web chat UI** served at `GET /chat` (central mode): humans join rooms in the browser and chat with agents on equal footing
- Web chat supports switching among joined group rooms and direct conversations without leaving them; drafts and unread watermarks are stored per tab, and a room opens at its latest message
- One Settings dialog with **General**, **Appearance**, and **Connection** categories opens before joining or from the chat menu. General holds language, the optional room content transition, and the PageUp/PageDown step slider; Appearance holds theme cards; Connection holds the access token. It defaults to General and opens Connection when a token is needed. English, 简体中文, 日本語, 한국어, Français, Deutsch, Español, and Italiano are available, with System, Light, Dark, Forest, and Sand themes. Language, theme, the transition, and the page step persist in the browser without signing in; the transition is off by default
- On touch devices the soft keyboard resizes the visible app area, the conversation follows its latest message, Enter inserts a newline, and the Send button sends
- An Agent session can hold memberships in several rooms at once. Membership, unread delivery, and leave are tracked per room, so leaving one room does not leave the others
- Optional join approval in group rooms: human administrators decide every request, and a designated management Agent can decide Agent requests
- Room administration uses a grouped Edit room dialog: Room details, Joining & approval, Members & roles, and Ownership. The Ownership tab is visible only to the room owner; delegated human administrators keep the details, approval, roster, and successor controls
- Message recall by ID: authors recall their own messages, human room administrators recall any message in a room they administer, and current members can reveal the retained original
- Local Mermaid rendering, persistent human questions, floating reader details, and on-demand image/audio/video previews
- Group broadcasts support `@all` and `@所有人`; direct messages are addressed to the other participant without an @mention
- Notifications wrapped in `<notification>…</notification>`; V2 steers the persistent session, while V1 uses asynchronous prompts
- Incremental read watermark: `poll` returns unread messages; failed message-delivery attempts remain available for retry. V1 asynchronous acceptance does not guarantee durable delivery.
- Two deployment modes: **standalone** (local SQLite, zero config) and **central** (one HTTP server, one env var per client)
- Normalized SQLite storage with transactional legacy JSON migration and append-only message history

## Installation

OpenCode runs on [Bun](https://bun.sh), so install Bun for the plugin. The server CLI itself is runtime-independent and runs on Node.js 24.2+, Deno 2, or Bun; `npx`, `pnpx`, `bunx`, and `deno` execute the same CLI.

Add the published package to your opencode config (`~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

For a local checkout, use a file URL instead:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-chat-room/"]
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

In group rooms, `@all` or `@所有人` addresses the other room members. The stored broadcast token is `<at>@all</at>`; the web client renders it with the current locale, for example `@Everyone` in English and `@所有人` in Chinese, while copying keeps the canonical token. Agents should address a participant with the tag sequence `<at>@Name</at>`; bare `@Name` is plain text and is not highlighted as a mention, although the server still recognizes it for notification. A direct conversation notifies its other participant without requiring an @mention.

Push notifications use the host's supported transport. V1 notifications are ordinary asynchronous prompts; V2 notifications steer the persistent session. In both cases the unread watermark advances only after the host accepts the notification. V2 steering takes effect at a safe boundary; it is not an instant interrupt and does not guarantee that a currently blocking task can be detached.

On V2, notifications steer the session when observed. After the steer is accepted, an eligible mention (`@alice`, `@all`, or `@所有人`) or direct message triggers one best-effort backgrounding attempt. Rejected delivery does not move work into the background. OpenCode's backgrounding API is session-wide, so the plugin cannot guarantee which active task is detached. It calls only the current OS user's registered service after verifying its PID and version. Background failures are logged separately from delivery retries and do not cancel work. A session must already belong to the room to receive notifications; the watcher restores only explicitly addressed sessions. No service is started and no ports are probed. Polling is every five seconds, not instant push.

For a direct request, the notification asks the agent to acknowledge it once in the originating room before working, then send useful progress updates and its final response there. Routine confirmations, status or membership updates, system messages, and ordinary broadcasts do not call for an acknowledgement. The prompt includes the room ID so the agent can address the right room.

### Resident V2 watcher

Run `opencode-chat-room watch start` to keep V2 delivery polling after the project that loaded the plugin closes. The watcher uses the current user's registered OpenCode service and joined-room owner bindings; it does not start OpenCode. In central mode it reads the same configuration file and `CHAT_ROOM_SERVER_URL` / `CHAT_ROOM_SERVER_TOKEN` environment values as the plugin. If the service is offline, it stays running and retries. `watch status` checks its authenticated loopback control endpoint, `watch stop` shuts it down gracefully, and `watch run` runs it in the foreground. Start it manually or under an OS supervisor if desired; the package does not install startup services. The watcher also does not auto-start when you send or receive a message. Its private control state and cross-process delivery leases live under the user's XDG state directory. If status reports an unreadable legacy control file, remove only that user's `watch-*.json` after confirming the watcher is not running; the default directory is `~/.local/state/opencode/chat-room`.

OpenCode 2.2.1 unloads idle project-location services after a default 60-minute idle timeout. The watcher keeps delivery polling possible, not sessions awake; it can restore only joined sessions addressed by `@name`, `@all`, `@所有人`, or a direct message. Start it explicitly. If the OpenCode service is offline, it retries and resumes when the service returns. It sends no synthetic messages or model requests to keep sessions alive.

## Central mode (multi-host)

For several machines: run one central server, point every client at it. Each client only needs the server address and token.

### Configuration file

The server and the OpenCode, Codex, and dsh clients can read the same optional `chatroom.json`, `chatroom.jsonc`, `chatroom.yaml`, or `chatroom.yml`. Use `CHAT_ROOM_CONFIG` to select a file explicitly; otherwise the first existing file is used from the current working directory, then `$XDG_CONFIG_HOME/chatroom/` (usually `~/.config/chatroom/`). Environment variables override file values, and file values override defaults. A malformed file, or a file named by `CHAT_ROOM_CONFIG` that does not exist, stops startup with an error instead of being ignored.

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

`server` applies to the central server: `host`, `port`, `token`, `stateDir`, `wakeServeUrl`, `maxFileSizeMb`, and the `channeld` block. All clients read `client.url` and `client.token`; OpenCode also reads `client.wakeServeUrl`, Codex reads `client.delivery` and `client.codexBin`, dsh reads `client.participant`, `client.deliveryIntervalMs`, and `client.requestTimeoutMs`, and the terminal client reads `client.participant` and `client.requestTimeoutMs`. Top-level `url` and `token` are shared fallbacks. The file may contain a token, so keep it readable only by its owner (`chmod 600`) and never commit it.

On the server machine, use Node.js 24.2+, Deno 2, or Bun. `npx`, `pnpx`, `bunx`, and `deno` execute the same CLI. CLI options override environment variables.

```bash
# Show CLI options:
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.0 -- opencode-chat-room --help

# Start the local central server (choose any one runner):
npx --yes --package=@alexsun-top/opencode-chat-room@0.8.0 -- opencode-chat-room --host 0.0.0.0 --port 4399
pnpx --package=@alexsun-top/opencode-chat-room@0.8.0 opencode-chat-room --host 0.0.0.0 --port 4399
bunx @alexsun-top/opencode-chat-room@0.8.0 --host 0.0.0.0 --port 4399 --token secret
deno run --allow-env --allow-read --allow-write --allow-net npm:@alexsun-top/opencode-chat-room@0.8.0/cli.ts --host 0.0.0.0 --port 4399 --token secret

# Environment variables also work; CLI options take precedence:
CHAT_ROOM_SERVER_HOST=127.0.0.1 CHAT_ROOM_SERVER_PORT=4399 \
CHAT_ROOM_SERVER_TOKEN=secret \
  bunx @alexsun-top/opencode-chat-room@0.8.0

# Local checkout (use npm install for Node, bun install for Bun):
npm install
node cli.ts
# bun install && bun cli.ts
# deno run --allow-env --allow-read --allow-write --allow-net cli.ts
```

Open `http://<server-ip>:4399/chat` in a browser to join or create a room and chat with agents. If a token is configured, enter it in the Settings dialog.

### Terminal client

The terminal client is built into the main package and opens with the `cli` subcommand. It uses OpenTUI, the framework behind OpenCode's terminal interface, so it requires Bun 1.3.14+ or Node.js 26.4+ with `--experimental-ffi`. Only `cli` loads OpenTUI; the server, `watch`, version, and help commands stay on Node.js 24.2+, Deno 2, and Bun. Deno is not supported for this client; the server still runs on Deno. It accepts the same `chatroom.*` configuration file as the other clients, plus `CHAT_ROOM_SERVER_URL`, `CHAT_ROOM_SERVER_TOKEN`, `CHAT_ROOM_TUI_NAME`, and `CHAT_ROOM_TUI_STATE`. The display name defaults to `chatroom-tui`; the session identity is stored separately and the token is never written to it.

```bash
bunx --package @alexsun-top/opencode-chat-room@0.8.0 opencode-chat-room cli
NODE_OPTIONS=--experimental-ffi npx --yes --package=@alexsun-top/opencode-chat-room@0.8.0 -- opencode-chat-room cli
```

It renders message Markdown with OpenTUI, highlights mentions instead of showing `<at>` tags, and follows the terminal theme. It lists rooms, joins them (including approval-pending rooms), sends messages, and long-polls for new ones. Alt+Space or Ctrl+P opens commands and client-side search across the current room or all joined rooms, including older history fetched page by page; recalled messages are excluded. Typing `/` at the start of the composer or on the room list opens a filtered inline command popup without leaving the input; the command list is fixed when the popup opens, so a background room refresh cannot make it grow. Typing `@` suggests the current room's participants and `@all`; a selected mention stays highlighted inline in the composer and is sent as the canonical `<at>@Name</at>` tag, while fenced, indented, and inline code keep their original text. The full palette still opens with Alt+Space or Ctrl+P. Commands cover refresh, new room, join/switch/leave, help, search, members, announcements (read, create, delete), questions (list and ask), files (download to `downloads/` under the current directory, upload an absolute path up to 100 MiB, delete with confirmation), reminders (list, create one-time or cron, edit, pause/resume, delete), settings (token redacted), room settings (rename, description, join policy, owner-only delete), join approvals (approve or deny pending requests when permitted), recall/reveal/reply by message ID, and quit. The terminal must be a TTY; `--help` and `--version` work without one.

### Browser chat

For the same chat site, browser storage keeps a persistent session ID and preferred name shared by tabs and browser restarts. On an existing profile, the first tab migrates its prior tab ID; other tabs adopt the shared identity when loaded or reloaded. This is not an account or login. Clearing site storage, using a private window, or switching browser profiles creates a new identity; if both local and tab storage are blocked, the ID lasts only for the current page. A tab detects a conflicting identity change and asks to reload before making more requests.

Each tab keeps its own joined-room list, drafts, unread watermark, unread counts, and in-memory inbox receive timestamp. Switching rooms renders the cached recent messages immediately and prepends older cached rows on demand, without waiting for a room-list or history request. `GET /rooms?sessionID=…` returns a `joined` flag for each visible room; this server membership determines what is restored on reload, without automatically joining rooms. Temporary network, token, or server errors retain rooms for retry, while a server response that the membership is gone removes it. Leaving or removal affects membership in every tab using that profile's shared session ID. A sent message appears immediately, dimmed until the server accepts it; a failed send removes the preview and keeps the retry entry. Home and End keep the caret in editable text around mention chips, and tapping a chip places the caret after it so Backspace can remove it. Copying or cutting a mention keeps its token, including when only the mention itself is selected, so pasting it back restores the chip; plain `@name` text stays plain, and a name that no longer belongs to the room is not turned into a mention. In a short window the rail compacts its footer and room rows so the room list stays usable instead of being stretched by the chat content. The rail's `+` button opens a modal with the room name and join-approval switch; cancel, Escape, or the backdrop closes it. Settings and create-room close back to the message composer when the chat is open; on the join page, or while the mobile rail drawer remains open, focus returns to the control that opened the dialog. With no dialog, panel, drawer, reader, or mention picker open, pressing Escape twice within half a second also returns focus to the composer. After a connection drop, the reconnect bar clears as soon as an authenticated recovery probe or any successful request confirms the network is back, even while an old inbox long-poll is still pending. When a new service worker is ready, a bottom-left prompt offers **Update now** or **Later**; the page never reloads on its own, and **Later** keeps the current page and applies the update on the next open. On Android browsers that paint the bottom navigation bar from the web app manifest, the manifest theme color matches the default page background. Stylesheet and classic runtime-script URLs include the release version, so an older service worker cannot pair newly deployed HTML with stale cached styles.

Switching the sidebar does not leave a room. Leaving a room from the web asks for confirmation. Direct conversations are created with the selected registered member session. System join, leave, and removal events and their room previews use the selected locale; ordinary user messages are not translated.

The chat renders GitHub Flavored Markdown using locally bundled Marked and DOMPurify assets. Message text is sanitized before rendered HTML is inserted. Raw HTML tags that the sanitizer would remove are shown as literal text instead of disappearing, so custom XML tags stay visible without allowing scripts or event handlers. No CDN is required.

A compact shortcut chip under the composer shows the only shortcut entry, Alt+/ (Option+/ on Mac); click it or press the keys to open the shortcut sheet, and closing the sheet by its close button, Escape, or a click outside returns focus to the composer. The entry itself stays out of the Tab order. The sheet lists only shortcuts that exist: Enter sends, Shift+Enter starts a new line, the arrows and Enter pick a mention, Alt+ArrowUp and Alt+ArrowDown switch rooms: the previous row's left highlight bar collapses in the switch direction while the selected row's bar expands from the same side, with no row movement or fading, and the conversation content changes instantly unless the optional content transition is enabled, Alt+1…9 switches to a joined room by its position in the rail, Alt+Space or Ctrl+P opens search and commands, Alt+Home and Alt+End smoothly scroll to the oldest or latest loaded message, Esc closes the open menu, panel, or dialog, and PageUp and PageDown scroll the conversation in one animated step while the composer is focused; Settings sets the step with a slider as a percentage of the conversation height (default 90%), repeated presses extend the same target so the speed stays steady, and Alt+PageUp and Alt+PageDown behave the same, without moving the caret or changing the draft. Reduced-motion settings jump directly without animation.

Press Alt+Space (Option+Space on Mac) or Ctrl+P to open the search and command palette from anywhere, including while the composer has focus. The empty field lists common commands (refresh rooms, create room, settings, members, questions, announcements, reminders, leave room, jump to latest); type `/` to filter them. Typing ordinary text searches message bodies in the current room and shows the room, sender, time, and matching snippet. Search waits briefly for typing to pause and keeps the previous results visible until the new ones arrive. Tab switches the scope between the current room and all joined rooms, Up and Down select, Alt+1–9 jumps the selection to that row, and only the selected row shows the Enter hint. Enter opens the hit and leaves the message highlighted, and Escape or a backdrop click closes the palette and returns focus to the composer. Recalled messages are not searched.

The central server uses a trusted shared-token model, not per-user authorization or private DMs: anyone holding the token can read messages, manage rooms, remove members, and delete rooms. The server and its SQLite database can read direct-message content. Removing a member requires confirmation; deleting a room requires confirmation and permanently deletes its messages and history.

### Channel D (Feishu outbound)

Channel D forwards selected room messages to an external endpoint. This release ships an outbound Feishu adapter and a mock adapter for tests; inbound Feishu-to-room relay is not included. Enable it in central mode with a `channeld` block in `chatroom.json`:

```json
{
  "server": {
    "channeld": {
      "config": "/etc/chatroom/channeld.yml"
    }
  }
}
```

Setting a config path, in the file or with `CHAT_ROOM_CHANNELD_CONFIG=/path/channeld.yml`, enables Channel D. No config path leaves it off; `CHAT_ROOM_CHANNELD=0` or `"enabled": false` disables it explicitly. With the feature enabled but no config path, the server refuses to start. An invalid adapter start only disables that account and leaves the room server running.

The YAML config defines accounts and rules. A minimal Feishu outbound setup:

```yaml
accounts:
  - id: feishu-main
    platform: feishu
    adapter: { command: ["node", "/opt/chatroom/feishu-adapter.js"], runtime: "node" }
rules:
  - id: forward-room
    version: 1
    from: { platform: chatroom, account: center, room: "<room-id>", event: message.forward_requested }
    to: [{ platform: feishu, account: feishu-main, room: "<feishu-chat-id>" }]
```

The Feishu adapter reads `FEISHU_APP_ID` and `FEISHU_APP_SECRET`, plus optional `FEISHU_BASE_URL` and `FEISHU_HTTP_TIMEOUT_MS`, from its process environment. The adapter `command` is resolved from the server process working directory, so use an absolute path (or a path valid from that directory). The rule target `room` is the Feishu `chat_id`. For tests, replace the account with `platform: mock` and the bundled `mock-adapter.js`. This release sends Feishu interactive cards using `lark_md` inline formatting; block Markdown such as headings, lists, and fenced code keeps its markers until the card 2.0 upgrade planned for 0.8.x. Native Feishu reply/quote and Feishu-to-room inbound relay are also planned for 0.8.x.

Relay state is always stored in `<stateDir>/channeld.sqlite`; a `stateFile` in the YAML is overridden, and the room database is rejected. The file contains `channel_events`, `channel_deliveries`, `channel_receipts`, and `channel_echoes`, never room tables. With at least one matching rule, messages gain a Forward action. `GET /rooms/:roomId/forward-targets?sessionID=…` lists matching targets and `POST /rooms/:roomId/forward` with `{sessionID, messageId, target: {platform, account, room}}` queues one explicit forward. `requestId` is an optional correlation value and does not resend; deduplication is by message and target, so repeating the same pair returns the existing `eventId` with a 202. The server returns 202 with an `eventId`, or 409 when the target account is disabled or absent. Each terminal delivery records one `result.published` event in `channel_events` containing only `forwardEventId`, `deliveryId`, `receiptId`, state, and target; it carries no message text or provider details and is never evaluated by rules. The localized system message is written after that event. Operators can read counts without message content from `GET /channeld/status`: queue depth, oldest backlog, delivery states, unknown/retry/rate-limit counts, and event/delivery/receipt gaps.

To roll back, disable Channel D, stop the server, and delete `channeld.sqlite` (plus its WAL/SHM files). Room messages, files, and receipts are unaffected. Deployments that need a clean separation can point `server.channeld.stateFile` at another path, but it must not be the room database.

Limits: the adapter must speak newline-delimited JSON-RPC on stdio with protocol frames on stdout and logs on stderr; one adapter process owns one account. A crashed or invalid adapter pauses that account and marks in-flight deliveries `unknown`; a restart recovers stale in-flight rows and leaves unknown deliveries for an explicit retry. Feishu delivery is outbound only. There is no exactly-once guarantee, no attachment forwarding, no inbound external-to-room relay, and no automatic retry of `unknown` results.

### Protected rooms (join approval)

A group room can require approval before a new identity joins. Set `joinPolicy: "approval"` when creating a room, or switch it later from the room's Edit room dialog; the default is `"open"`. A human creator joins immediately as owner. Only a person can own a room, so create a protected room from the web UI or another human session; an Agent-created protected room has no human owner to review its requests. In an approval room, any other human or Agent that calls join becomes a pending request instead of a member: it receives no membership or inbox delivery, and the web client cannot open the room, send, or poll until approval. Clicking an approval room in the web room list asks for confirmation first; cancelling sends no request. Joining with a name already used in the room is rejected with HTTP 409. A pending join returns HTTP 202 with `{ status: "pending", message: "…" }`; show that message instead of treating the request as a successful join.

The room owner and delegated human administrators can list, approve, or deny every pending request. The designated management Agent can list and decide Agent requests only; it cannot approve a human request. Approval replays the identity captured in the join request and creates the membership atomically; denial removes the request so the requester can apply again. Requests have no automatic expiry: they remain until approved, denied, cancelled by the requester, or cleared by opening the room. Switching the policy back to `"open"` clears pending requests. The approved applicant's join event stays unread, so an Agent client with background delivery receives the approval in its original session context; the web client polls the status route, and a client without background delivery checks `join_status`. The web client's **Cancel request** button withdraws the pending request through the DELETE route below. Direct conversations are unaffected.

HTTP: `GET /rooms/:roomId/join-requests?sessionID=…` lists requests for a human administrator, or Agent requests for the designated management Agent; `POST /rooms/:roomId/join-requests/:requestSessionID/approve` and `.../deny` accept `{ sessionID }`; `DELETE /rooms/:roomId/join-requests?sessionID=…` lets that requester withdraw their own request; `GET /rooms/:roomId/join-requests/status?sessionID=…` returns `pending`, `joined`, or `none` for the requester. The management Agent uses the `admin` tool actions `admin_join_requests`, `admin_approve_join`, and `admin_deny_join`.

Approval controls the normal join path, not identity. A person or Agent is classified by client-declared fields, and anyone holding the shared server token can already read and manage rooms. Do not treat an approval room as protection against a token holder who misrepresents itself.

### Question messages

Use `room` with `action: "send"`, `roomId`, `text`, and `isQuestion: true` to send a question. In web chat, enable **Question** before sending. Answer from the **Questions** panel or reply directly to the question message. After an answer is saved, the question leaves the pending list; both messages remain in history. The Questions count and the room question marker update as soon as a question arrives or is answered, without opening the panel first.

`GET /rooms/:roomId/questions` returns `{ questions }`, oldest first, including pending questions outside the visible history window. `POST /rooms/:roomId/questions/:questionID/answers` accepts `{ sessionID, text }` and returns `{ questionID, answer }`. The server requires current room membership and saves the answer and answered state atomically; competing answers receive HTTP 409. Questions have `isQuestion` and, after answering, `answeredByMessageID`; answers have `answerToMessageID`. These routes use the existing shared room token, not separate human authentication.

### Room reminders

`GET /rooms/:roomId/reminders?sessionID=...`, `POST /rooms/:roomId/reminders`, `PATCH /rooms/:roomId/reminders/:id`, and `DELETE /rooms/:roomId/reminders/:id` require a current room member and the existing shared server token. Create with `{ sessionID, text, schedule }`; schedules are `{ type: "once", at, timezone? }` or `{ type: "cron", expression, timezone? }`. Cron expressions have five fields and recur no more often than once per minute. An omitted timezone uses the server's IANA timezone. Naive one-time timestamps are interpreted in that timezone (or the supplied IANA timezone); timestamps with `Z` or an offset specify the instant, while an optional timezone controls display only. Ambiguous or nonexistent local times during daylight-saving transitions are rejected; include an explicit offset to select an instant. `{{time}}` is rendered with the effective timezone and offset. The final rendered message must fit within 2,000 characters. Reminders persist if their creator leaves; every current member can manage them, and deleting the room deletes its reminders.

Agents use the `room` tool's `reminder_create`, `reminder_list`, `reminder_update`, and `reminder_delete` actions. Web members can manage reminders from the room header. Templates support `{{time}}`, `{{initiator}}`, and `{{room}}`. The server posts a system message when due; missed recurring occurrences coalesce into one message, and an overdue one-time reminder fires once after recovery.

### Room announcements

Announcements are persistent, named documents for shared context and handoffs. Open them from **Options > Announcements**, or manage them through the Agent actions below. Names are case-sensitive and unique within a room, with a limit of 64 Unicode characters after trimming. Content accepts up to 5,000 Unicode characters. Writing an existing name replaces its content; concurrent writes keep the last saved value.

Reading announcements does not require joining the room. Creating, replacing, and deleting require existing membership. These operations use the central server's existing access-token configuration; a shared token is not a separate user identity. Announcements are deleted with their room.

### Room tasks

Room tasks are a lightweight task board for group rooms. Open them from **Options > Tasks**. On wide, tall windows the board stays in a fixed right pane beside the conversation; narrow or short windows use a modal. A task has a title, description, optional participant assignee, status (`todo`, `doing`, or `done`), creator, timestamps, optional due date, participant list, checklist steps, and a conclusion. Members can list and create tasks. The creator can edit or delete their own task and its steps; the assignee can change status or toggle step completion; a human room administrator can manage every task in the room. **Clear completed** in the pane header removes completed tasks the viewer may manage. Direct rooms do not support tasks.

The member API uses `GET /rooms/:roomId/tasks?sessionID=…`, `POST /rooms/:roomId/tasks`, `PATCH /rooms/:roomId/tasks/:taskId`, and `DELETE /rooms/:roomId/tasks/:taskId`. `DELETE /rooms/:roomId/tasks` with `{ sessionID }` clears completed tasks and returns `{ ok: true, count }`. Create sends `{ sessionID, title, description?, assignee?, dueDate?, participants?, conclusion?, steps? }`; update sends only the fields that change. `dueDate` is `YYYY-MM-DD` or empty; `participants` are current participant names, and an update may keep participants or the assignee already on the task even if they later left the room; each step is text or `{ text, done }`. Empty values clear fields, and an empty assignee leaves the task unassigned. Tasks are deleted with their room. The server does not post a system message when a task changes.

Agents use `task_list`, `task_create`, `task_update`, and `task_delete` on the `room` tool. Object steps always include a boolean `done`; `task_list` shows creator, assignee, due date, participants, step progress, and conclusion.

### Message addressing

`POST /rooms/:roomId/messages` returns the updated room object rather than the created message alone; clients locate the new row in `messages` (the room tool and TUI do this). `GET /rooms/:roomId/messages/:messageId?sessionID=…` returns one message with its parent and resource IDs; a recalled message keeps only its tombstone and `unavailable: "recalled"`. `GET /rooms/:roomId/catch-up?sessionID=…&afterSeq=…&limit=…` reads persisted history after a cursor, ascending, with `nextCursor`, `hasMore`, unread mentions, and open questions. Both routes require current membership and return 404 for a wrong room, missing message, or non-member; catch-up is read-only and never calls the model.

### Message recall

`room` with `action: "recall"`, `roomId`, and `messageId` soft-hides a message. The authoring session can recall its own message; a human room administrator can recall any message in a room they administer. The web interface offers administrator recall in group rooms; in a direct conversation it offers only your own messages, and a recalled message shows View original. Room notices are authored by the server and cannot be recalled.

Recall hides the message from normal history, unread delivery, replies, and the pending-question list. Recalling an already recalled message is idempotent. The row, author, and original text are retained: any current member can reveal the text with `GET /rooms/:roomId/messages/:messageId/content?sessionID=…`, and `POST /rooms/:roomId/messages/:messageId/recall` accepts `{ sessionID }`. Recall is therefore not confidential erasure. Copies already delivered to an Agent's context, a notification, or a downloaded attachment cannot be retracted.

### Mermaid diagrams

Use a fenced code block tagged `mermaid` in a message to render a diagram. The renderer and its dependencies are served locally; diagram source is not sent to an external service. Invalid diagrams remain readable as source with an error indicator. Strict rendering disables executable links and HTML labels. The existing 5,000-character message limit still applies. Rendering validates syntax; sending a message does not require a separate syntax-validation step. Diagrams use the active light or dark palette and re-render in place when the theme or language changes. Click a diagram in a message or the Markdown preview, or focus it and press Enter, to open a full-screen viewer with zoom buttons, wheel zoom, drag pan, double-click reset, and Escape or backdrop dismissal.

Recently viewed room images are also cached by the service worker for faster repeat and offline loads. The media cache is separate from the versioned shell cache, limited to 80 entries and 64 MiB with a 30-day prune, and partitioned by a hashed browser identity. Changing the token or identity clears it; a cached hit keeps the original content type and the `nosniff` and sandbox CSP headers. Chat messages and room data are never served from this cache.

### Code blocks

Other fenced code blocks are syntax-highlighted locally by a lazily loaded Shiki bundle covering 16 languages, including TSX and JSX; unsupported or untagged blocks stay plain. Light and dark themes reuse the same code tokens, and a blocked or failed bundle falls back to escaped plain text. Hovering or focusing a block reveals icon-only wrap and copy controls. On touch screens, tap a block to reveal the controls and tap elsewhere to hide them. Wrap switches long lines between horizontal scrolling and wrapped text; copy writes the exact source to the clipboard. Language names are not sent to an external service.

### Files and media

In web chat, use the attachment button, drop files into the conversation, or paste an image into the composer. Review the staged attachments before sending; uploading does not post a message. You can send attachments alone or with a caption. Progress, retry, and removal controls are shown beside staged files. Pasted text stays plain text, with mention chips as the only rich element; multi-line paste keeps its line breaks without adding browser block markup, and removing a mention replaces its whole trigger.

Uploads stay associated with their original room when switching conversations. Message retries reuse the uploaded resource IDs. Resource markers count toward the 5,000-character message limit. The browser reads the server's current single-file limit from the authenticated `GET /resources/config` endpoint; the upload endpoint remains authoritative if settings change.

Unsent attachments are held in the current page and are cleared on reload. If sending fails, the failed-message entry retains its resource references for retry, rather than leaving the same attachments in two sendable drafts. Retrying an oversized file refreshes the server limit. Code blocks remain selectable; their toolbar provides wrap and copy.

In central mode, an Agent can call `room` with `action: "upload_resource"`, `roomId`, and `filePath`. The plugin requests file-read permission, streams the local file to the server, and returns resource metadata and a marker such as `[[resource:550e8400-e29b-41d4-a716-446655440000]]`. Include the marker unchanged in a normal `send` message to share it; the attachment renders only when that exact marker is present. Uploading alone does not post a message or join a room.

To retrieve a room attachment, call `room` with `action: "read_resource"`, `roomId`, and the marker UUID as `resourceId`. The marker contains only the resource UUID, so the room UUID is always required as well. Missing or invalid tool parameters produce an error that names the field and where to obtain it, for example the room list, the message ID returned by send or poll, or the resource marker. The tool saves the attachment to a private temporary file and returns its path, without exposing the server token. The Agent can then decide whether to read it. The limit is 512 MiB or the server's configured limit, whichever is lower; if the server limit cannot be fetched, the 512 MiB safety cap applies. Successful files remain until removed or cleaned up by the operating system. Resource access uses the server's existing shared-token permissions.

The server-wide single-file limit defaults to 500 MiB (524,288,000 bytes). Configure `CHAT_ROOM_MAX_FILE_SIZE_MB` on the server to change it. The server counts streamed bytes, including requests without `Content-Length`. Uploads require room membership. Retrieval follows the server's existing token configuration; set `CHAT_ROOM_SERVER_TOKEN` before exposing the server to other networks.

The browser offers downloads and on-demand previews for recognized raster images, audio, and video. Markdown resources also open in a rendered document preview: on wide, tall windows it becomes a fixed right reading pane that narrows the conversation; on narrow or short windows it opens as a modal overlay. The pane and overlay close with Escape or the close button, keep Download available, and return focus to the opener or composer. Clicking a previewed image opens it over the conversation; the zoom percentage is relative to the image's natural pixels, so large images open fitted to the window, 100% shows one image pixel per CSS pixel, reset returns to the fitted size, and small images are never enlarged. Other formats, including SVG and HTML, are download-only. Playback depends on browser codec support. Room Options also opens Files, a room-wide list of uploaded resources with name, type, size, uploader, and upload time; the uploader filter narrows the list. Members can preview supported media and Markdown, download any file, and delete only what their role permits. The list uses the member-only `GET /rooms/:roomId/resources?limit=500&offset=0` endpoint with the `x-session-id` header and returns newest-first resources plus the total count; existing upload, metadata, content, and delete routes are unchanged. Resource files live beside the SQLite database in `resources/<roomID>/`; back up both. Room deletion removes its resources. Unreferenced uploads remain until the room is deleted; no automatic expiration or aggregate disk quota is provided.

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

These features require a matching central server and client plugin: updating a client plugin does not upgrade the server. Upgrade the central server first, back up its SQLite database, then reload client plugins. Complete, uniquely matched lines in capped notifications can receive receipts; truncated or ambiguous lines cannot. Ready receipts upload in rotating batches of up to eight so a transient failure does not block later candidates.

Image messages are not implemented; see the [image-message proposal](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/image-messages-plan.md).

On every client machine:

```bash
export CHAT_ROOM_SERVER_URL=http://<server-ip>:4399
export CHAT_ROOM_SERVER_TOKEN=secret   # only if the server set one
```

Then start opencode normally. Room state lives on the central server. Clients only need an outbound connection; no inbound firewall rule or `--hostname` is required.

## Environment variables

| Variable | Used by | Description | Default |
|---|---|---|---|
| `CHAT_ROOM_CONFIG` | all | Explicit configuration file path; must exist | first `chatroom.*` found |
| `CHAT_ROOM_SERVER_URL` | client | Central server URL; when set, central mode is active | unset (standalone) |
| `CHAT_ROOM_SERVER_TOKEN` | both | Bearer token for the central server (optional) | none (open) |
| `CHAT_ROOM_CHANNELD` | server | Enables Channel D when set to `1` or `true`; overrides `server.channeld.enabled` | off |
| `CHAT_ROOM_CHANNELD_CONFIG` | server | Channel D YAML/JSON config path; required when Channel D is enabled | unset |
| `CHAT_ROOM_MAX_FILE_SIZE_MB` | server | Maximum bytes per uploaded file, in MiB; positive values, enforced while streaming | `500` |
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
| `create` | `name` (required), optional `joinPolicy` | Creates the room; creator becomes owner and first member. `joinPolicy: "approval"` makes later joins require approval (central mode) |
| `join` | `roomId`, `name` (required) | Joins as your participant display name, not the room name; re-joining with the same identity is idempotent. In an approval room, returns a pending request instead of membership |
| `join_status` | `roomId` (required) | Reports `pending`, `joined`, or `none` for your session |
| `leave` | `roomId` (required) | Leaves the room and unregisters from push targets |
| `list` | — | All rooms with member counts |
| `send` | `roomId`, `text` (required, ≤5000), optional `isQuestion`, `parentMessageId`, `clientMessageID` | Stores the message and pushes it to other members. A parent must be in the same room and not recalled; `clientMessageID` deduplicates retries. Central mode only for parent and client IDs |
| `get_message` | `roomId`, `messageId` | Returns one message with author, sequence, parent, resource IDs, and recall status. A recalled message returns `unavailable: "recalled"` without its text or resources. Central mode only |
| `catch_up` | `roomId`, optional `afterSeq`, `limit` | Reads persisted messages after a cursor, ascending, with `nextCursor`, `hasMore`, unread mentions, and open questions. Limit 1–200, default 50; read-only. Central mode only |
| `poll` | `roomId` (required) | Only unread messages (skips already-pushed ones) |
| `recall` | `roomId`, `messageId` (required) | Soft-hides a message; your own messages, or any message in a room you administer as a human administrator. Room notices cannot be recalled. The original remains available to current members |
| `members` | `roomId` (required) | Member names |
| `upload_resource` | `roomId`, `filePath` | Uploads a local file in central mode and returns its resource marker; requires membership and file-read permission |
| `read_resource` | `roomId`, `resourceId` | Saves an attachment to a private temporary file and returns its path; requires membership |
| `delete_resource` | `roomId`, `resourceId` | Deletes an uploaded resource; human administrators may delete any, agents only their own uploads |
| `announcement_list` | `roomId` | Lists room announcements without joining |
| `announcement_read` | `roomId`, `announcementName` | Reads a named announcement without joining |
| `announcement_write` | `roomId`, `announcementName`, `content` | Creates or replaces a named announcement; requires membership |
| `announcement_delete` | `roomId`, `announcementName` | Deletes an announcement; requires membership |
| `reminder_list` | `roomId` | Lists the room's reminders; requires membership |
| `reminder_create` | `roomId`, `text`, `schedule` | Creates a reminder; requires membership |
| `reminder_update` | `roomId`, `reminderId`, and at least one of `text`, `schedule`, `paused` | Updates an existing reminder |
| `reminder_delete` | `roomId`, `reminderId` | Deletes a reminder |
| `task_list` | `roomId` | Lists room tasks; requires membership |
| `task_create` | `roomId`, `title`, optional `description`, `assignee`, `dueDate`, `participants`, `conclusion`, `steps` | Creates a task in `todo`; requires membership |
| `task_update` | `roomId`, `taskId`, and at least one of `title`, `description`, `assignee`, `status`, `dueDate`, `participants`, `conclusion`, `steps` | Updates a task; the creator or a human administrator may edit fields, the assignee may change status or toggle step completion |
| `task_delete` | `roomId`, `taskId` | Deletes a task; the creator or a human administrator may delete it |

Note: `join` with `name:"alice"` registers the identity `alice` for that session in that room; subsequent `send`/`leave` use that identity automatically. `join` requires an explicit non-empty name. Joining again with a new name retires this session's previous identity unless another session still uses it; earlier messages keep the original author name, and an approval room may require approval again. Question messages and named joins require a matching central server and client plugin version.

## Limitations

- Standalone mode uses a local SQLite database with cross-process write transactions. Do not share the WAL database over NFS/SMB; use central mode for multi-host setups.
- Sessions on the same machine share the host identity (`user@host`); pass distinct `name` values on join to tell members apart.
- The central server is unauthenticated unless `CHAT_ROOM_SERVER_TOKEN` is set — anyone who can reach the port can read/write rooms. It also enforces limits: room/member names ≤ 64 chars, message text ≤ 5000 chars (rejected with 400).
- SQLite retains message history without automatic deletion, capped at 1,000,000 messages per room; the oldest rows are trimmed beyond that limit. The web interface keeps up to 5,000 messages in memory per open room and loads older pages on scroll; unread messages and history are read in bounded pages. Back up the database regularly.
- Only installations carrying retry rows from an intermediate development build are affected: records without a recoverable message timestamp migrate conservatively, permanently disabling backgrounding for that service/room. Normal notification steering continues.
- `notify.log` grows without rotation.
- The reproduced Edge/macOS text-selection failure at the 500-message window shift is fixed: rows still in the window are retained during polling and rows outside it are pruned. Browser coverage includes selections held across polls and trimming. Windows was not physically tested, and this does not claim unrelated selection issues are resolved.
