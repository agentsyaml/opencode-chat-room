import { closeStateDatabases, openStateDatabase } from "../state/sqlite-state.ts";
import { databasePath, loadRooms, writeState } from "../state/store.ts";

const mode = process.argv[2];

if (mode === "write") {
  await writeState((service) => {
    const room = service.createRoom("restart room", "owner");
    service.sendMessage(room.id, "owner", "persisted");
  });
  console.log("written");
} else if (mode === "read") {
  console.log(JSON.stringify((await loadRooms()).map((room) => room.name)));
} else if (mode === "hold") {
  await openStateDatabase(databasePath());
  console.log("holding");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
} else if (mode === "expect-locked") {
  try {
    await openStateDatabase(databasePath());
    console.log(JSON.stringify({ code: "unexpected-open", message: "" }));
    process.exitCode = 2;
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.log(JSON.stringify({ code, message: (error as Error).message }));
    process.exitCode = code === "PG_SINGLE_INSTANCE" ? 0 : 3;
  }
} else {
  throw new Error(`unknown helper mode: ${mode}`);
}

await closeStateDatabases();