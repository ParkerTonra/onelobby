#!/usr/bin/env node
// conformance/server runner.   node conformance/server/run.mjs ws://localhost:8080/ws [options]   (see README.md)
import { Ctx, buildSuite } from './suite.mjs';
import { Client, sleep } from './client.mjs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export function parseArgs(argv) {
  const o = { url: null, gameId: `conf-${Math.random().toString(36).slice(2, 7)}`, only: null, groups: null, ratelimit: false, slow: false, fresh: false, direct: false,
    noHealth: false, disallowedGame: null, expectFull: false, json: false, limits: {}, timeout: 30000 };
  for (const a of argv) {
    if (!a.startsWith('--')) { o.url = a; continue; }
    const [k, v] = a.slice(2).split('=');
    switch (k) {
      case 'game-id': o.gameId = v; break;
      case 'only': o.only = v; break;
      case 'group': o.groups = v.split(','); break;
      case 'ratelimit': o.ratelimit = true; break;
      case 'slow': o.slow = true; break;
      case 'fresh': o.fresh = true; break;
      case 'direct': o.direct = true; break;
      case 'no-health': o.noHealth = true; break;
      case 'disallowed-game': o.disallowedGame = v; break;
      case 'expect-full': o.expectFull = true; break;
      case 'json': o.json = true; break;
      case 'timeout': o.timeout = Number(v); break;
      case 'rate-create': o.limits.rateCreate = Number(v); break;
      case 'rate-join': o.limits.rateJoin = Number(v); break;
      case 'rate-signal': o.limits.rateSignal = Number(v); break;
      case 'max-open': o.limits.maxOpen = Number(v); break;
      default: throw new Error(`unknown option --${k}`);
    }
  }
  return o;
}

export async function runSuite(opts, out = console.log) {
  let probe;
  try { probe = await Client.connect(opts.url, 'probe'); probe.close(); } catch (e) {
    out(`FATAL cannot connect to ${opts.url}: ${e.message}`);
    return { passed: 0, failed: 0, skipped: 0, fatal: true, results: [] };
  }
  const all = buildSuite(opts);
  const selected = all.filter((t) => {
    if (opts.ratelimit ? !t.rateLimitOnly : t.rateLimitOnly) return false;
    if (t.slowOnly && !opts.slow) return false;
    if (!!t.directOnly !== !!opts.direct) return false; // --direct: only the direct-hub tests, against a single-lobby hub
    if (opts.groups && !opts.groups.includes(t.group)) return false;
    if (opts.only && !`${t.group} ${t.name}`.toLowerCase().includes(opts.only.toLowerCase())) return false;
    return true;
  });
  // rate-limit tests last
  selected.sort((a, b) => Number(!!a.rateLimitOnly) - Number(!!b.rateLimitOnly));
  const results = [];
  let i = 0;
  for (const t of selected) {
    i++;
    const label = `${t.group}: ${t.name}`;
    const why = t.skip?.();
    if (why) { out(`skip ${i} - ${label} (${why})`); results.push({ label, status: 'skip' }); continue; }
    const ctx = new Ctx(opts);
    const t0 = Date.now();
    let err = null;
    try {
      await Promise.race([t.fn(ctx), new Promise((_, rej) => setTimeout(() => rej(new Error(`test timeout after ${opts.timeout} ms`)), opts.timeout))]);
    } catch (e) { err = e; }
    let violations = [];
    try { violations = await ctx.cleanup(); } catch (e) { violations = [`cleanup: ${e.message}`]; }
    if (!err && violations.length) err = new Error(`schema violations: ${violations.slice(0, 3).join(' | ')}`);
    if (err) {
      out(`not ok ${i} - ${label} (${Date.now() - t0} ms)\n    ${String(err.message).split('\n').join('\n    ')}`);
      results.push({ label, status: 'fail', error: err.message });
    } else {
      out(`ok ${i} - ${label} (${Date.now() - t0} ms)`);
      results.push({ label, status: 'pass' });
    }
    if (t.after === 'wait' && opts.ratelimit && i < selected.length) { out('    (waiting 61 s for the per-minute windows to reset)'); await sleep(61_000); }
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  out(`\n# ${opts.url}: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  return { passed, failed, skipped, results };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) { console.error('usage: node conformance/server/run.mjs ws://host:port/ws [--ratelimit] [--slow] [--fresh] [--only=text] [--group=a,b]'); process.exit(2); }
  const r = await runSuite(opts);
  if (opts.json) console.log(JSON.stringify(r));
  process.exit(r.fatal ? 2 : r.failed ? 1 : 0);
}
