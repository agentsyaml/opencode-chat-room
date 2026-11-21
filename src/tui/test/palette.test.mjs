import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommands,
  filterCommands,
  nextScope,
  scopeSources,
  searchMessages,
  snippetOf,
} from "../palette.mjs";

const message = (id, text, createdAt, extra = {}) => ({ id, senderId: "bob", text, createdAt, ...extra });

const rooms = [
  { id: "r1", name: "general", joined: true },
  { id: "r2", name: "design", joined: true },
  { id: "r3", name: "secret", joined: false },
];

test("commands include rooms, search scopes and actions", () => {
  const commands = buildCommands({
    rooms,
    current: { id: "r1", name: "general" },
    joined: true,
    help: false,
  });
  const labels = commands.map((command) => command.label);
  assert.ok(labels.includes("Refresh rooms"));
  assert.ok(labels.includes("New room..."));
  assert.ok(labels.includes("Join #secret"));
  assert.ok(labels.includes("Leave #general"));
  assert.ok(labels.includes("Switch to #design"));
  assert.ok(labels.includes("Search this room"));
  assert.ok(labels.includes("Search all joined rooms"));
  assert.ok(!labels.includes("Join #general"));
});

test("command filtering is case-insensitive and empty keeps all", () => {
  const commands = buildCommands({ rooms, current: null, joined: false });
  assert.equal(filterCommands(commands, "").length, commands.length);
  const matches = filterCommands(commands, "SEARCH");
  assert.equal(matches.length, 2);
  assert.ok(matches.every((command) => command.label.toLowerCase().includes("search")));
});

test("scope toggles between current room and all joined rooms", () => {
  assert.equal(nextScope("room"), "all");
  assert.equal(nextScope("all"), "room");
});

test("scopeSources limits all-room search to joined rooms", () => {
  const cache = new Map([
    ["r1", [message("m1", "one", 1)]],
    ["r2", [message("m2", "two", 2)]],
    ["r3", [message("m3", "three", 3)]],
  ]);
  const current = scopeSources({ rooms, current: { id: "r1", name: "general" }, scope: "room", cache });
  assert.deepEqual(current.map((source) => source.roomId), ["r1"]);
  const all = scopeSources({ rooms, current: { id: "r1", name: "general" }, scope: "all", cache });
  assert.deepEqual(all.map((source) => source.roomId), ["r1", "r2"]);
});

test("results rank earlier matches above later ones", () => {
  const sources = [{
    roomId: "r1",
    roomName: "general",
    messages: [
      message("m1", "a long message about target words", 300),
      message("m2", "target at the start", 100),
    ],
  }];
  const results = searchMessages("target", sources);
  assert.deepEqual(results.map((result) => result.message.id), ["m2", "m1"]);
  assert.ok(results[0].snippet.includes("target"));
});

test("snippets show context with ellipses", () => {
  const text = `${"x".repeat(40)} needle ${"y".repeat(40)}`;
  const snippet = snippetOf(text, text.indexOf("needle"), 6, 8);
  assert.ok(snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
  assert.ok(snippet.includes("needle"));
});

test("recalled messages are excluded from search", () => {
  const sources = [{
    roomId: "r1",
    roomName: "general",
    messages: [
      message("m1", "target visible", 1),
      message("m2", "target recalled", 2, { recalledAt: 3 }),
    ],
  }];
  const results = searchMessages("target", sources);
  assert.deepEqual(results.map((result) => result.message.id), ["m1"]);
});

test("empty queries return no results and limits apply", () => {
  const sources = [{
    roomId: "r1",
    roomName: "general",
    messages: [message("m1", "target one", 1), message("m2", "target two", 2)],
  }];
  assert.deepEqual(searchMessages("", sources), []);
  assert.equal(searchMessages("target", sources, { limit: 1 }).length, 1);
});