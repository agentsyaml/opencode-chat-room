import { closeStateDatabases, openStateDatabase } from "../state/sqlite-state.ts";
import { databasePath, loadRooms, writeState } from "../state/store.ts";

const mode = process.argv[2];

if (mode === "write") {
  await writeState((service) => {
    const room = service.createRoom("restart room", "owner");
    service.sendMessage(room.id, "owner", "persisted");
  });
  console.log("written");
} else if (mode === "create") {
  const name = process.argv[3] ?? "instance room";
  const sessionID = process.argv[4] ?? "instance-session";
  const roomID = await writeState((service, registry) => {
    const room = service.createRoom(name, "owner");
    service.sendMessage(room.id, "owner", `hello from ${name}`);
    registry[room.id] = { [sessionID]: { serverUrl: "", apiPrefix: "/api", name: sessionID, lastReadTs: 0, lastQueuedTs: 0 } };
    return room.id;
  });
  console.log(roomID);
} else if (mode === "read") {
  console.log(JSON.stringify((await loadRooms()).map((room) => room.name)));
} else if (mode === "hold") {
  await openStateDatabase(databasePath());
  console.log("holding");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15_000);
} else {
  throw new Error(`unknown helper mode: ${mode}`);
}

await closeStateDatabases();