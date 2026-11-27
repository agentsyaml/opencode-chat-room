# chat-room-channeld

Channel D relay core. One host process connects chat-room endpoints to external
IM endpoints through adapter child processes. Explicit rules turn a source-room
event into frozen deliveries for target accounts; each adapter owns one IM
account and speaks JSON-RPC over stdio.

This package is published as `@alexsun-top/chat-room-channeld`. Platform
adapters, including Feishu, are single files under the top-level
`plugins/` directory, not separate npm packages; their inbound events can be
relayed into one chat-room as notifications and are never matched by outbound
rules. The core launches any adapter through the account's `adapter.command`.

The core ships the source plus the mock adapter entry point. Use
`GET /channeld/status` on the ChatRoom server, or run the CLI from a checkout
with Bun.

## Run from a checkout

```sh
bun src/cli.ts --config channeld.yml
```

Validate a config without touching the state file:

```sh
bun src/cli.ts check --config channeld.yml
# config ok: 1 accounts, 1 rules
```

Inspect queue and integrity counts without writing the state file:

```sh
bun src/cli.ts status --config channeld.yml
```

`status` prints counts and per-account runtime state: `started`, `failed`,
`disabled`, or `unknown` (no live host is attached to a CLI read), plus a short
sanitized `lastError` for failed/disabled accounts. It never prints message text,
rule ids, provider message ids, room ids, or credentials. A missing state file or
missing channel tables exit 1 with a clear error.

Run the mock adapter on stdio (the host normally spawns it):

```sh
bun src/cli.ts mock
```

Requires Node.js 22.13 or newer (the state store uses `node:sqlite`).

Run the suite from a checkout:

```sh
bun test tests/*.test.ts
```

The standalone tarball, once published, includes `tests/` and a self-contained
`tsconfig.build.json`. To build and test from an installed tarball:

```sh
cd node_modules/@alexsun-top/chat-room-channeld
npm install --include=dev
npm run build
bun test tests/*.test.ts
```

Bun is still required for tests.

## Config

```yaml
stateFile: ./channeld.sqlite
accounts:
  - id: im-a
    platform: dingtalk
    adapter: { command: ["node", "/opt/chatroom/dist/mock-adapter.js"], runtime: "node" }
rules:
  - id: project-in
    version: 1
    from: { platform: chatroom, account: lab, room: translation, event: message.created }
    transforms: [ { op: prefix-source }, { op: truncate, max: 2000 } ]
    to: [ { platform: dingtalk, account: im-a, room: project } ]
    onMissingParent: quote_or_unthreaded
    onUnsupported: text_with_notice
```

Transforms run in order and are limited to `prefix-source`, `trim`,
`truncate` (adds `…`), and `quote-preview`. Omitting `from.event` matches every
kind. Account ids, platforms, and room ids must match
`/^[A-Za-z0-9._-]+$/`; `/` is rejected so endpoint keys stay unambiguous.
Account ids and rule `(id, version)` pairs must be unique. Only the highest
configured version of each rule id is active: an explicit newer version
replaces the older definition.

Each account may add an `env` map for secrets and per-platform settings. Keys
must match `/^[A-Za-z_][A-Za-z0-9_]*$/`, values are strings, and a map holds at
most 64 variables. The adapter child inherits the host environment, then receives
the account `env`, then the forced `CHANNELD_ACCOUNT_ID` and `CHANNELD_PLATFORM`
values; configuring either reserved key is rejected. Status output never includes
env values.

An optional top-level `inbound` array turns external events into room notifications
in the center. It is separate from `rules`: an inbound event is committed, written
to its target room once, and then skipped by every outbound rule, so it cannot
ping-pong back to the source.

```yaml
inbound:
  - from: { platform: feishu, account: feishu-main, room: oc_xxx }
    to: { room: lab }
```

`from.room` is the Feishu `chat_id`; `to.room` is the chat-room id. An omitted
`from.event` matches every kind. A source account must exist and its platform must
match. The center appends one system-style message, `[Feishu <account>] <open_id>:
<text>`, with a marker row in the room database; the marker and message share one
transaction, so a transport retry cannot duplicate it. If the room write fails, the
center rolls the channel event back and the adapter acknowledges failure, so Feishu
retries. A room that stays missing keeps failing until it is created.

```yaml
accounts:
  - id: feishu-main
    platform: feishu
    adapter: { command: ["node", "/opt/chatroom/feishu-adapter.ts"] }
    env: { FEISHU_APP_ID: "cli_xxx", FEISHU_APP_SECRET: "xxx" }
```

## Adapter protocol

