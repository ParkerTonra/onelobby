import type { SocketLike } from "../src/transport.js";

/**
 * A few in-memory Nostr relays (NIP-01 subset: REQ with kinds / #t / since, EVENT, OK, EOSE). Ephemeral events are
 * forwarded to every matching subscription on the same relay and never stored. Knobs for the failure tests.
 */
export class FakeRelays {
  /**
   * True: every connect, delivery and close happens on the next turn of the event loop (setImmediate), not on a timer, so a test that
   * awaits `settle()` has seen all of it and waits no real time. Default: a 0 to 1 ms timer, as a real socket's delay.
   */
  constructor(readonly immediate = false) {}

  /** Runs `fn` after the fake network's delay: see `immediate`. */
  later(fn: () => void, ms: number): void {
    if (this.immediate) setImmediate(fn);
    else setTimeout(fn, ms);
  }

  /** URLs that refuse connections. */
  down = new Set<string>();
  /** URLs that answer every EVENT with ["OK", id, false, ...]. */
  refuse = new Set<string>();
  /** Fraction of forwarded events dropped on the way to a subscriber (0..1). */
  loss = 0;
  /** Events accepted, per URL. */
  accepted = new Map<string, number>();
  readonly sockets: FakeSocket[] = [];

  connect = (url: string): SocketLike => {
    const s = new FakeSocket(this, url);
    this.sockets.push(s);
    return s;
  };

  forward(from: FakeSocket, ev: { id: string; kind: number; tags: string[][]; created_at: number }): void {
    this.accepted.set(from.url, (this.accepted.get(from.url) ?? 0) + 1);
    for (const s of this.sockets) {
      if (s.url !== from.url || s.readyState !== 1) continue;
      for (const [sub, f] of s.subs) {
        if (f.kinds && !f.kinds.includes(ev.kind)) continue;
        const want = f["#t"];
        if (want && !ev.tags.some((t) => t[0] === "t" && want.includes(t[1]))) continue;
        if (f.since !== undefined && ev.created_at < f.since) continue;
        if (Math.random() < this.loss) continue;
        s.deliver(JSON.stringify(["EVENT", sub, ev]));
      }
    }
  }

  /** Drops every open socket of `url` (the relay restarts). */
  drop(url: string): void {
    for (const s of this.sockets) if (s.url === url && s.readyState === 1) s.serverClose();
  }
}

type Filter = { kinds?: number[]; "#t"?: string[]; since?: number };

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  readonly subs = new Map<string, Filter>();

  constructor(private readonly relays: FakeRelays, readonly url: string) {
    this.relays.later(() => {
      if (this.relays.down.has(url)) {
        this.readyState = 3;
        this.onerror?.({});
        this.onclose?.({});
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    }, 1);
  }

  send(data: string): void {
    if (this.readyState !== 1) return;
    const m = JSON.parse(data) as unknown[];
    if (m[0] === "REQ") {
      this.subs.set(String(m[1]), m[2] as Filter);
      this.deliver(JSON.stringify(["EOSE", m[1]]));
    } else if (m[0] === "EVENT") {
      const ev = m[1] as { id: string; kind: number; tags: string[][]; created_at: number };
      if (this.relays.refuse.has(this.url)) {
        this.deliver(JSON.stringify(["OK", ev.id, false, "blocked: not allowed"]));
        return;
      }
      this.deliver(JSON.stringify(["OK", ev.id, true, ""]));
      this.relays.forward(this, ev);
    }
  }

  deliver(text: string): void {
    this.relays.later(() => this.readyState === 1 && this.onmessage?.({ data: text }), 0);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relays.later(() => this.onclose?.({}), 0);
  }

  serverClose(): void {
    this.close();
  }
}
