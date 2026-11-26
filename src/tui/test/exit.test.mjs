import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.mjs";
import { buildCommands, filterCommands } from "../palette.mjs";

function makeApp() {
  return createApp({
    api: {
      async listRooms() { return []; },
      async poll() { return { member: true, items: [] }; },
      async markRead() {},
    },
    sessionID: "s1",
    participant: "alex",
    autoPoll: false,
  });
}

test("/exit lists the quit command and Enter quits through the app hook", async () => {
  const app = makeApp();
  app.openPalette({ slash: true });
  app.setPaletteQuery("/exit");
  assert.deepEqual(app.paletteCommands().map((command) => command.id), ["quit"]);
  await app.runPaletteSelection();
  assert.equal(app.state.quit, true);
  assert.equal(app.state.palette, null);
});

test("/quit and q resolve to the same single quit command", () => {
  const commands = buildCommands({});
  assert.equal(commands.filter((command) => command.id === "quit").length, 1);
  assert.equal(commands.some((command) => command.id === "exit"), false);
  for (const query of ["exit", "quit", "q"]) {
    assert.ok(filterCommands(commands, query).some((command) => command.id === "quit"), query);
  }
  assert.equal(filterCommands(commands, "settings").some((command) => command.id === "quit"), false);
});