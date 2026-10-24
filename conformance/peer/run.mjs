#!/usr/bin/env node
// conformance/peer runner.
//   node conformance/peer/run.mjs --mock                         # built-in reference mock (harness self-test)
//   node conformance/peer/run.mjs --adapter=./path/adapter.mjs   # in-process JS adapter (default export: factory)
//   node conformance/peer/run.mjs --stdio="dotnet run --project X"   # any language, JSON lines on stdio
//   options: --only=text  --group=joiner,host,migration  --timeout=20000
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Session } from './lib/session.mjs';
import { buildScenarios } from './scenarios.mjs';
import { createStdioAdapter } from './adapters/stdio.mjs';
import createMock from './mock/adapter.mjs';

export function parseArgs(argv) {
  const o = { mock: false, adapter: null, stdio: null, only: null, groups: null, timeout: 20000 };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split(/=(.*)/s);
    if (k === 'mock') o.mock = true; else if (k === 'adapter') o.adapter = v; else if (k === 'stdio') o.stdio = v;
    else if (k === 'only') o.only = v; else if (k === 'group') o.groups = v.split(','); else if (k === 'timeout') o.timeout = Number(v);
  }
  return o;
}

async function makeAdapter(o) {
  if (o.mock) return createMock();
  if (o.stdio) return createStdioAdapter(o.stdio);
  if (o.adapter) { const m = await import(pathToFileURL(resolve(o.adapter)).href); return (m.default ?? m.createAdapter)(); }
  throw new Error('pick one of --mock, --adapter=<file>, --stdio=<command>');
}

export async function runPeerSuite(o, out = console.log) {
  const all = buildScenarios();
  let caps = null;
  const results = [];
  let i = 0;
  const probe = await makeAdapter(o);
  try { caps = (await probe.call('init', {})).capabilities ?? []; } catch (e) { out(`FATAL adapter init failed: ${e.message}`); await probe.dispose?.(); return { passed: 0, failed: 0, skipped: 0, fatal: true, results }; }
  await probe.dispose?.();
  for (const sc of all) {
    if (o.groups && !o.groups.includes(sc.group)) continue;
    if (o.only && !`${sc.group} ${sc.name}`.toLowerCase().includes(o.only.toLowerCase())) continue;
    i++;
    const label = `${sc.group}: ${sc.name}`;
    const missing = sc.needs.filter((n) => !caps.includes(n));
    if (missing.length) { out(`skip ${i} - ${label} (adapter lacks: ${missing.join(', ')})`); results.push({ label, status: 'skip' }); continue; }
    const adapter = await makeAdapter(o);
    const s = new Session(adapter, o);
    const t0 = Date.now();
    let err = null;
    try {
      await adapter.call('init', {});
      await Promise.race([sc.fn(s), new Promise((_, rej) => setTimeout(() => rej(new Error(`scenario timeout after ${o.timeout} ms`)), o.timeout))]);
    } catch (e) { err = e; }
    if (!err && s.violations.length) err = new Error(`protocol violations by the library: ${s.violations.slice(0, 3).join(' | ')}`);
    try { await adapter.call('stop', {}); } catch { /* ignore */ }
    await adapter.dispose?.();
    if (err) { out(`not ok ${i} - ${label} (${Date.now() - t0} ms)\n    ${String(err.message).split('\n').join('\n    ')}`); results.push({ label, status: 'fail', error: err.message }); }
    else { out(`ok ${i} - ${label} (${Date.now() - t0} ms)`); results.push({ label, status: 'pass' }); }
  }
  const count = (st) => results.filter((r) => r.status === st).length;
  out(`\n# peer conformance: ${count('pass')} passed, ${count('fail')} failed, ${count('skip')} skipped`);
  return { passed: count('pass'), failed: count('fail'), skipped: count('skip'), results };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const o = parseArgs(process.argv.slice(2));
  const r = await runPeerSuite(o);
  process.exit(r.fatal ? 2 : r.failed ? 1 : 0);
}
