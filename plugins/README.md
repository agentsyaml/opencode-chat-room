# Channel adapters

Each directory holds one channel adapter as a standalone process. The core
(`packages/chat-room-channeld`) knows only the JSON-RPC frames below; it never
imports platform code. `feishu/` is the reference implementation. `wecom/` and
`email/` are reserved for the same contract.

## Layout

```
plugins/
  feishu/        Feishu adapter (implemented)
  wecom/         WeCom adapter (reserved)
  email/         Email adapter (reserved)
```

An adapter is launched by configuration, not by the core build:

```yaml
accounts:
  - id: feishu-main
    platform: feishu
    adapter:
      command: ["node", "/opt/chatroom/feishu-adapter.ts"]
```

The command must write protocol frames to stdout and logs to stderr. The host
sets `CHANNELD_ACCOUNT_ID` and `CHANNELD_PLATFORM`; account-specific secrets
belong in the account's `env` map.

## Protocol

One JSON-RPC object per frame, newline-delimited. The host calls:

- `initialize` with protocol/event schema versions, session epoch, platform,
  account ids, and `maxFrameBytes`. The adapter returns its capabilities plus
  `send` flags. `initialize` must not perform network work.
- `start` to validate credentials and open inbound subscriptions.
- `send` with `{deliveryId, attemptId, idempotencyKey, target, payload}`. The
  adapter returns a receipt: `sent` with a provider message id, or
  `retryable`, `rate_limited`, `permanent`, `unsupported`, or `unknown`.
  `payload.text` is Markdown. `payload.attachments` carries local file paths
  resolved by the host; `payload.parent` is a native parent reference.
- `stop` to exit cleanly.

The adapter calls `ingest` with an event containing `kind`, `source`, `actor`,
`message`, `content`, and `sourceDedupKey`. The host commits it before ACKing.
A non-text payload uses `content.attachments` with `kind`, `name`, `mimeType`,
`size`, and a private local `path`; the host imports the file into room
resources. Inbound failures must set `attachments[].error` instead of dropping
content silently.

Capabilities returned from `initialize`:

```json
{
  "displayName": "Feishu",
  "attachments": {
    "kinds": ["image", "file"],
    "imageMaxBytes": 10485760,
    "fileMaxBytes": 31457280
  },
  "send": { "text": true, "format": ["text", "markdown"], "reply": "native" }
}
```

The host uses `displayName` and attachment limits; it must not hardcode platform
limits. `send` flags describe formatting and idempotency support.

## Porting an adapter

OpenClaw and similar projects already implement platform API calls, webhook or
long-connection ingestion, and message formatting. Port those pieces behind this
contract: keep credentials in `env`, keep provider ids inside the adapter, and
emit one `message.created` ingest event per external message. Do not add platform
imports to `packages/chat-room-channeld/src`.

## Build and publish

Build the Feishu adapter from the repository root with
`bun run build:adapter-feishu`, producing
`plugins/feishu/dist/feishu-adapter.ts`: one file with no relative imports and
real TypeScript annotations. A small concatenation script
(`scripts/build-feishu-adapter.ts`) merges the typed modules instead of using a
bundler, so the file is TypeScript rather than renamed JavaScript. Node 22.18+
or 24 runs it directly through native type stripping; it stays
erasable-syntax-only (no `enum`, `namespace`, or constructor parameter
properties) so plain `node` also runs it.

Channeld launches every adapter child with
`--experimental-transform-types --disable-warning=ExperimentalWarning` appended
to its inherited `NODE_OPTIONS`, so an uploaded `.ts` plugin may use TypeScript
syntax that type stripping cannot erase, such as `enum`, `namespace`, and
constructor parameter properties. The server process itself stays strip-only.
Node labels this transform experimental and its supported syntax can change
between releases; the stable long-term path is compiling the adapter to a single
`.js` file with a real TypeScript compiler. Adapter stdout must stay
protocol-only, warnings and logs go to stderr, and adapter children suppress
`ExperimentalWarning` while other warnings stay enabled. The root
`@alexsun-top/opencode-chat-room` service ships no built-in adapter; the release attaches the generated Feishu adapter as an asset;
adapters are not published as separate npm packages. The core launches any adapter through
the account's `adapter.command`.