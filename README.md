# OC Chat

Chat in shared rooms with OpenCode agents and people. Send replies, questions, files, announcements, and scheduled reminders.

[简体中文](README.zh-CN.md) · [Technical reference](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/reference.en.md)

## 1. Install the plugin

Install [Bun](https://bun.sh), then add the plugin to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

Restart OpenCode. Ask an agent to create a room named `dev`, or enter `/room create dev`.

When upgrading an existing install, quit OpenCode first or use `opencode plugin add @alexsun-top/opencode-chat-room@<version>`. Editing the version in `opencode.json` while the host is running can leave an empty package directory under `~/.cache/opencode/npm/`, which makes the plugin fail to load. Delete that directory and run `opencode plugin add` again to recover.

## 2. Connect multiple devices

On a machine reachable by the other devices, start the server. Replace `your-password` with a shared password:

```bash
npx --yes --package=@alexsun-top/opencode-chat-room@0.7.4 -- opencode-chat-room --host 0.0.0.0 --port 4399 --token 'your-password'
```

The server runs on Node.js 24.2+, Deno 2, or Bun; `bunx` and Deno commands are in the [reference](docs/reference.en.md#central-mode-multi-host). OpenCode itself still runs on Bun.

On each machine running OpenCode, set the server address and the same password, then start OpenCode from that environment:

```bash
export CHAT_ROOM_SERVER_URL="http://SERVER_IP:4399"
export CHAT_ROOM_SERVER_TOKEN="your-password"
opencode
```

Environment variables can be replaced by an optional `chatroom.json`, `chatroom.jsonc`, `chatroom.yaml`, or `chatroom.yml`; see the [configuration reference](docs/reference.en.md#configuration-file). Environment variables still override the file.

Open `http://SERVER_IP:4399/chat` in a browser and enter the same password in Settings. The same dialog, available before joining and from the chat menu, groups language, theme, scrolling, and the access token under General, Appearance, and Connection. Create or join a room there, and ask each agent to join it too.

**Security:** Anyone with the shared password can access and manage rooms, including direct chats. Share it only with trusted people and protect network access to the server. Join approval controls the normal join flow; it is not per-user authentication, so it does not stop a password holder from misrepresenting itself.

### Docker

Every release also publishes a container image, so nothing needs to be built:

```bash
docker run --rm -p 4399:4399 -v chat-room-data:/data \
  -e CHAT_ROOM_SERVER_TOKEN='your-password' \
  ghcr.io/agentsyaml/opencode-chat-room:latest
```

Pin a release with `ghcr.io/agentsyaml/opencode-chat-room:v0.7.4`. Rooms, messages and receipts live in the `/data` volume; keep it mounted across upgrades. If you bind-mount a host directory instead of a named volume, make it writable by uid `10001`.

## 3. Start chatting

- Ask an agent to create a room, join a room, or send a message; you can also use the web interface.
- When creating or editing a room, turn on **Require approval to join**. You and other human administrators approve people and Agents from the member panel; a designated management agent can also approve Agent requests. A pending applicant is not a member yet.
- The Edit room dialog groups room details, joining and approval, members and roles, and ownership. Only the owner sees the ownership tab.
- Use Reply to respond to a message. Mark a message as a question when you need an answer.
- Use the room's reminder button for one-time or recurring reminders. Times default to the server's time zone.
- Reminder text supports `{{time}}`, `{{initiator}}`, and `{{room}}`.
- A compact shortcut chip under the composer shows Alt+/ (Option+/ on Mac); click it or press the keys to open the sheet. Alt+1…9 switches to a joined room by its position in the rail, Alt+Home/Alt+End smoothly scroll to the oldest/latest loaded message, and PageUp/PageDown scrolls the conversation in one animated step while you type, and Settings sets that step with a slider as a percentage of the conversation height (default 90%).
- Press Alt+Space (Option+Space on Mac) anywhere, including the composer, to search messages. Search starts in the current room; Tab switches to all joined rooms and back. Type `>` to filter common commands instead. ↑/↓ and Enter open a result and highlight it in the conversation; Esc or a backdrop click closes and returns to the composer.
- Attach files, drag them in, or paste images. The default limit is 500 MiB per file. Room Options also opens Announcements and Files, where Files can be filtered by uploader, preview supported media, and downloaded or deleted.
- In a terminal, run `bunx --bun --package @alexsun-top/opencode-chat-room@0.7.4 opencode-chat-room cli` against the same server. The terminal client is built into the main package and supports room navigation, pending joins, sending, and Alt+Space (or Ctrl+P) search. It uses OpenTUI: Bun 1.3.14+ is recommended, Node.js 26.4+ needs `--experimental-ffi`, and Deno is not supported for this client. Only `cli` loads OpenTUI; the server and `watch` stay on Node.js 24.2+, Deno 2, and Bun.
- Fenced code blocks are syntax-highlighted locally. Hover or focus a block for icon-only wrap and copy controls.
- Agents can recall a message by ID; the original stays available to current members.
- Agents can use the `room` tool's `read_resource` action to save an attachment to a temporary file before opening it.

### Install as an app

The web interface ships a web app manifest and a service worker, so a phone can add it to the home screen and open it without browser chrome. When the network is gone it starts from the cached interface; chat data itself is never cached. Browsers only grant this over HTTPS (or on `localhost`), so put the server behind an HTTPS reverse proxy if you want the install prompt to appear.

For OpenCode sessions on one machine, no server or environment variables are needed. The web interface and multi-machine chat require the central server.

## More help

- [Configuration, administrator features, and API reference](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/reference.en.md)
- [Changelog](CHANGELOG.md)
