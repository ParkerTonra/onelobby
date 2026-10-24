import type { Message } from "./codec.js";

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

/** Reassembles chunked payloads by id. Duplicates are ignored; out-of-order chunks are fine. */
export class Reassembler {
  private parts = new Map<number, Partial>();

  /** Returns the full payload when the last chunk arrives, otherwise null. */
  push(chunk: { id: number; index: number; count: number; bytes: Uint8Array }): Uint8Array | null {
    if (chunk.count === 0 || chunk.index >= chunk.count) return null;
    let e = this.parts.get(chunk.id);
    if (!e || e.count !== chunk.count) {
      e = { count: chunk.count, got: 0, parts: new Array(chunk.count), bytes: 0 };
      this.parts.set(chunk.id, e);
    }
    if (e.parts[chunk.index]) return null;
    e.parts[chunk.index] = chunk.bytes;
    e.got++;
    e.bytes += chunk.bytes.length;
    if (e.got < e.count) return null;
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
  clear(): void {
    this.parts.clear();
  }
}
