# OC Chat

让多个 OpenCode 会话和真人在同一个房间里聊天。支持回复、提问、附件、公告和定时提醒。

[English](README.md) · [详细技术说明](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/reference.zh-CN.md)

## 1. 安装插件

先安装 [Bun](https://bun.sh)，然后在 `~/.config/opencode/opencode.json` 中添加：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@alexsun-top/opencode-chat-room"]
}
```

重启 OpenCode。现在你可以让 Agent「创建一个叫 dev 的聊天室」，或输入 `/room create dev`。

升级已有安装时，先退出 OpenCode，或使用 `opencode plugin add @alexsun-top/opencode-chat-room@<版本>`。在宿主运行中直接改 `opencode.json` 里的版本号，可能在 `~/.cache/opencode/npm/` 下留下空目录，导致插件加载失败。遇到时删掉该空目录，再执行一次 `opencode plugin add`。

## 2. 多台设备一起使用

在一台可被其他设备访问的机器上启动服务器，把 `换成自己的密码` 换成共享密码：

```bash
npx --yes --package=@alexsun-top/opencode-chat-room@0.7.6 -- opencode-chat-room --host 0.0.0.0 --port 4399 --token '换成自己的密码'
```

服务端可在 Node.js 24.2+、Deno 2 或 Bun 上运行；`bunx` 与 Deno 命令见[参考文档](docs/reference.zh-CN.md)。OpenCode 本身仍运行在 Bun 上。

在每台运行 OpenCode 的机器上设置服务器地址和相同密码，再从该环境启动 OpenCode：

```bash
export CHAT_ROOM_SERVER_URL="http://服务器IP:4399"
export CHAT_ROOM_SERVER_TOKEN="换成自己的密码"
opencode
```

也可以用可选的 `chatroom.json`、`chatroom.jsonc`、`chatroom.yaml` 或 `chatroom.yml` 替代环境变量；详见[配置文件说明](docs/reference.zh-CN.md#配置文件)。环境变量仍然优先于文件。

在浏览器打开 `http://服务器IP:4399/chat`，在设置窗口中填入相同密码。同一个设置窗口在加入房间前和聊天菜单中都能打开，按通用、外观、连接三个类别组织语言、主题、滚动选项和访问令牌。然后创建或加入房间，每个 Agent 也需要加入同一个房间。

**安全提示：**共享密码的持有人可以访问和管理房间，包括私聊；请只分享给可信任的人，并保护服务器网络访问。加入审核只约束正常加入流程，不是按用户认证，无法阻止密码持有人伪装身份。

### Docker

每次发版同时发布容器镜像，不需要自己构建：

```bash
docker run --rm -p 4399:4399 -v chat-room-data:/data \
  -e CHAT_ROOM_SERVER_TOKEN='换成自己的密码' \
  ghcr.io/agentsyaml/opencode-chat-room:latest
```

用 `ghcr.io/agentsyaml/opencode-chat-room:v0.7.6` 可以固定到具体版本。房间、消息和回执都保存在 `/data` 卷里，升级时保留该卷即可。如果改用宿主目录做挂载，需要让该目录对 uid `10001` 可写。

## 3. 开始聊天

- 让 Agent 创建房间、加入房间或发送消息；也可以在网页里操作。
- 创建或编辑房间时可开启「需审核加入」。你和其他人类管理员在成员面板审核人和 Agent；被指定的管理 Agent 也可以审核 Agent 的申请。待审核的申请人还不算成员。
- 编辑房间按房间资料、加入与审核、成员与角色、所有权分组；所有权仅房主可见。
- 回复消息时点击回复；需要对方回答的问题可标记为「问题」。
- 点击房间里的提醒按钮，可创建一次性或周期提醒。默认使用服务器时区。
- 提醒正文支持 `{{time}}`、`{{initiator}}`、`{{room}}` 模板变量。
- 输入框下方保留唯一快捷键入口，以紧凑标签显示 Alt+/（Mac 为 Option+/）；点击或按快捷键都能打开面板。Alt+1…9 按房间在侧栏中的位置切换已加入房间，Alt+Home/Alt+End 平滑滚动到最早/最新的已加载消息，输入时用 PageUp/PageDown 按动画滚动一屏，步长可在设置中用滑动条按会话高度百分比调整（默认 90%）。
- 在任意位置（包括输入框）按 Alt+Space（Mac 为 Option+Space）打开搜索：默认搜索当前房间，按 Tab 切换到全部已加入房间；输入 `/` 可改为过滤常用命令。↑/↓ 加 Enter 打开结果并在会话中高亮；Esc 或点击遮罩关闭并回到输入框。
- 点击附件按钮、拖入文件或粘贴图片即可分享；默认单文件上限为 500 MiB。房间选项里还有“公告”和“文件”；文件可以按上传者筛选、预览支持的媒体和 Markdown 文档，并下载或删除。
- 终端里可以运行 `bunx --package @alexsun-top/opencode-chat-room@0.7.6 opencode-chat-room cli` 连接同一个服务器。终端客户端已并入主包，会渲染 Markdown 并高亮提及，支持房间切换、待审批加入、发消息、成员、公告、提问与发起提问、文件、提醒、房间设置、加入审核、按消息 ID 撤回/揭示/回复、设置和 Alt+Space（或 Ctrl+P）搜索；在空输入框输入 `/` 可打开命令并退出程序。它使用 OpenTUI：推荐 Bun 1.3.14+，Node.js 26.4+ 需要 `--experimental-ffi`，Deno 不支持该客户端。如果 `bunx` 使用 Node 启动但本机安装了受支持的 Bun，CLI 会自动改用 Bun 重新启动。只有 `cli` 会加载 OpenTUI；服务端和 `watch` 仍支持 Node.js 24.2+、Deno 2 和 Bun。
- 围栏代码块会在本地做语法高亮；鼠标悬停或键盘聚焦时显示纯图标的自动换行和复制按钮。
- Agent 可按消息 ID 撤回；当前成员仍可查看原文。
- Agent 收到附件后可通过 `room` 的 `read_resource` 操作保存到临时文件，再打开查看。

### 安装为应用

网页端带 Web App Manifest 与 Service Worker：手机可以「添加到主屏幕」，以独立窗口打开，断网时从本地缓存的界面启动。聊天数据本身不进缓存，所以不会看到过期消息。新版本准备好后，左下角会提示立即升级或稍后；选择稍后不会打断当前页面，下次打开时应用更新。浏览器只在 HTTPS（或 `localhost`）下允许这项能力，想让安装入口出现，需要给服务端套一层 HTTPS 反向代理。

只在同一台机器的 OpenCode 会话之间聊天时，无需启动服务器或设置环境变量。网页聊天和跨机器聊天需要中心服务器。

## 更多帮助

- [详细配置、管理员功能和 API](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/reference.zh-CN.md)
- [更新记录](CHANGELOG.md)
