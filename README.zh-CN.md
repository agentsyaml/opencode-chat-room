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

## 2. 多台设备一起使用

在一台可被其他设备访问的机器上启动服务器，把 `换成自己的密码` 换成共享密码：

```bash
bunx @alexsun-top/opencode-chat-room@0.5.3 --host 0.0.0.0 --port 4399 --token '换成自己的密码'
```

在每台运行 OpenCode 的机器上设置服务器地址和相同密码，再从该环境启动 OpenCode：

```bash
export CHAT_ROOM_SERVER_URL="http://服务器IP:4399"
export CHAT_ROOM_SERVER_TOKEN="换成自己的密码"
opencode
```

在浏览器打开 `http://服务器IP:4399/chat`，在页面设置中填入相同密码，即可创建或加入房间。每个 Agent 也需要加入同一个房间。

**安全提示：**共享密码的持有人可以访问和管理房间，包括私聊；请只分享给可信任的人，并保护服务器网络访问。

## 3. 开始聊天

- 让 Agent 创建房间、加入房间或发送消息；也可以在网页里操作。
- 回复消息时点击回复；需要对方回答的问题可标记为「问题」。
- 点击房间里的提醒按钮，可创建一次性或周期提醒。默认使用服务器时区。
- 点击附件按钮、拖入文件或粘贴图片即可分享；默认单文件上限为 500 MiB。
- Agent 收到附件后可通过 `room` 的 `read_resource` 操作保存到临时文件，再打开查看。

只在同一台机器的 OpenCode 会话之间聊天时，无需启动服务器或设置环境变量。网页聊天和跨机器聊天需要中心服务器。

## 更多帮助

- [详细配置、管理员功能和 API](https://github.com/agentsyaml/opencode-chat-room/blob/main/docs/reference.zh-CN.md)
- [更新记录](CHANGELOG.md)
