import { CodecError, MAX_REASSEMBLED_BYTES, type Message } from "./codec.js";

/** Chunk body capacity: 16 KiB frame - 3 header - 8 chunk header, rounded down for headroom. */
export const CHUNK_PAYLOAD = 16000;

export function splitChunks(id: number, bytes: Uint8Array, size = CHUNK_PAYLOAD): Message[] {
  const count = Math.max(1, Math.ceil(bytes.length / size));
  if (count > 0xffff) throw new RangeError("payload needs more than 65535 chunks");
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      type: "chunk",
      id,
      index: i,
      count,
      bytes: bytes.subarray(i * size, Math.min(bytes.length, (i + 1) * size)),
    });
  }
  return out;
}

interface Partial {
  count: number;
  got: number;
  parts: (Uint8Array | undefined)[];
  bytes: number;
}

/** Most incomplete chunk sets one reassembler (one peer) holds at once; a new id past this evicts the oldest. */
export const MAX_PARTIAL_SETS = 8;

/** Reassembles chunked payloads by id. Duplicates are ignored; out-of-order chunks are fine. */
export class Reassembler {
  private parts = new Map<number, Partial>(); // insertion order = oldest first

  /** Returns the full payload when the last chunk arrives, otherwise null. */
  push(chunk: { id: number; index: number; count: number; bytes: Uint8Array }): Uint8Array | null {
    if (chunk.count === 0 || chunk.index >= chunk.count) return null;
    let e = this.parts.get(chunk.id);
    if (!e || e.count !== chunk.count) {
      this.parts.delete(chunk.id);
      while (this.parts.size >= MAX_PARTIAL_SETS) this.parts.delete(this.parts.keys().next().value!);
      e = { count: chunk.count, got: 0, parts: new Array(chunk.count), bytes: 0 };
      this.parts.set(chunk.id, e);
    }
    if (e.parts[chunk.index]) return null;
    e.parts[chunk.index] = chunk.bytes;
    e.got++;
    e.bytes += chunk.bytes.length;
    if (e.bytes > MAX_REASSEMBLED_BYTES) {
      this.parts.delete(chunk.id);
      throw new CodecError("too_long", `chunk set over ${MAX_REASSEMBLED_BYTES} bytes`);
    }
    if (e.got < e.count) {
      // Many half-sent sets must not add up to more than one whole message: the oldest others go first.
      while (this.pendingBytes > MAX_REASSEMBLED_BYTES && this.parts.size > 1) {
        for (const id of this.parts.keys()) if (id !== chunk.id) { this.parts.delete(id); break; }
      }
      return null;
    }
    this.parts.delete(chunk.id);
    const out = new Uint8Array(e.bytes);
    let pos = 0;
    for (const p of e.parts) {
      out.set(p!, pos);
      pos += p!.length;
    }
    return out;
  }

  get pending(): number {
    return this.parts.size;
  }
  /** Bytes held across incomplete sets. */
  get pendingBytes(): number {
    let n = 0;
    for (const p of this.parts.values()) n += p.bytes;
    return n;
  }
  clear(): void {
    this.parts.clear();
  }
}
