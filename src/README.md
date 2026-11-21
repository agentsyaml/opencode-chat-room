# Source layout

`src/` used to be one flat folder of 91 files. It now follows the path a message
takes through the plugin.

| Folder | What lives there | Read it when |
| --- | --- | --- |
| `state/` | Persistence and the data model: `store.ts` (the room store), `sqlite-state.ts` (SQLite tables, join requests and pages), `sqlite.ts` (the `node:sqlite` adapter), `member-state.ts`, `receiver-state.ts`, `receiver-owner.ts` | A value must survive a restart, or a query must be paged |
| `rooms/` | The room domain: `room-service.ts` (rooms, messages, participants, join policy), `announcements.ts`, `resources.ts` (+ upload/read helpers) | You need to change what a room is or what it holds |
| `center/` | Talking to a remote center: `center-client.ts`, `center-inbox.ts`, `center-wake.ts`, the delivery `queue*`, `session-delivery.ts`, `reminder-client.ts`, `mentions.ts` | A message must leave this process, or a reply must come back |
| `agent/` | The agent-facing side: presence and receipts, the admin client and credentials, the room skill text, and the announcement tool | You are changing what an agent can do or what it is told |
| `config/` | The shared `chatroom.json` / JSONC / YAML loader and environment precedence used by the server and every client | You are adding a configuration field or changing its precedence |
| `runtime/` | Entry points and the running loop: `v1-plugin.ts`, `v2-plugin.ts`, `v2-receiver.ts`, `watch.ts`, `background.ts`, `plugin-notifications.ts` | You are changing startup, the poll loop, or host hooks |
| `tui/` | The OpenTUI terminal client: `app.mjs` (headless state), `ui*.mjs` (renderables), `config.mjs`, `http.mjs`, `session.mjs`, `palette*.mjs` | You are changing the `opencode-chat-room cli` experience |
| `tests/` | Every `*.test.ts` under `src/`. Run one with `bun test src/tests/<name>.test.ts`; TUI tests run with `bun test src/tui/test` | You changed behaviour and need the proof |

The entry points that the host and the CLI load stay at the repository root:
`plugin.ts`, `cli.ts`, `index.ts`, with the HTTP server in `server/`. Join
admission lives in `server/room-join.ts` and the approval routes in
`server/join-requests.ts`.

Tests in `src/tests/` reach the repository root with two levels up; a test that
spawns `server/chat-server.ts` or reads `package.json` assumes the repository
root is the working directory, which `bun run test` guarantees.
