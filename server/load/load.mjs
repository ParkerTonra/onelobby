// OneLobby server load script: N lobbies x P sockets each, then a signal storm.
//   node server/load/load.mjs ws://localhost:8080/ws [--lobbies 1000] [--per-lobby 5] [--seconds 20] [--metrics http://localhost:8080/metrics]
// Start the server with the per-IP limits off (one machine = one IP):
//   onelobby-server --disable-ip-limits --max-lobbies 2000
// Needs Node 22+ (global WebSocket, no dependencies).

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('ws')) ?? 'ws://localhost:8080/ws';
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const LOBBIES = Number(opt('lobbies', 1000));
const PER = Number(opt('per-lobby', 5));
const SECONDS = Number(opt('seconds', 20));
const METRICS = opt('metrics', url.replace(/^ws/, 'http').replace(/\/ws$/, '/metrics'));
const BATCH = 100; // sockets opened at once

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lat = [];
let signalsSent = 0;
let signalsGot = 0;
let errors = 0;

class C {
  constructor(name) {
    this.name = name;
    this.waiters = [];
    this.peerId = 0;
    this.onSignal = null;
  }
  open() {
    return new Promise((res, rej) => {
      const ws = (this.ws = new WebSocket(url));
      ws.onerror = () => rej(new Error('socket error'));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'signal' && this.onSignal) this.onSignal(m);
        if (m.t === 'error') errors++;
        const i = this.waiters.findIndex((w) => w.t === m.t);
        if (i >= 0) this.waiters.splice(i, 1)[0].res(m);
      };
      ws.onopen = async () => {
        this.send({ t: 'hello', proto: 'lk1', gameId: 'load', netVersion: '1', name: this.name, client: { lib: 'load', ver: '0', platform: 'node' } });
        await this.wait('welcome');
        res();
      };
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  wait(t, ms = 15000) {
    return new Promise((res, rej) => {
      const w = { t, res };
      this.waiters.push(w);
      setTimeout(() => rej(new Error('timeout waiting for ' + t)), ms).unref();
    });
  }
}

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : 0);

const lobbies = [];
const t0 = Date.now();
for (let base = 0; base < LOBBIES; base += BATCH) {
  const n = Math.min(BATCH, LOBBIES - base);
  await Promise.all(
    Array.from({ length: n }, async (_, k) => {
      const host = new C(`h${base + k}`);
      await host.open();
      const lw = host.wait('lobby');
      host.send({ t: 'create', name: `L${base + k}`, maxPlayers: PER, visibility: 'public', mode: 'raw', tickRate: 20, lateJoin: false, meta: {} });
      const code = (await lw).code;
      const members = [host];
      for (let p = 1; p < PER; p++) {
        const c = new C(`p${base + k}_${p}`);
        await c.open();
        const jw = c.wait('lobby');
        c.send({ t: 'join', code });
        await jw;
        members.push(c);
      }
      lobbies.push(members);
    }),
  );
}
const setupMs = Date.now() - t0;
const sockets = lobbies.reduce((s, l) => s + l.length, 0);
console.log(`setup: ${lobbies.length} lobbies, ${sockets} sockets in ${setupMs} ms`);

// Signal storm: each non-host sends an ice signal to the host a few times a second and the host answers; measure echo latency.
const pending = new Map();
for (const members of lobbies) {
  const host = members[0];
  host.onSignal = (m) => host.send({ t: 'signal', to: m.from, ice: { candidate: m.ice.candidate } });
  for (const c of members.slice(1)) {
    c.onSignal = (m) => {
      const s = pending.get(m.ice.candidate);
      if (s !== undefined) { lat.push(Date.now() - s); pending.delete(m.ice.candidate); signalsGot++; }
    };
  }
}
let seq = 0;
const end = Date.now() + SECONDS * 1000;
const pings = setInterval(() => {
  for (const members of lobbies) for (const c of members) c.send({ t: 'ping', n: 1 });
}, 10000);
while (Date.now() < end) {
  const tick = Date.now();
  for (const members of lobbies) {
    const c = members[1 + (seq % (PER - 1))];
    const id = `c${seq++}`;
    pending.set(id, Date.now());
    c.send({ t: 'signal', to: 1, ice: { candidate: id } });
    signalsSent++;
  }
  await sleep(Math.max(0, 1000 - (Date.now() - tick))); // one signal per lobby per second
}
await sleep(500);
clearInterval(pings);
console.log(`signals: sent ${signalsSent}, echoed ${signalsGot}, errors ${errors}`);
console.log(`echo latency ms: p50 ${pct(lat, 50)}  p95 ${pct(lat, 95)}  p99 ${pct(lat, 99)}  max ${Math.max(0, ...lat)}`);
try {
  const text = await (await fetch(METRICS)).text();
  console.log(text.split('\n').filter((l) => /^onelobby_(lobbies|sockets) /.test(l)).join('\n'));
} catch (e) {
  console.log('metrics unavailable:', e.message);
}
for (const members of lobbies) for (const c of members) c.ws.close();
await sleep(500);
process.exit(errors === 0 && signalsGot === signalsSent ? 0 : 1);
