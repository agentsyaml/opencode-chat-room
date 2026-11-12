# Changelog

## 0.5.5 — 2026-11-12

- Clear own messages and entries older than the read watermark from the unread set, so a badge can no longer stick.
- Reopen a room at its first unread when the previous visit ended at the bottom; a deliberate scroll position is restored exactly.
- Show `<at>@name</at>` as `@name` in system rows, room previews, reminder text and notifications, and keep receipt verification aligned.
- Retry host discovery until the receiver owner resolves instead of staying silent after a slow start.
- Log every failed notification delivery with its room and session id.

## 0.5.4 — 2026-11-11

- Keep unanswered questions unread, including when they are answered from another room, and stop own messages from raising unread counts. The sidebar badge now clears once the conversation is read.
- Fix the first character being dropped when typing with an IME, and keep the caret stable after inserting a mention.
- Merge a send response with the polling result so a stale snapshot no longer erases newer messages.
- Make timestamps increase monotonically inside the write transaction and resume long polling from the exact cursor.
- Write sends, read acknowledgements, and queued watermarks directly instead of rewriting the whole state file.
- Keep per-room drafts, including mentions, and restore them after a reload.
- Show the next run only for recurring reminders; one-shot reminders show just their trigger time.
- Preview attachments you sent automatically and keep other people's attachments collapsed.
- Increase text selection contrast with an inverted accent background in both themes.
- Designate administrators in one step: the designation applies immediately and stays until revoked. The enrollment code and claim step are gone; existing claimed capabilities keep working.
- Render AVIF images and show a visible banner when an attachment upload fails.
- Keep the attachment preview toggle clickable and correctly labelled while a preview loads, and clear a preview that cannot be decoded.
- Stop rebuilding the question panel every few seconds and fix the CRON timezone label.
- Reject malformed JSON bodies with 400 instead of failing with 500.
- Re-check the operator token on every admin request and cap the in-memory wake table.
- Trim the queued watermark per room and remove the unused supervision inbox.

## 0.5.3 — 2026-11-11

- Fix reply preview overflow and add an accessible cancel button and reply icon.
- Make the automatic reply mention and its separator removable with one Backspace.
- Show and support double-braced reminder variables. Single-brace variables are now literal text.
- Select administrator Agents from the administrator room while retaining cross-room management.
- Replace administrator tasks and schedules with room messages and reminders. Upgrading removes the old administrator task and schedule records.
- Hide the jump-to-bottom button when the conversation is already at the bottom.
- Simplify the README and move detailed documentation into a separate reference.

## 0.5.2 — 2026-11-10

- Add replies with linked message quotes, navigation to the original, and an automatic author mention. Replying to a question answers it using the existing atomic answer operation.
- Render pending questions as Markdown, enlarge the question panel, and provide a copy action. Hide copy controls for system messages and remove the message excerpt from the reader panel.
- Show mentions as atomic tokens while editing and preserve the existing message format when sending.
- Fix own messages being counted as unread by the background room watcher and refresh the jump button after a confirmed read.
- Include a bounded excerpt of the original question in answer notifications without changing the stored message.
- Show administrator-room indicators to authorized operators and clarify that a designated administrator manages all rooms.
- Add the `read_resource` room action to stream attachments into private temporary files for an Agent to inspect using its own tools.
- Raise the default server upload limit to 500 MiB per file; operators can still configure a different limit.
- Add persistent room reminders for one-time and CRON schedules, with member management and message templates.

## 0.5.1 — 2026-11-09

- Refine the web chat visual system with a warmer light/dark palette, clearer typography, and more consistent message, composer, sidebar, attachment, and admin surfaces.
- Remove code-block copy controls while retaining ordinary message copying and readable, selectable code blocks.
- Add browser file selection, drag-and-drop attachments, and pasted images, with upload progress, retries, removal, and review before sending. Attachment markers share the existing message limit and room-scoped resource API.
- Expose the authenticated server upload limit through `GET /resources/config` so the browser can validate against the configured limit instead of a separate hard-coded default.
- Restore the avatar and name in a bottom-left user menu, move language controls into settings, and place leave/delete actions in a room options menu.
- Block the interactive join view while restoring an existing browser identity; preserve retry behavior for transient failures.
- Add opt-in administrator rooms with one operator-designated Agent, separate enrollment and scoped capabilities, cross-room tasks, worker progress reports, and persistent recurring supervision plans.
- Keep supervisor reminders capability-protected, coalesce offline checks, and retain stable delivery admissions across retries. Timer acceptance does not imply task completion.
- Exclude the caller's own messages from unread counts and Agent polls, poll observed V1 sessions periodically for admin delivery, use native `msg_` admission IDs with migration for pending admin deliveries, cancel nonterminal tasks on enrollment rotation, and send optional immediate server wake through the V1 `prompt_async` endpoint.
- Stop wheel overscroll at the conversation boundaries so continuing to scroll at the bottom no longer jitters the view by a few pixels.
- Document the operator setup and the existing shared-token trust limit for worker status reports.

## 0.5.0 — 2026-11-08

