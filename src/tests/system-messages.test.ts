import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatRoomPreview, formatSystemMessage } from "../../server/assets/chat/system-messages.js";
import { app } from "../../server/assets/chat/state.js";

const say = (text: string) => formatSystemMessage({ senderId: "system", text }, app);
const t = (app as unknown as { t: (key: string, values?: Record<string, string>) => string }).t;

// One natural EN and ZH line per pattern in system-messages.js. Add a row here
// whenever the server starts emitting a new system message.
const samples: Array<[string, string, string]> = [
  ["Peer joined the room", "Peer joined the room", "Peer 加入了房间"],
  ["Peer left the room", "Peer left the room", "Peer 离开了房间"],
  ["Peer was removed from the room", "Peer was removed from the room", "Peer 被移出了房间"],
  ["Alex designated Peer as administrator", "Alex designated Peer as administrator", "Alex 指定 Peer 为管理员"],
  ["Alex updated the room administrators", "Alex updated the room administrators", "Alex 更新了房间管理员"],
  ["Alex named Peer as the room successor", "Alex named Peer as the room successor", "Alex 指定 Peer 为房间继任者"],
  ["Alex cleared the room successor", "Alex cleared the room successor", "Alex 清除了房间继任者"],
  ["Alex revoked the administrator designation", "Alex revoked the administrator designation", "Alex 撤销了管理员指定"],
  ['Alex renamed the room from "Old" to "New"', 'Alex renamed the room from "Old" to "New"', "Alex 将房间名称从“Old”改为“New”"],
  ["Alex updated the room description", "Alex updated the room description", "Alex 更新了房间描述"],
  ["Alex handed the room to Peer", "Alex handed the room to Peer", "Alex 将房间移交给了 Peer"],
  ["Alex set join approval to approval", "Alex now requires approval to join this room", "Alex 开启了加入审核，新成员需要管理员批准"],
  ["Alex set join approval to open", "Alex opened this room to join without approval", "Alex 关闭了加入审核，新成员可以直接加入"],
];

test.each(samples)("%s", (input, en, zh) => {
  app.locale = "en";
  expect(say(input)).toBe(en);
  app.locale = "zh-CN";
  expect(say(input)).toBe(zh);
});

test("joined changes translate every segment", () => {
  app.locale = "en";
  expect(say('Alex updated the room description; Alex set join approval to open'))
    .toBe("Alex updated the room description; Alex opened this room to join without approval");
});

test("room previews do not expose resource markers", () => {
  app.locale = "en";
  expect(formatRoomPreview({ preview: "[[resource:0eebea95-8672-4aa1-a77a-0e9b6e3f39e1]]" }, null, app))
    .toBe("Attachments");
  expect(formatRoomPreview({ preview: "report [[resource:0eebea95-8672-4aa1-a77a-0e9b6e3f39e1]]" }, null, app))
    .toBe("report · Attachments");
});

test("every pattern key has an EN and ZH translation", () => {
  const source = readFileSync(path.join(import.meta.dir, "../../server/assets/chat/system-messages.js"), "utf8");
  const keys = [...source.matchAll(/, "(system[A-Za-z]+)", \(m\) =>/g)].map((match) => match[1]!);
  expect(keys.length).toBe(samples.length - 1);
  for (const key of keys) {
    app.locale = "en";
    const en = t(key, {});
    app.locale = "zh-CN";
    const zh = t(key, {});
    expect(en).not.toBe(key);
    expect(zh).not.toBe(key);
    expect(zh).not.toBe(en);
  }
});