The host spawns each adapter with `CHANNELD_ACCOUNT_ID`,
`CHANNELD_PLATFORM`, and that account's configured `env`. Both directions use
newline-delimited JSON-RPC 2.0 on stdio. An `initialize` or `start` result may
include `platform`; when it differs from the configured account platform, that
adapter is stopped and only that account is marked `failed` (its queue pauses)
while the host and other accounts keep running. **stdout carries protocol frames only; all adapter logs go to stderr.**
An invalid stdout frame disables that account, stops its adapter, and leaves its
deliveries paused; other accounts keep running. Frames are JSON objects limited
to 1 MiB (`MAX_FRAME_BYTES`). Host request ids start with `host-`, adapter
request ids with `adapter-`.

Host to adapter: `initialize` (protocol/event versions, account, frame limit),
`start` (accounts, cursors), `send` (delivery id, attempt id, idempotency key,
target endpoint, frozen payload), `ping`, `shutdown`.

Adapter to host: `ingest` (an `IngestEvent`) answered with
`{committed:true}` or `{duplicate:true}`, and `ping`. Unknown methods get
JSON-RPC `-32601`.

A JSON-RPC `id` only correlates one request/response within a session; it is not
an idempotency key. Repeating an `id` with different `sourceDedupKey` values is
two distinct events; repeating the same `sourceDedupKey` is one event.

A `send` result is a receipt: `{state, providerMessage?, retryAfterMs?, detail?}`
where state is `sent`, `retryable`, `rate_limited`, `permanent`, `unsupported`,
or `unknown`. A request timeout maps to `unknown`; the host never throws for a
platform outcome.

Sends are serial per account. Inbound ingests are buffered behind an in-flight
send so provider echoes are matched before they can become new events; an
overflow (100 events) disables that account and is logged as an error. After an
overflow drain, every delivery for the disabled account is paused, and the
overflowed event is dropped.

When `CHANNELD_MOCK_EMIT=1`, the mock adapter emits one `message.created` event
from room `in` after starting, so the relay can be exercised end to end.
`CHANNELD_MOCK_ECHO=1` makes it emit a provider echo right after a `send` result;
`CHANNELD_MOCK_ECHO_DELAY_MS` delays that result to exercise buffered ingests.

## Feishu adapter

The Feishu adapter is the generated typed single-file adapter
`plugins/feishu/dist/feishu-adapter.ts`, produced by concatenating the typed
source under `plugins/feishu/src` without a bundler so its TypeScript
annotations stay in the file. It is attached to the GitHub Release instead of being shipped inside the root
`@alexsun-top/opencode-chat-room` package and runs directly under Node 22.18+
through native type stripping (erasable syntax only: no `enum`, `namespace`, or
constructor parameter properties). Outbound it sends interactive
cards and can reply natively to a Feishu message; inbound it can receive group
messages over the event long connection. It speaks the same stdio JSON-RPC protocol
as the mock adapter and has no room or session concepts.

Cards default to card 1.0 with `lark_md`, which keeps the 0.8.0 payload stable.
Set `FEISHU_CARD_VERSION=2.0` to opt into card 2.0 (`schema: "2.0"` with a
`markdown` element), where headings, lists, and fenced code render as block
Markdown. Any other value fails `initialize`.

A payload `parent` with `endpoint.platform: "feishu"`, the same account, and a
non-empty `nativeMessageId` is sent with
`POST /open-apis/im/v1/messages/{parent_id}/reply`; the body has no `receive_id`.
Without a usable Feishu parent the send uses the normal chat endpoint. The center
fills that parent when a forwarded room reply's `answer_to` parent was already
delivered to the same target (`channel_echoes` keeps the provider native id).

The adapter command is resolved from the host process working directory, so
use an absolute path unless the host starts in this package directory.

The child process reads:

- `FEISHU_APP_ID` (required)
- `FEISHU_APP_SECRET` (required)
- `FEISHU_BASE_URL` (optional, default `https://open.feishu.cn`)
- `FEISHU_HTTP_TIMEOUT_MS` (optional, default `10000`)
- `FEISHU_CARD_VERSION` (optional, `1.0` default or `2.0`)
- `FEISHU_INBOUND` (optional, `1` enables the event long connection)
- `FEISHU_INBOUND_CHATS` (required with `FEISHU_INBOUND=1`; comma-separated
  group `chat_id` allowlist)

Set these in the host environment; the host passes its environment to adapter
child processes.

Inbound requires the app to use long-connection event subscription in the Feishu
developer console and to subscribe `im.message.receive_v1`; the bot must already
be in each allowlisted group. The adapter obtains the WebSocket URL from
`POST /callback/ws/endpoint`, pings, reassembles fragmented frames, and
acknowledges only after the host commits the ingest. Only group `text` and `post`
messages from human senders in an allowlisted chat are mapped. Bot/self senders,
other chats, other event types, other apps, and unsupported message types are
acknowledged without ingest. A long-connection start failure logs a warning,
keeps the account started for outbound sends, and reports a sanitized
`inbound failed: ...` in the account status; outbound forwarding keeps working.

