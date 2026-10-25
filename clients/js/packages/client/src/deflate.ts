import { CodecError, MAX_REASSEMBLED_BYTES } from "./codec.js";

/** Optional zlib deflate for snapshots (CompressionStream where present; .NET ZLibStream is the matching side). */

export function deflateAvailable(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

async function pipe(
  bytes: Uint8Array,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  maxBytes = Infinity,
) {
  const w = stream.writable.getWriter();
  void w.write(bytes as unknown as Uint8Array<ArrayBuffer>).then(() => w.close()).catch(() => {});
  const chunks: Uint8Array[] = [];
  const r = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total > maxBytes) {
      void r.cancel().catch(() => {});
      throw new CodecError("too_long", `snapshot inflates to more than ${maxBytes} bytes`);
    }
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream("deflate") as never);
}
/** Inflates at most `maxBytes` (default 64 MiB): a few KB can inflate to gigabytes. Over it rejects with CodecError too_long. */
export function inflate(bytes: Uint8Array, maxBytes = MAX_REASSEMBLED_BYTES): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("deflate") as never, maxBytes);
}
