/**
 * Minimal protobuf codec for Feishu's pbbp2 WebSocket frame. The schema is fixed
 * (fields 1-9), so a dependency-free codec beats shipping a protobuf runtime.
 */
export interface WsHeader {
  key: string;
  value: string;
}

export interface WsFrame {
  SeqID?: number;
  LogID?: number;
  service?: number;
  method?: number;
  headers?: WsHeader[];
  payload_encoding?: string;
  payload_type?: string;
  payload?: Uint8Array;
  LogIDNew?: string;
}

const utf8 = new TextEncoder();

function varint(value: number): number[] {
  let rest = BigInt(Math.max(0, Math.trunc(value)));
  const out: number[] = [];
  while (rest > 0x7fn) {
    out.push(Number((rest & 0x7fn) | 0x80n));
    rest >>= 7n;
  }
  out.push(Number(rest));
  return out;
}

function fieldKey(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function bytesField(field: number, value: Uint8Array): number[] {
  return [...fieldKey(field, 2), ...varint(value.length), ...value];
}

function stringField(field: number, value: string): number[] {
  return bytesField(field, utf8.encode(value));
}

function numberField(field: number, value: number): number[] {
  return [...fieldKey(field, 0), ...varint(value)];
}

export function encodeFrame(frame: WsFrame): Uint8Array {
  const out: number[] = [];
  out.push(...numberField(1, frame.SeqID ?? 0));
  out.push(...numberField(2, frame.LogID ?? 0));
  out.push(...numberField(3, frame.service ?? 0));
  out.push(...numberField(4, frame.method ?? 0));
  for (const header of frame.headers ?? []) {
    const entry = [...stringField(1, header.key), ...stringField(2, header.value)];
    out.push(...bytesField(5, Uint8Array.from(entry)));
  }
  if (frame.payload_encoding) out.push(...stringField(6, frame.payload_encoding));
  if (frame.payload_type) out.push(...stringField(7, frame.payload_type));
  if (frame.payload) out.push(...bytesField(8, frame.payload));
  if (frame.LogIDNew) out.push(...stringField(9, frame.LogIDNew));
  return Uint8Array.from(out);
}

class Reader {
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  get done(): boolean {
    return this.#offset >= this.#bytes.length;
  }

  varint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (this.#offset >= this.#bytes.length) throw new Error("truncated varint");
      const byte = this.#bytes[this.#offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 70n) throw new Error("varint is too long");
    }
  }

  bytes(length: number): Uint8Array {
    if (this.#offset + length > this.#bytes.length) throw new Error("truncated frame field");
    const slice = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return slice;
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.bytes(8);
    else if (wire === 2) this.bytes(Number(this.varint()));
    else if (wire === 5) this.bytes(4);
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

function decodeHeader(bytes: Uint8Array): WsHeader {
  const reader = new Reader(bytes);
  let key = "";
  let value = "";
  while (!reader.done) {
    const tag = Number(reader.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    if (field === 1 && wire === 2) key = new TextDecoder().decode(reader.bytes(Number(reader.varint())));
    else if (field === 2 && wire === 2) value = new TextDecoder().decode(reader.bytes(Number(reader.varint())));
    else reader.skip(wire);
  }
  return { key, value };
}

export function decodeFrame(bytes: Uint8Array): WsFrame {
  const reader = new Reader(bytes);
  const frame: WsFrame = {};
  while (!reader.done) {
    const tag = Number(reader.varint());
    const field = tag >> 3;
    const wire = tag & 7;
    switch (field) {
      case 1:
        frame.SeqID = Number(reader.varint());
        break;
      case 2:
        frame.LogID = Number(reader.varint());
        break;
      case 3:
        frame.service = Number(reader.varint());
        break;
      case 4:
        frame.method = Number(reader.varint());
        break;
      case 5:
        frame.headers = [...(frame.headers ?? []), decodeHeader(reader.bytes(Number(reader.varint())))];
        break;
      case 6:
        frame.payload_encoding = new TextDecoder().decode(reader.bytes(Number(reader.varint())));
        break;
      case 7:
        frame.payload_type = new TextDecoder().decode(reader.bytes(Number(reader.varint())));
        break;
      case 8:
        frame.payload = reader.bytes(Number(reader.varint()));
        break;
      case 9:
        frame.LogIDNew = new TextDecoder().decode(reader.bytes(Number(reader.varint())));
        break;
      default:
        reader.skip(wire);
        break;
    }
  }
  return frame;
}

export function headerValue(frame: WsFrame, key: string): string | undefined {
  return frame.headers?.find((header) => header.key === key)?.value;
}

export function jsonPayload(value: unknown): Uint8Array {
  return utf8.encode(JSON.stringify(value));
}