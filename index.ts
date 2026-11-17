// ponytail: library surface — the room domain model; plugin wiring and
// file persistence stay internal
export { default } from "./plugin";
export { id, server, setup } from "./plugin";
export { default as RoomService, RoomError } from "./src/rooms/room-service.ts";
export type {
  Message,
  Participant,
  Room,
  RoomErrorCode,
} from "./src/rooms/room-service.ts";