```yaml
accounts:
  - id: feishu-bot
    platform: feishu
    adapter: { command: ["node", "/opt/chatroom/feishu-adapter.ts"], runtime: "node" }
rules:
  - id: to-feishu
    version: 1
    from: { platform: chatroom, account: lab, room: translation, event: message.created }
    transforms: [ { op: prefix-source }, { op: truncate, max: 2000 } ]
    to: [ { platform: feishu, account: feishu-bot, room: oc_xxx } ]
```

The target room is the Feishu `chat_id`, so an endpoint
`feishu/<account>/<chat_id>` maps to one Feishu chat.

`initialize` fails when a credential is missing. `start` fetches a tenant access
token, so rejected credentials disable only this account. Tokens are cached and
refreshed when less than 30 minutes remain. A send posts an interactive card and
a `uuid` derived from the delivery idempotency key, so retrying the same delivery
cannot create a second message. Card 1.0 uses one `lark_md` element; card 2.0
uses one `markdown` element. A Feishu parent reference turns the send into a native
reply to that message.

Send outcomes:

- `230020`, `99991400`, or HTTP 429: `rate_limited`; `Retry-After` accepts
  seconds or an HTTP date and defaults to 1000 ms.
- `99991663`: force one token refresh and retry the send once, then `permanent`.
- HTTP 5xx, connection resets, and other fetch network errors: `retryable`.
- Request timeout or abort: `unknown`, never retried automatically.
- Other Feishu codes (for example `230002`): `permanent` with code and message.
- Malformed response: `unknown`.

The adapter never logs message text, credentials, tokens, uuids, or full
payloads. Provider message ids may be logged and returned in the receipt.

## State

The SQLite state file has four tables:

- `channel_events`: committed ingest events, unique by dedup key.
- `channel_deliveries`: one frozen delivery per rule target, unique by
  idempotency key (`trigger:rule:version:0:target`).
- `channel_receipts`: one observation per send attempt.
- `channel_echoes`: provider message ids that originated from this host, used to
  skip echo ingests.

Delivery states: `pending → in_flight → sent`; `retryable` and `rate_limited`
retry only that account's queue with capped backoff (8 attempts, then
`exhausted`); `permanent` and `unsupported` are terminal; `unknown` leaves the
delivery in `unknown` and never retries automatically; `paused` keeps a disabled
account's rows out of every claim until the next host start. An adapter that
fails to start or writes non-protocol stdout disables only that account until
restart; its queued deliveries move to `paused` and return to `pending` when the
host starts again. Inbound room notifications add one small
`channel_inbound_relays(event_id, room_id)` marker table to the room database;
it exists only to make the room append idempotent. Per-account `readChannelStats` states are `started` (adapter
running), `failed` (startup failure, including a platform mismatch), `disabled`
(disabled at runtime), or `unknown` without a live host. `lastError` is capped,
flattened to one line, and redacts credential-shaped `token=…`/`secret=…`
fragments. On disable or crash, in-flight deliveries move to `unknown`
with the reason; a deliberate host stop also settles remaining in-flight rows as
`unknown`, so a centered reload cannot auto-resend them. A host start resets
stale `in_flight` rows from a previous crash to `pending`. If every account becomes disabled at runtime, the host logs
`all accounts disabled; host idle until restart` and stays alive; only a startup
with zero usable adapters fails. `onUnsupported: drop` skips empty renders; otherwise the
payload carries an `attachment/format unsupported` notice. Replies without a
target parent mapping are sent unthreaded with `degraded: "unthreaded"`, or
dropped when `onMissingParent: drop`.

## Center delivery results (M2)

`HostDeps.onDeliveryResult(event, delivery, receipt)` fires once per delivery when
it reaches a terminal state: `sent`, `permanent`, `unsupported`, `exhausted`, or
`unknown`. `receipt` is present only when a receipt row exists for that attempt.
When an account is disabled or its adapter crashes, in-flight deliveries settle as
`unknown` and report with `receipt: undefined`; no receipt row is invented.
Retryable and rate-limited attempts never report, and a delivery reports at most
once.

Every terminal delivery also records exactly one `result.published` event in
`channel_events`. Its payload holds ids, delivery state, and target only — never
message text, error detail, or provider secrets — and `readChannelStats` reports
it as `publishedResults` while excluding it from source gaps. Rules never match or
forward `result.published`; the center writes the localized terminal system
message from that terminal result. Deliveries abandoned at startup because their
account is no longer configured are also reported as `unknown` and receive the
same terminal result event and message.

## Non-goals (0.1 MVP)

- no config hot reload — rule changes require a restart (each delivery still freezes ruleId + ruleVersion + rendered payload);
- no one-click manual resend command — `unknown` deliveries only guarantee no duplicate delivery row if resent (unique idempotency key); they are never auto-resent;
- no full backpressure (high-water marks, pausing ingress, disk quotas) — only per-account queue/process isolation and `rate_limited` backoff;
- no attachments, no rule UI, no multi-tenant permission model, no exactly-once
  guarantee (inbound room notifications are idempotent per event and route, but
  a crash between the ACK and Feishu's next retry can still lose an event).