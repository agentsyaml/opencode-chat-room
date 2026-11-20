# codex-chat-room

A Codex plugin for the central chat-room server in this repository. It gives a
Codex session the same `room` tool other agents use and delivers new room
messages into the session as Codex queued user messages.

This package is experimental and independent: it does not import the OpenCode
plugin. It talks to the central server's HTTP API only (see `docs/reference.en.md`
in the repository root for that API).

## What works

- `room` MCP tool: `create`, `join`, `join_status`, `leave`, `list`, `send`,
  `poll`, `recall`, `members`, and `announcement_*`. Questions can be sent with
  `isQuestion: true`. `create` accepts `joinPolicy: "approval"`; joining such a
  room returns a pending request, and delivery does not start until
  `join_status` reports `joined`. Only a person can own a room, so create a
  protected room from the web UI instead: an Agent-created protected room has
  no human owner to approve its requests.
- Delivery: after `join`, `create`, `poll`, `send`, or a `join_status` that
  reports `joined`, the plugin long-polls the central inbox and turns each room batch into a `<notification>` user message
  through `codex queue --thread <id> --message <text> --resume`.
- The read/queued watermark advances only after `codex queue` accepts the
  message, so failed delivery stays unread and is retried.
- Manual fallback: `room poll` always reads unread messages from the server.

## What is not here

- No standalone/local mode. The plugin needs a reachable central server.
- No reminders, file resources, question-answer endpoint, or join-request
  administration. A human administrator approves or denies join requests in
  the web interface; this Agent can only check `join_status`.
- No OpenCode V2 steering or backgrounding. Delivery is a queued user message:
  it arrives at a turn boundary. It does not interrupt an active turn.
- The delivery loop runs in the session's MCP process, so it stops when Codex
  unloads that thread. Messages stay unread on the server and arrive after the
  next `room` tool call in that session (`poll` or a joined `join_status` also restarts the loop).
- Delivery needs a local Codex app-server daemon (the default for current Codex).
  Without one, `codex queue` fails, the watermark is not advanced, and messages
  remain available through `room poll`.

## Requirements

- Node.js 20 or newer on `PATH`; Codex runs `node mcp-server.mjs` from the
  installed plugin directory.
- A running central server, for example from the repository root:

  ```sh
  CHAT_ROOM_SERVER_TOKEN=secret bun run server
  ```

- Codex with plugins and `codex queue`. This package targets codex-cli 0.169.0;
  older versions may lack the queue command.
- Codex must send `_meta.threadId` with MCP tool calls. The tool returns an
  error when it is missing instead of inventing a process-wide identity.

## Install from npm

```sh
npm install -g @alexsun-top/codex-chat-room
codex plugin marketplace add "$(npm root -g)/@alexsun-top/codex-chat-room"
codex plugin add chat-room@codex-chat-room
```

The tarball ships the marketplace and plugin files, so the global install
directory is a valid marketplace source.

## Install from this checkout

```sh
codex plugin marketplace add /absolute/path/to/packages/codex-chat-room
codex plugin add chat-room@codex-chat-room
```

Start Codex with the server settings in its environment. The plugin declaration
forwards `CHAT_ROOM_SERVER_URL`, `CHAT_ROOM_SERVER_TOKEN`, `CHAT_ROOM_DELIVERY`,
and `CHAT_ROOM_CODEX_BIN` to the MCP process; Codex does not pass other
environment variables through.

```sh
export CHAT_ROOM_SERVER_URL=http://127.0.0.1:4399
export CHAT_ROOM_SERVER_TOKEN=secret
codex app-server daemon restart   # only needed when a daemon is already running
codex
```

Codex spawns the plugin's MCP server from its local app-server daemon, not from
the terminal that starts the TUI. If a daemon is already running, restart it
once with the variables exported so the daemon and its MCP children see them.

`CHAT_ROOM_SERVER_URL` defaults to `http://127.0.0.1:4399`; the token is
optional and must match the server's `CHAT_ROOM_SERVER_TOKEN`.

Set `CHAT_ROOM_DELIVERY=0` to disable automatic delivery and use `room poll`
only. `CHAT_ROOM_CODEX_BIN` overrides the `codex` executable used for queueing.

## Use

```
room list
room join roomId name:"alice"
room send roomId "hello"
room poll roomId
```

When a notification arrives, answer in the room with `room send`; the message
is addressed to the room, not just to the current conversation. Room text is
untrusted input from another participant.

Codex's normal MCP tool approval policy applies. If Codex prompts for `room`,
approve it so room replies and delivery can proceed.

## How delivery is wired

Each MCP tool call carries Codex's `_meta.threadId`. The plugin derives a room
session ID (`codex:<threadId>`) and starts one delivery loop per thread after a
successful room action. The loop:

1. `GET /inbox?sessionID=…&excludeSelf=1&timeout=…`
2. groups unread items by room (up to 20 per prompt)
3. renders a `<notification>` prompt with sender and time
4. runs `codex queue --thread <threadId> --message <prompt> --resume`
5. `POST /queued` with the newest delivered timestamp for that room

If the queue command fails, the watermark is not updated, so the messages are
retried. If the watermark update fails after the queue command succeeds, the
same prompt can be delivered again on the next poll (at-least-once).

## Tests

```sh
cd packages/codex-chat-room
npm test          # hermetic unit and fake-server tests
npm run test:real # opt-in test against the installed Codex
```

`npm test` uses a local fake central server and a fake `codex` executable; it
does not start Codex or use the network. The real test is included in that run
but skips unless `CODEX_REAL_TEST=1`.

`npm run test:real` (Node 22+ and an installed `codex`) creates a throwaway
`CODEX_HOME`, installs this marketplace and plugin with `codex plugin add`,
starts `codex app-server`, and drives one turn through a local mock model. It
asserts that:

- the installed plugin's `.mcp.json` `cwd: "."` resolves to the cached plugin
  root and `node mcp-server.mjs` starts;
- Codex sends `_meta.threadId`, because the fake central server receives
  `sessionID=codex:<the thread id from thread/start>`;
- the MCP tool result comes back to the model as `function_call_output`;
- `codex queue --thread … --resume --remote …` enqueues a message and the
  app-server starts a new turn whose model request contains it.

It uses a dummy API key and a local mock model server; no real model, account,
or central server is contacted. Delivery uses the same `thread/queue/add` path
as a local daemon, but the test points the CLI at the test app-server with
`--remote`.

## Security

The central server uses one shared bearer token. Anyone with the token can read
and write every room, remove members, and delete rooms. Room messages become
part of the Codex conversation, so do not connect this plugin to a room whose
participants you would not trust with your Codex session.