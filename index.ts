// ponytail: library surface — the room domain model; plugin wiring and
// file persistence stay internal
export { default as RoomService, RoomError } from "./src/room-service";
export type {
  Message,
  Participant,
  Room,
  RoomErrorCode,
} from "./src/room-service";
