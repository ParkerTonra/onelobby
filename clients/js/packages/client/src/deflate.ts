/** Optional zlib deflate for snapshots (CompressionStream where present; .NET ZLibStream is the matching side). */

export function deflateAvailable(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) {
  const w = stream.writable.getWriter();
  void w.write(bytes as unknown as Uint8Array<ArrayBuffer>).then(() => w.close());
  const chunks: Uint8Array[] = [];
  const r = stream.readable.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
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
export function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream("deflate") as never);
}
