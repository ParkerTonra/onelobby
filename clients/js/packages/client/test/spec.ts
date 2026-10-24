import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../../../spec");
export function specJson<T = any>(rel: string): T {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as T;
}
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
