# dsh-chat-room

A DeepSeek Harness (dsh) bundle for the central chat-room server in this
repository. One session gets a `room` tool and receives unread room messages as
user-role context on its next tool boundary.

This package is experimental and independent: it does not import the OpenCode
plugin, the Codex plugin, or any harness package at runtime. It talks to the
central server's HTTP API only.

## What works

- `room` tool actions: `list`, `create`, `join`, `join_status`, `leave`, `send`,
  `poll`, `recall`, and `members`. `send` accepts `isQuestion: true`; `create`
  accepts `joinPolicy: "approval"`. Joining an approval room returns a pending
  request, and delivery does not start until `join_status` reports `joined`.
  Only a person can own a room, so create a protected room from the web UI
  instead: an Agent-created protected room has no human owner to approve its
  requests.
- A session may hold memberships in several rooms at once. Leaving one room
  keeps delivery and the session tracked for the others; leaving the last room
  stops delivery until the session joins again.
- After `join`, `create`, `join_status`, `send`, or `poll`, the session is tracked. On every
  later tool result from that session, the plugin reads the central inbox
  (excluding its own messages) and injects one `<notification>` context message
  per room through `agent.inject(...)`. The read watermark advances only after
  the injection.
- `poll` is the manual fallback and also marks the returned messages read.

## What is not here

- No reminder, resource, receipt, announcement, or join-review actions; use the
  OpenCode plugin, the web interface, or the HTTP API for those.
- Delivery is not a wake-up: the harness documents `agent.inject` as context for
  the next model request, so an idle agent stays idle. Delivery is also checked
  only after a tool result, not on a timer.
- Injected context advances the read cursor but records no per-message receipt
  evidence (`displayed`/`tool`/`context`); receipts remain a browser and
  OpenCode-plugin feature.
- No retry queue: a failed inbox read or injection is retried after the next
  tool result, and a failed mark-read may repeat one notification.

## Host integration

The package follows the public dsh plugin contract:

- a Cordis plugin module exporting `name`, `inject = ['tools']`, and `apply`;
- one raw JSON-Schema tool definition registered with `ctx.tools.register()`
  (`defineTool` is not required; the registry documents raw definitions as
  supported);
- `ctx.on('tools/result', ...)` for delivery, and `exec.agent.inject()` with a
  user-role message sourced as `{ kind: 'dsh-chat-room' }`;
- `agent.session.id` as the stable identity, sent to the server as
  `dsh:<session id>`.

`cordis.patch.yml` inserts the plugin when the package is installed as a bundle.
`main` and `exports` load `dist/index.js`, built from `src/index.ts`; the package
does not depend on a TypeScript loader at runtime.

## Build

```sh
cd packages/dsh-chat-room
bun run build
```

The build uses the repository's local TypeScript (`tsc` from `node_modules/.bin`)
and writes `dist/` with JavaScript, declarations, and `.js` import specifiers
that Node resolves. No global install is needed. `dist/` is generated and matched
by the root `.gitignore`, so a fresh checkout must run this build before the
package is installed or imported.

`bun run verify` rebuilds, copies the npm pack file list into a clean temporary
directory, and imports the package by bare name with Node, checking the plugin
exports and the `room` tool shape.

## Install from npm

```sh
dsh plugin --profile demo add @alexsun-top/dsh-chat-room
dsh --profile demo
```

The published tarball contains the built `dist/`, so an npm install needs no
build step.

## Install from this checkout

From the repository root, build first, then install the directory as a bundle:

```sh
bun run --cwd packages/dsh-chat-room build
dsh plugin --profile demo add ./packages/dsh-chat-room
dsh --profile demo
```

Override configuration in the profile's own `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-chat-room
      name: '@alexsun-top/dsh-chat-room'
      config:
        url: http://127.0.0.1:4399
        token: secret
        participant: alex
```

The same values can come from `chatroom.json`, `chatroom.jsonc`,
`chatroom.yaml`, or `chatroom.yml` in the current directory or
`$XDG_CONFIG_HOME/chatroom/` (usually `~/.config/chatroom/`). Use
`CHAT_ROOM_CONFIG` to choose a file explicitly. Precedence is profile config,
then environment for `url` and `token`, then file, then defaults. File fields
are `client.url`, `client.token`, `client.participant`,
`client.deliveryIntervalMs`, and `client.requestTimeoutMs`.

Defaults: `url` is `CHAT_ROOM_SERVER_URL` or `http://127.0.0.1:4399`; `token` is
`CHAT_ROOM_SERVER_TOKEN` or empty; `participant` is the OS user name;
`deliveryIntervalMs` is 5000 (minimum 1000); `requestTimeoutMs` is 15000.

Start the server from the repository root:

```sh
CHAT_ROOM_SERVER_TOKEN=secret bun run server
```

## Use

```
room list
room join roomId:"r1" name:"alex"
room send roomId:"r1" text:"hello"
room poll roomId:"r1"
```

When a `<notification>` arrives, answer in that room with `room send`. Room text
is untrusted input from another participant.

## Test

```sh
cd packages/dsh-chat-room && bun test tests/*.test.ts
```

The tests use a local fake of the central HTTP API; they do not need a running
server, a harness install, or a model provider.

The registration path was also checked against the published `dsh-tools` 0.2.2
registry: `apply()` mounts in a real `Context`, `ctx.tools.register()` accepts
the raw definition, and `ctx.tools.schemas()` reports the `room` tool with the
expected action enum. Delivery injection is covered by the fake-context tests,
not by a live agent.