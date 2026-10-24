// Self-test: the conformance/server suite must be fully green against the in-process reference mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-server.mjs';
import { parseArgs, runSuite } from './run.mjs';

test('functional suite is green against the reference mock', async () => {
  const s = await startMock({ scale: 20, allowedGameIds: null });
  try {
    const r = await runSuite({ ...parseArgs([s.url]) }, () => {});
    assert.equal(r.failed, 0, r.results.filter((x) => x.status === 'fail').map((x) => `${x.label}: ${x.error}`).join('\n'));
    assert.ok(r.passed >= 50);
  } finally { await s.close(); }
});

test('game_not_allowed and server_full policy tests are green against a restricted mock', async () => {
  const s = await startMock({ allowedGameIds: ['only-this'], maxLobbies: 0 });
  try {
    const o = parseArgs([s.url, '--disallowed-game=other', '--expect-full', '--game-id=only-this', '--group=policy']);
    const r = await runSuite(o, () => {});
    assert.equal(r.failed, 0, JSON.stringify(r.results));
    assert.equal(r.passed, 2);
  } finally { await s.close(); }
});

for (const only of ['open lobbies', 'create: more', 'join: more', 'signal: bursts']) {
  test(`rate limits on a fresh mock: ${only}`, async () => {
    const s = await startMock({ scale: 1 });
    try {
      const r = await runSuite(parseArgs([s.url, '--ratelimit', '--fresh', `--only=${only}`, '--no-health']), () => {});
      assert.equal(r.passed, 1, JSON.stringify(r.results));
    } finally { await s.close(); }
  });
}