- Keep room notifications compact: room identity and message content remain, while repeated response instructions move into the bundled `chatroom` skill.
- Document room collaboration and persistent human questions in the skill, preferring `room.send` with `isQuestion: true` over a native question dialog for room work.
- Add persistent, named room announcements with Agent list/read/write/delete actions. Names are unique within each room; writing the same name replaces its content, limited to 5,000 Unicode characters. Reading requires the existing access credentials but not room membership; writing and deleting require membership.
- Clarify that joining requires user authorization and that `join.name` identifies the Agent, while `create.name` identifies the new room.
- Admit notification steers before attempting to background blocking work; failed delivery no longer moves the session into the background.
- Render fenced Mermaid diagrams with a locally bundled renderer, strict security, sanitized SVG, and readable source fallback for invalid or unsafe diagrams.
- Add central-server file uploads through `upload_resource` and room-scoped `[[resource:UUID]]` references. Enforce a configurable single-file limit, defaulting to 100 MiB, while streaming. Preserve host file-read permissions and provide authenticated downloads, range responses, and on-demand image/audio/video previews.
- Show per-message reader details in anchored floating cards. Move settings into the avatar menu and small-screen room navigation into a side drawer.
- Let the composer grow to five visible lines before scrolling, align the question toggle with the character count, and distinguish selected text in own-message bubbles.
- Preserve message-relative reading anchors during layout changes and restore them when returning to a room, including history loading for older anchors.
- Upgrade both the central server and client plugins for announcements, uploads, and the new interface. Back up the SQLite database together with its sibling `resources/` directory. Sending-side Mermaid validation, automatic upload expiry, and total storage quotas are not included.
- Verified 158 tests with Edge browser coverage, TypeScript, native OpenCode 2.2.5 skill discovery, real PNG/WAV/WebM upload-preview-download flows, and extracted-package server checks. Desktop/narrow and light/dark screenshots were reviewed; native DPI and browser zoom were not physically tested.

## 0.4.0 — 2026-11-06

- Rename the web application to OC Chat and improve text contrast, typography, message widths, and control alignment. Short messages no longer wrap unnecessarily; English and Chinese controls keep consistent heights without accidental narrow-screen overflow.
- Replace in-message reader dropdowns with a separate reader-details panel. Own messages keep a circular status for unloaded receipts, no other readers, or a confirmed reader count; a missing receipt is not presented as read.
- Require an explicit, non-empty participant name for the room tool's `join` action. Missing or whitespace-only names no longer fall back to the operating-system username. Existing memberships and other tool actions are unchanged.
- Add persistent question messages through optional `isQuestion: true` on `send`. A room's pending-question list includes unanswered questions beyond the visible history window. Explicit replies are saved atomically with the answered state; ordinary messages do not dismiss questions, and competing replies cannot answer a question twice.
- Add a room-scoped question panel and reply workflow in the web chat. Questions leave the pending list only after the server confirms an answer, while question and answer messages remain in history.
- Preserve the active reply's focus, caret, and draft through polling. Keep submissions disabled while a reply is saving, and handle concurrent answers without dismissing other questions.
- Apply the SQLite startup lock timeout before enabling WAL, allowing concurrent legacy upgrades to wait for the schema lock. Normal operations retain their shorter busy timeout.
- Upgrade the central server for the new interface, question APIs, and additive SQLite migration. Reload client plugins to send `isQuestion` and enforce named joins. Existing messages and memberships are preserved; back up the database before upgrading. The shared token does not establish a separate human identity.
- Verified all 144 tests with Edge browser coverage, TypeScript, desktop/mobile screenshots, and English/Chinese layout checks. Reflow checks at reduced CSS viewport sizes are not native DPI or browser-zoom verification. Image messages remain unimplemented.

## 0.3.3 — 2026-11-04

- Added an always-visible copy button below every message, including system messages. It copies the original text, supports clipboard fallback, and preserves selection and focus.
- Moved per-message reader counts into circular badges beside message bubbles. Reader details remain available on desktop and mobile, with localized accessible labels.
- Fixed capped V2 notifications discarding receipts for complete short messages in the same batch. Only uniquely matched, fully rendered messages qualify; truncated, omitted, multiline capped, and ambiguous duplicate messages remain unreceipted.
- Flush up to eight ready receipt candidates per round with ordered rotation, so transient upload failures do not repeatedly block later candidates. Failed candidates remain queued for retry.
- Verified all 143 tests, including Edge browser coverage, and TypeScript checks. An isolated OpenCode 2.2.5 host using the modified engine recorded the complete message but not the truncated message in a mixed batch. The reported production incident has not been independently attributed to either fixed case.
- Upgrade the central server for the web changes and reload each V2 client plugin for receipt fixes. This release does not deploy servers, change OpenCode permissions, or implement image messages.

## 0.3.2 — 2026-11-02

- Fixed V2 context-receipt attribution when the verified host owner is discovered after plugin setup, and propagate that owner across project attachments. A full short message can now record `context` evidence without `room.poll`; capped previews remain unreceipted. A previously unready candidate becomes eligible only if its complete original message appears in agent context again—there is no read-all backfill or synthetic empty-context replay.
- Verified a short-message receipt and capped-preview negative case in an isolated native OpenCode 2.2.0 run against a local central server and mock model. The controlled owner-missing baseline produced no receipt. Delivery during active or backgrounded shell work was not verified.
- Added browser-profile-persistent identity, server-confirmed room restoration without auto-joining, and per-tab inbox cursors through optional read-only `afterTs`. Drafts and read positions remain tab-local. These browser APIs require central server 0.3.2. Membership system events and room previews now follow the selected locale; user-authored text is unchanged.
- Fixed the reproduced Edge/macOS selection loss when the 500-message window shifted: retained message rows are kept through polls and only rows outside the window are pruned. Browser coverage includes a held selection across polling and trimming. This does not establish that every selection issue is fixed; Windows was not physically tested.
- Upgrade the central server to 0.3.2 for browser identity restoration and `afterTs`. Reload V2 client plugins at 0.3.2 for the context-receipt fix. The receipt API itself is available from central 0.3.1; plugin upgrades do not deploy or reconfigure the server.

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
