import { randomUUID } from "node:crypto";

export type Participant = {
  id: string;
  name: string;
  joinedAt: number;
};

export type Message = {
  id: string;
  roomId: string;
  senderId: string;
  text: string;
  createdAt: number;
};

export type Room = {
  id: string;
  name: string;
  ownerId: string;
  participants: Map<string, Participant>;
  messages: Message[];
  createdAt: number;
};

export type RoomErrorCode =
  | "ROOM_NOT_FOUND"
  | "PARTICIPANT_NOT_FOUND"
  | "NOT_JOINED"
  | "EMPTY_MESSAGE";

export class RoomError extends Error {
  readonly code: RoomErrorCode;

  constructor(code: RoomErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RoomError";
    this.code = code;
  }
}

export default class RoomService {
  private rooms: Map<string, Room> = new Map();

  hydrate(rooms: Room[]): void {
    for (const room of rooms) {
      this.rooms.set(room.id, room);
    }
  }

  createRoom(name: string, ownerId: string): Room {
    const room: Room = {
      id: randomUUID(),
      name,
      ownerId,
      participants: new Map(),
      messages: [],
      createdAt: Date.now(),
    };
    room.participants.set(ownerId, {
      id: ownerId,
      name: ownerId,
      joinedAt: Date.now(),
    });
    this.rooms.set(room.id, room);
    return room;
  }

  getRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RoomError("ROOM_NOT_FOUND", `room not found: ${roomId}`);
    }
    return room;
  }

  listRooms(): Room[] {
    return [...this.rooms.values()];
  }

  joinRoom(
    roomId: string,
    participant: { id: string; name: string },
  ): Participant {
    const room = this.getRoom(roomId);
    // ponytail: the same identity from another session is the same member —
    // a second window on the same machine must not be locked out
    const existing = room.participants.get(participant.id);
    if (existing) {
      return existing;
    }
    const member: Participant = {
      id: participant.id,
      name: participant.name,
      joinedAt: Date.now(),
    };
    room.participants.set(member.id, member);
    return member;
  }

  leaveRoom(roomId: string, participantId: string): void {
    const room = this.getRoom(roomId);
    if (!room.participants.delete(participantId)) {
      throw new RoomError("NOT_JOINED", `not joined: ${participantId}`);
    }
  }

  sendMessage(roomId: string, senderId: string, text: string): Message {
    const room = this.getRoom(roomId);
    if (!room.participants.has(senderId)) {
      throw new RoomError("NOT_JOINED", `not joined: ${senderId}`);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new RoomError("EMPTY_MESSAGE", "message text is empty");
    }
    const message: Message = {
      id: randomUUID(),
      roomId,
      senderId,
      text: trimmed,
      createdAt: Date.now(),
    };
    room.messages.push(message);
    return message;
  }

  getMessages(roomId: string): Message[] {
    return [...this.getRoom(roomId).messages];
  }

  getParticipants(roomId: string): Participant[] {
    return [...this.getRoom(roomId).participants.values()];
  }

  containsParticipant(roomId: string, participantId: string): boolean {
    return this.rooms.get(roomId)?.participants.has(participantId) ?? false;
  }
}
