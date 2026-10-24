// Reference join-code rules (DESIGN s.6). Machine-readable twin: spec/codes.json.
export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const LENGTH = 6;

// Returns the canonical 6-char code (uppercase Crockford), or null if the input cannot be a code.
// Rules: remove spaces and hyphens; uppercase (ASCII only); I and L become 1; O becomes 0; U (and anything else) is invalid.
export function normalize(input) {
  if (typeof input !== 'string') return null;
  const s = input.replace(/[ \-]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}

export function display(code) { return `${code.slice(0, 3)} ${code.slice(3)}`; }

export function generate(rand = Math.random) {
  let s = '';
  for (let i = 0; i < LENGTH; i++) s += ALPHABET[Math.floor(rand() * 32)];
  return s;
}
