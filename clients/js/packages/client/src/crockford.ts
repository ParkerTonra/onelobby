/** Crockford Base32 (DESIGN s.6): digits + 22 letters, no I L O U. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 6;

/** ASCII-only uppercasing: `ß` must not fold to `SS`. */
function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Decode user input to the canonical code form (upper case, no separators, `i`/`l` -> `1`, `o` -> `0`).
 * Returns null when the input is not a valid 6-character code.
 */
export function normalizeCode(input: string): string | null {
  const s = asciiUpper(input)
    .replace(/[ \-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (CROCKFORD_ALPHABET.indexOf(ch) < 0) return null;
  return s;
}

/** Canonical code -> `7HQ 4K2` display form. */
export function formatCode(code: string): string {
  const c = normalizeCode(code) ?? code.toUpperCase();
  return c.length === CODE_LENGTH ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** Numeric value of a Crockford string (same alias rules). Throws on invalid characters. */
export function decodeCrockford(input: string): bigint {
  const s = asciiUpper(input).replace(/[ \-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  let v = 0n;
  for (const ch of s) {
    const i = CROCKFORD_ALPHABET.indexOf(ch);
    if (i < 0) throw new Error(`invalid Crockford character '${ch}'`);
    v = v * 32n + BigInt(i);
  }
  return v;
}

/** Inverse of decodeCrockford, left-padded to `length` if given. */
export function encodeCrockford(value: bigint, length = 0): string {
  let s = "";
  let v = value;
  if (v < 0n) throw new Error("negative value");
  while (v > 0n) {
    s = CROCKFORD_ALPHABET[Number(v % 32n)] + s;
    v /= 32n;
  }
  if (s === "") s = "0";
  return s.padStart(length, "0");
}
