import RoomService from "../rooms/room-service.ts";
import type { Registry } from "./store.ts";
import { type StateDatabase } from "./sqlite.ts";
import { openStateDatabase } from "./sqlite-database.ts";
import { immediate } from "./sqlite-transaction.ts";
import { cloneState, persistStateDiff, readRoomSummaries, readState, type RoomSummary, type State } from "./sqlite-rooms.ts";

export async function writeSqliteState<T>(file: string, callback: (service: RoomService, registry: Registry) => T): Promise<T> {
  return writeSqliteStateWithDatabase(file, (service, registry) => callback(service, registry));
}

export async function writeSqliteStateWithDatabase<T>(file: string, callback: (service: RoomService, registry: Registry, db: StateDatabase) => T): Promise<T> {
  const db = await openStateDatabase(file);
  return immediate(db, () => {
    const before = readState(db);
    const working = cloneState(before);
    const service = new RoomService();
    service.hydrate(working.rooms);
    const result = callback(service, working.registry, db);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("writeState callback must be synchronous");
    persistStateDiff(db, before, { rooms: service.listRooms(), registry: working.registry });
    return result;
  });
}

export async function readSqliteState(file: string): Promise<State> {
  const db = await openStateDatabase(file);
  return db.transaction(() => readState(db)).deferred();
}

export async function readSqliteRoomSummaries(file: string): Promise<RoomSummary[]> {
  const db = await openStateDatabase(file);
  return db.transaction(() => readRoomSummaries(db)).deferred();
}
