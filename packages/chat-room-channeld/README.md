# chat-room-channeld

Channel D relay core. One host process connects chat-room endpoints to external
IM endpoints through adapter child processes. Explicit rules turn a source-room
event into frozen deliveries for target accounts; each adapter owns one IM
account and speaks JSON-RPC over stdio.

This is the 0.1 MVP: static rules, text messages, outbound adapters with text and Markdown cards, a mock
adapter, and an outbound Feishu adapter. Inbound Feishu events are not
implemented yet.

This package is bundled inside `@alexsun-top/opencode-chat-room` 0.8.0 as
source plus the Feishu and mock adapter entry points. Standalone npm
publication, and the `npx @alexsun-top/chat-room-channeld` form, are planned
for 0.8.x. In 0.8.0 use `GET /channeld/status` on the ChatRoom server, or run
the CLI from a checkout with Bun.

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

`status` prints counts only: queue depth, oldest backlog, unknown, retryable and
rate-limited deliveries, and source/integrity gaps. It never prints message text,
rule ids, error details, provider message ids, room ids, or credentials. A missing
state file or missing channel tables exit 1 with a clear error.

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

## Adapter protocol

The host spawns each adapter with `CHANNELD_ACCOUNT_ID` and
`CHANNELD_PLATFORM`. Both directions use newline-delimited JSON-RPC 2.0 on
stdio. **stdout carries protocol frames only; all adapter logs go to stderr.**
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

## Feishu outbound adapter

`dist/feishu-adapter.js` is an outbound-only adapter for Feishu OpenAPI
messages. It sends interactive cards using `lark_md` inline formatting and
declares `reply: "none"`; native Feishu reply/quote requires a Feishu parent
message and is deferred with inbound support. It speaks the same stdio JSON-RPC protocol as the mock adapter and
has no room or session concepts. Inbound Feishu events are planned for 0.8.x.

The adapter command is resolved from the host process working directory, so
use an absolute path unless the host starts in this package directory.

The child process reads:

- `FEISHU_APP_ID` (required)
- `FEISHU_APP_SECRET` (required)
- `FEISHU_BASE_URL` (optional, default `https://open.feishu.cn`)
- `FEISHU_HTTP_TIMEOUT_MS` (optional, default `10000`)

Set these in the host environment; the host passes its environment to adapter
child processes.

```yaml
accounts:
  - id: feishu-bot
    platform: feishu
    adapter: { command: ["node", "/opt/chatroom/dist/feishu-adapter.js"], runtime: "node" }
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
refreshed when less than 30 minutes remain. A send posts an interactive
Markdown card (`msg_type: "interactive"` with a `lark_md` element) and a `uuid`
derived from the delivery idempotency key, so retrying the same delivery cannot
create a second message.

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
host starts again. On disable or crash, in-flight deliveries move to `unknown`
with the reason; a host start resets stale `in_flight` rows from a previous
crash to `pending`. If every account becomes disabled at runtime, the host logs
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
- no attachments, no rule UI, no multi-tenant permission model, no inbound
  Feishu events (the Feishu adapter is outbound only), no exactly-once
  guarantee.