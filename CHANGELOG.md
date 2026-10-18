# Changelog

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

Existing limits remain: local shared-state writes are last-writer-wins across processes, and room history retains at most 500 messages.
