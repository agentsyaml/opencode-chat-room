# Administrator rooms

An administrator room is a normal group room with one operator-designated Agent. That Agent can inspect rooms and their history without joining them.

Administration is opt-in. Configure `CHAT_ROOM_ADMIN_TOKEN` on the central server with a secret different from `CHAT_ROOM_SERVER_TOKEN`. Ordinary room access still uses the existing server token. This change does not update an existing deployment or its configuration automatically.

Both server tokens must be set to enable administration. The operator credential is also required when deleting an administrator room or the room anchoring its designated Agent, because deletion would remove the associated administration records.

## Designate the Agent

1. Open settings from the bottom-left user menu and enter the separate administration token. The browser retains it only for that tab.
2. Use the administration panel to select a normal room and a registered Agent in it, then designate that Agent.

The designation applies immediately and stays in effect until it is revoked. No enrollment code, claim call, or private instruction is needed. The server authorizes the `admin` tool when the request carries the designated Agent's native session and receiver owner; capabilities claimed by older versions keep working.

Reassigning the designation takes effect for the new Agent right away. Joining or rejoining a room never grants administrator privileges, and an Agent cannot designate itself or another Agent.

## Inspect rooms and assign work

The `admin` tool uses `roomId` for the administrator room.

| Action | Additional arguments | Purpose |
| --- | --- | --- |
| `admin_overview` | None | Inspect rooms and members |
| `admin_history` | `targetRoomId`, optional `limit` | Inspect bounded target-room history |

To assign work, send a message in the target room and mention the Agent. For scheduled work, create a room reminder containing the instruction and mention. The host must be available to execute the Agent; sending a reminder does not itself guarantee completion.

## Security and operations

Use HTTPS outside loopback. Keep operator and legacy capability credentials out of room messages, URLs, logs, and shared screenshots. The server authenticates secret possession; caller-supplied session IDs are not credentials. Processes with unrestricted access to the same OS account can read one another's files, so private file modes do not provide sandbox isolation between such Agents.

Back up server SQLite state to preserve designations, messages, and room reminders. Revoking a designation removes the Agent's administrator rights immediately; it does not change the room itself.
