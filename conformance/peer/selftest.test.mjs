// Self-test: the peer harness is green against the reference mock (in-process and over stdio), and red against a broken library.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPeerSuite } from './run.mjs';

const stdioMain = fileURLToPath(new URL('./mock/stdio-main.mjs', import.meta.url));
const mockUrl = new URL('./mock/adapter.mjs', import.meta.url).href;
const failures = (r) => r.results.filter((x) => x.status === 'fail').map((x) => `${x.label}: ${x.error}`).join('\n');

test('peer suite green against the in-process mock', async () => {
  const r = await runPeerSuite({ mock: true, timeout: 20000 }, () => {});
  assert.equal(r.failed, 0, failures(r));
  assert.ok(r.passed >= 25);
});

test('peer suite green against the mock over the stdio JSON-lines adapter', async () => {
  const r = await runPeerSuite({ stdio: `node "${stdioMain}"`, timeout: 20000 }, () => {});
  assert.equal(r.failed, 0, failures(r));
  assert.ok(r.passed >= 25);
});

test('peer suite is red against a library that never sends hash frames', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kp-'));
  const file = join(dir, 'broken.mjs');
  writeFileSync(file, [
    `import createMock from ${JSON.stringify(mockUrl)};`,
    'export default function () {',
    '  const a = createMock(); let h = () => {};',
    "  return { set onevent(f) { h = f; a.onevent = (e) => { if (e.ev === 'send' && e.hex.startsWith('12')) return; h(e); }; },",
    '    call: (op, x) => a.call(op, x), dispose: () => a.dispose() };',
    '}',
  ].join('\n'));
  const r = await runPeerSuite({ adapter: file, timeout: 6000, only: 'frames drive the game' }, () => {});
  assert.equal(r.failed, 1);
});
