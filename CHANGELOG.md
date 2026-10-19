# Changelog

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
