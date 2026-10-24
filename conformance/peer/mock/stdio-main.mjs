// The mock adapter served over stdio JSON lines: proves the cross-language path and doubles as a template.
//   harness -> adapter:  {"id":1,"op":"start",...args}\n          adapter -> harness: {"id":1,"ok":true,"result":{...}}\n
//   adapter -> harness:  {"ev":"send","to":1,"channel":"reliable","hex":"..."}\n   (events, no id)
import { createInterface } from 'node:readline';
import createAdapter from './adapter.mjs';

const a = createAdapter();
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
a.onevent = (e) => out(e);
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, op, ...args } = req;
  try { out({ id, ok: true, result: await a.call(op, args) }); } catch (e) { out({ id, ok: false, error: String(e.message ?? e) }); }
});
rl.on('close', async () => { await a.dispose(); process.exit(0); });
