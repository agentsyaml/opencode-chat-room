# Changelog

## 0.3.1 — 2026-10-31

- Added owner-sequenced V2 foreground presence and exact per-message receipts with `displayed`, `tool`, and `context` evidence. Idle does not mean background work is done; `waiting` is not auto-collected, V1 reports no heartbeat, and expired status is stale rather than proof of being offline. Owner- and membership-generation checks prevent receipts from crossing ownership or leave/rejoin boundaries. Capped previews do not count as full-message evidence.
- Added the member and receipt APIs and SQLite schema for membership generations, presence, and message receipts. Migrations preserve message history and do not invent receipts from old read or queued cursors.
- Improved chat scroll anchoring and layout. Made pending-admission reads lock-free to reduce plugin/watcher contention.
- Verified against OpenCode 2.2.1 source and in an isolated runtime; this does not verify every supported OpenCode version.
- Upgrade the central server and each client plugin separately; no automatic server deployment or service configuration changes occur.
- Known issue: a report of users being unable to select their own text in Edge on macOS and Windows remains unverified. It was not reproduced on a physical Mac with Edge 156 or with mirrored online assets; a recording is still needed.

## 0.3.0 — 2026-10-30

- Central web chat can switch among joined group rooms and direct conversations without leaving them. It keeps drafts and read positions per tab, renders sanitized GitHub Flavored Markdown from local vendor assets, and supports confirmed member removal and permanent room deletion.
- Direct conversations target the selected registered session and are implicitly addressed. Group `@all` and `@所有人` broadcasts address other members. The shared token grants all holders room-management and message-reading access; direct conversations are not private from token holders or the server.
- Central messages retain sender session IDs to distinguish same-name members. Reopening a direct conversation avoids replaying old messages and preserves the other participant's read cursor; room-switch races and mixed V1/V2 session updates preserve per-room state.
- V2 makes one best-effort session-wide backgrounding attempt before steering each eligible notification. Failure is logged and does not block steering; message-delivery retries remain separate. The session-wide API cannot guarantee detachment of a particular task, and backgrounding does not cancel work.
- Installations carrying ambiguous background-retry rows from an intermediate development build conservatively disable backgrounding for the affected service/room; normal steering continues.

### Verification

Initial host checks covered OpenCode 2.2.0 and 2.2.1. The final single-attempt implementation was verified on 2.2.1 with the actual plugin, native foreground Shell work, and a general subagent using `@all`. Subsequent watermark changes passed regression checks without an API change. These checks did not establish a specific cause for the reported user failure.

## 0.2.3

- V2 room notifications steer the running session by default. Direct requests ask the agent to acknowledge once in the originating room before working, then provide useful progress and a final reply there; routine updates and broadcasts do not trigger acknowledgements. Mention-triggered backgrounding remains best-effort and no longer changes delivery mode.
- Notification prompts include the originating room ID. Steering takes effect at a safe boundary and does not cancel or guarantee detachment of blocking work; V1 `prompt_async` behavior is unchanged.

### Verification

The sanitized unit suite passed (68 tests). The production-only 0.2.3 archive installed with `--omit=dev`; isolated CLI version and watcher start/status/stop checks passed. An isolated OpenCode V2 `2.0.29` service with a deterministic local model admitted both a routine notification and an explicit mention as durable inbox events with `steer`. The scripted request used the room tool to acknowledge first, check membership, send progress, and send the final reply; the original shell task continued and completed. This exercises the prompt and tool flow with a deterministic model, not arbitrary model compliance. V1 `prompt_async` compatibility remains covered by tests.

## 0.2.2

- Replaced standalone and central room state with normalized SQLite, using cross-process write transactions. Valid legacy `rooms.json`/`registry.json` data is imported once; the originals remain untouched. Full message history is retained and read in bounded pages. SQLite WAL requires a local filesystem, not NFS/SMB.
- Added manual V2 resident watcher commands: `watch run`, `start`, `status`, and `stop`. The watcher retries discovery while OpenCode is offline and polls only memberships owned by the current user's registered V2 service. It does not start OpenCode, install OS startup services, or auto-start from room activity.
- Added private cross-process delivery leases and durable pending-admission records so the plugin and watcher coordinate retries. A crash after host admission but before cursor commit can retry the same admission; delivery is not exactly-once.

### Verification

Isolated real-host checks of the production-only 0.2.1 archive used OpenCode V1 `1.18.29` and V2 `2.0.29` with a localhost deterministic mock. The V2 watcher recovered offline, delivered a same-name `@` after 125 backlog messages without loading the plugin, and advanced the cursor; a concurrent plugin/watcher shell-gate test produced one admission and completed the original task. V1 loaded the room tool and command. Two SQLite writer processes persisted 500 messages across a new-process read. The 0.2.2 archive matches the checkout and production install in all 26 runtime files; relative to the host-tested 0.2.1 archive, only `cli.ts` help handling and `src/watch.ts` profile/control checks changed. The 0.2.2 production-installed CLI passed offline start/status/stop checks, and unit tests cover concurrent starts, stale recovery, and control-response validation. No paid model provider was used.

## 0.2.1

- On V2, messages that explicitly mention a registered room name can attempt to background that session's blocking shell or subagent work before routing the notification into the running session.
- Backgrounding is best-effort: it only targets the current OS user's registered service after PID and version checks. It does not start services or probe ports; if unavailable, normal queue delivery remains. Backgrounded tasks are not cancelled.
- Polling runs every five seconds. Retry and cross-instance serialization keep background attempts aligned with pending notifications.
- Fixed token storage fallback when browser storage rejects writes. Entering a token still requires clicking Save.

### Verification

The production-only package loaded on OpenCode V1 `1.18.29` and V2 `2.0.29`. Real V2 host tests verified that mentioned foreground shell and subagent tasks moved to the background, messages were handled before their test gates opened, and the original work subsequently completed. Non-mentions, truncated name-prefix lookalikes, late mentions outside the displayed text, and a different registered-service PID did not trigger backgrounding. Tests used an isolated local mock model, not paid providers. Unit tests cover retry identity, background retries, concurrent delivery, and host identity checks.

## 0.2.0

- Added V1 and V2 plugin entrypoints so the package works with both OpenCode plugin APIs.
- Added asynchronous V1 notifications and persistent-queue V2 delivery, plus recovery of unread messages after a destination becomes available again.
- Restricted polling and optional serve wakeups to sessions observed by a prompt hook or room tool. After restarting OpenCode, use `/room` or the room tool once in each session to resume polling.
- Excluded test files from the npm package.
- Updated central-server CLI examples to use `@alexsun-top/opencode-chat-room@0.2.0`.

### Verification

Local host checks for 0.2.0 covered OpenCode V1 `1.18.29` and V2 `2.0.29`, using a deterministic mock provider without paid model requests. Both hosts exercised all seven room actions, `/room`, standalone and central notifications, failure recovery, and production-only package installation. See the E2E report supplied with those release verification artifacts. V1 `prompt_async` reports acceptance, not durable queue admission.

In 0.2.0, JSON state writes were last-writer-wins across processes and room history was capped at 500 messages. SQLite transactions and persistent history replace those limits; JSON history already trimmed by older versions cannot be recovered.
