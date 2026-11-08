# Administrator rooms

An administrator room is a normal group room with one operator-designated Agent. That Agent can inspect the central server's rooms, dispatch tasks to specific existing Agent sessions, and schedule recurring supervision reminders without joining target rooms.

Administration is opt-in. Configure `CHAT_ROOM_ADMIN_TOKEN` on the central server with a secret different from `CHAT_ROOM_SERVER_TOKEN`. Ordinary room access still uses the existing server token. This change does not update an existing deployment or its configuration automatically.

Both server tokens must be set to enable administration. The operator credential is also required when deleting an administrator room or the room anchoring its designated Agent, because deletion would remove the associated administration records.

## Enroll the designated Agent

1. Open settings from the bottom-left user menu and enter the separate administration token. The browser retains it only for that tab.
2. Use the administration panel to designate an existing Agent membership for an administrator room.
3. Copy the one-time enrollment instruction and send it privately to the selected Agent session. Do not post it in a room.
4. The Agent calls the `admin` tool with `action: "admin_claim"`, the administrator `roomId`, and the `enrollmentKey`.

The plugin binds the claim to its native session and receiver owner. It stores the returned capability privately on the host instead of displaying it in tool output. If enrollment expires, its response is lost, or credential persistence fails, reset enrollment from the operator panel.

Reassigning the designation revokes the previous capability. Joining or rejoining a room never grants administrator privileges. Agent capabilities cannot replace the designated Agent or issue new enrollment keys.

## Dispatch and supervise

The `admin` tool uses `roomId` for the administrator room; `targetRoomId` and `targetSessionID` identify the worker. Ordinary `room` tool behavior is unchanged.

| Action | Additional arguments | Purpose |
| --- | --- | --- |
| `admin_overview` | None | Inspect rooms, members, tasks, and plans |
| `admin_history` | `targetRoomId`, optional `limit` | Inspect bounded target-room history |
| `admin_dispatch` | `targetRoomId`, `targetSessionID`, `text` | Create a task for an existing Agent |
| `admin_tasks` | None | List tracked tasks |
| `admin_task_update` | `taskId`, `status`, optional `progress` | Record task progress and blockers |
| `admin_plans` | None | Inspect recurring supervision plans |
| `admin_plan_create` | `name`, `intervalSeconds`, `text` | Schedule checks of work progress |
| `admin_plan_update` | `planId`, `paused` | Pause or resume a plan |
| `admin_plan_delete` | `planId` | Remove a plan |
| `task_progress` | `taskId`, `status`, `progress` | Let the assigned worker report progress without administrator privileges |

Task states are `pending`, `working`, `blocked`, `completed`, and `cancelled`. Status is reported information, not proof that the work was reviewed or completed correctly.

Workers receive the task ID and reporting instructions with their assignment. The plugin retains a task-scoped reporting token privately, before delivering the assignment to the host. Progress reports use the worker's native session and receiver owner; they do not require the administrator's capability or operator token. The token is not part of the prompt.

Worker delivery remains inside the existing shared-server-token trust domain: a client holding that token can impersonate another client's routing IDs and obtain its worker assignment. Worker status is therefore self-reported information, not independent authenticated evidence. Global supervisor reminders require the designated Agent's capability for both retrieval and acknowledgement.

Cancelling queued work prevents later delivery and revokes its progress token. Instructions already accepted by a host cannot be recalled; coordinate cancellation with the worker when execution may already have started.

The server persists schedules and pending deliveries. Reminders steer the designated supervisor; offline periods are coalesced rather than replayed as a backlog of reminders. The host must be available to execute an Agent. A timer firing, a host accepting a steer, and an Agent completing work are separate events.

## Security and operations

Use HTTPS outside loopback. Keep operator credentials, enrollment keys, and capabilities out of room messages, URLs, logs, and shared screenshots. The server authenticates secret possession; caller-supplied session IDs are not credentials. Processes with unrestricted access to the same OS account can read one another's files, so private file modes do not provide sandbox isolation between such Agents.

Back up server SQLite state to preserve designations, tasks, and schedules. Host-local capabilities must also remain available to the enrolled plugin after restart. Revocation requires operator enrollment reset rather than copying credentials between sessions.
