import { expect, test } from "bun:test";
import { app } from "./assets/chat/state.js";
import { formatSystemMessage } from "./assets/chat/system-messages.js";

test("administrator system messages from stored English history render in Chinese", () => {
  app.locale = "zh-CN";
  const format = (text: string) => formatSystemMessage({ senderId: "system", text }, app);
  expect(format("Alex designated neyio as administrator")).toBe("Alex 指定 neyio 为管理员");
  expect(format("Alex revoked the administrator designation")).toBe("Alex 撤销了管理员指定");
  expect(format('Alex renamed the room from "Movie night" to "Friday films"')).toBe("Alex 将房间名称从“Movie night”改为“Friday films”");
  expect(format("Alex updated the room description")).toBe("Alex 更新了房间描述");
  expect(format("Alex handed the room to Sam")).toBe("Alex 将房间移交给了 Sam");
  expect(format("Alex joined the room")).toBe("Alex 加入了房间");
  expect(format("Alex left the room")).toBe("Alex 离开了房间");
  expect(format("Alex was removed from the room")).toBe("Alex 被移出了房间");
});

test("administrator list and successor events render from stored English", () => {
  app.locale = "zh-CN";
  const format = (text: string) => formatSystemMessage({ senderId: "system", text }, app);
  expect(format("Alex updated the room administrators")).toBe("Alex 更新了房间管理员");
  expect(format("Alex named Sam as the room successor")).toBe("Alex 指定 Sam 为房间继任者");
  expect(format("Alex cleared the room successor")).toBe("Alex 清除了房间继任者");
  expect(format("Alex updated the room administrators; Alex named Sam as the room successor")).toBe("Alex 更新了房间管理员; Alex 指定 Sam 为房间继任者");
  app.locale = "en";
  expect(format("Alex named Sam as the room successor")).toBe("Alex named Sam as the room successor");
});

test("combined change events translate each part", () => {
  app.locale = "zh-CN";
  expect(formatSystemMessage({ senderId: "system", text: 'Alex renamed the room from "Old" to "New"; Alex designated neyio as administrator' }, app))
    .toBe("Alex 将房间名称从“Old”改为“New”; Alex 指定 neyio 为管理员");
});

test("English history keeps its original wording", () => {
  app.locale = "en";
  const text = "Alex designated neyio as administrator";
  expect(formatSystemMessage({ senderId: "system", text }, app)).toBe(text);
  expect(formatSystemMessage({ senderId: "system", text: "Reminder: standup in 10 minutes" }, app)).toBe("Reminder: standup in 10 minutes");
});

test("user messages and unknown system messages are preserved", () => {
  app.locale = "zh-CN";
  expect(formatSystemMessage({ senderId: "user-1", text: "Alex designated neyio as administrator" }, app)).toBe("Alex designated neyio as administrator");
  expect(formatSystemMessage({ senderId: "system", text: "__Test_once Alex __Test_reminder_room" }, app)).toBe("__Test_once Alex __Test_reminder_room");
  expect(formatSystemMessage({ senderId: "user-1", text: "hi <at>@Alex</at>" }, app)).toBe("hi @Alex");
});