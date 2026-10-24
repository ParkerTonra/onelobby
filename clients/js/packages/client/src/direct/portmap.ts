/// <reference types="node" />
import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import { execFile } from "node:child_process";

export type PortMapMethod = "none" | "upnp" | "natpmp";

/** What {@link PortMapper.open} found. `mapped` means TCP and UDP `port` both forward here. */
export interface PortMapResult {
  mapped: boolean;
  method: PortMapMethod;
  /** The router's WAN address as it reports it (may itself be private or carrier-grade NAT). */
  externalIPv4: string | null;
  /** This PC's address on the router's network, when the router was found. */
  localIPv4: string | null;
  /** Why nothing was mapped, for logs. */
  detail: string;
}

/** Seams for tests (a fake gateway on loopback) and the few knobs a game might want. Same as C#'s PortMapperOptions. */
export interface PortMapperOptions {
  /** Where the SSDP M-SEARCH goes; default the UPnP multicast group 239.255.255.250:1900. */
  ssdp?: { address: string; port: number };
  /** NAT-PMP server; default this PC's IPv4 default gateway, port 5351. */
  natPmp?: { address: string; port: number };
  discoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Lease asked for; renewed at half of it while hosting. Routers that only allow permanent leases get 0. */
  leaseSeconds?: number;
  description?: string;
  tryUpnp?: boolean;
  tryNatPmp?: boolean;
}

const SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
];
const SERVICE_TYPES = [
  "urn:schemas-upnp-org:service:WANIPConnection:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

class UpnpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * Opens TCP and UDP `port` on the home router for a direct-IP host (docs/direct-ip.md s.2a): UPnP IGD (SSDP, then
 * GetExternalIPAddress + AddPortMapping), then NAT-PMP (RFC 6886). Node twin of C#'s `PortMapper`, same order and rules:
 * same external and internal port or nothing (a join code carries one port), leases renew at half-life, {@link close}
 * deletes the mappings. Windows Firewall drops SSDP replies on a network marked Public; the result is then unmapped.
 */
export class PortMapper {
  result: PortMapResult | null = null;
  private readonly o: Required<Omit<PortMapperOptions, "natPmp">> & { natPmp?: { address: string; port: number } };
  private control: URL | null = null;
  private service = "";
  private lease = 0;
  private natPmpAt: { address: string; port: number } | null = null;
  private renew: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(readonly port: number, options: PortMapperOptions = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError(`bad port ${port}`);
    this.o = {
      ssdp: { address: "239.255.255.250", port: 1900 },
      discoveryTimeoutMs: 2000,
      requestTimeoutMs: 3000,
      leaseSeconds: 7200,
      description: "OneLobby",
      tryUpnp: true,
      tryNatPmp: true,
      ...options,
    };
  }

  /** Finds the router and maps TCP + UDP `port`. Never rejects for network trouble: see `detail`. */
  async open(): Promise<PortMapResult> {
    const notes: string[] = [];
    if (this.o.tryUpnp) {
      try {
        const r = await this.tryUpnp();
        if (r) return this.done(r);
        notes.push("no UPnP gateway answered");
      } catch (e) {
        notes.push(`UPnP: ${(e as Error).message}`);
      }
    }
    if (this.o.tryNatPmp) {
      try {
        const r = await this.tryNatPmp();
        if (r) return this.done(r);
        notes.push("no NAT-PMP answer");
      } catch (e) {
        notes.push(`NAT-PMP: ${(e as Error).message}`);
      }
    }
    return (this.result = { mapped: false, method: "none", externalIPv4: null, localIPv4: null, detail: notes.join("; ") });
  }

  private done(r: PortMapResult): PortMapResult {
    this.result = r;
    if (r.mapped && !this.stopped && (this.lease > 0 || r.method === "natpmp")) {
      const everyMs = Math.max(30, (this.lease > 0 ? this.lease : this.o.leaseSeconds) / 2) * 1000;
      this.renew = setInterval(() => {
        const p = r.method === "upnp" ? this.addUpnpBoth(r.localIPv4!, this.lease) : this.natPmpMapBoth(this.o.leaseSeconds);
        p.catch(() => {}); // the next round tries again; the old lease still has half its life
      }, everyMs);
      this.renew.unref?.();
    }
    return r;
  }

  // ------------------------------------------------------------------------------------------------ UPnP IGD

  private async tryUpnp(): Promise<PortMapResult | null> {
    const location = await this.discover();
    if (!location) return null;
    const desc = await this.http("GET", location, null, {});
    const baseText = tag(desc.body, "URLBase");
    const base = baseText && /^https?:\/\//i.test(baseText) ? new URL(baseText) : location;
    for (const type of SERVICE_TYPES) {
      for (const svc of desc.body.match(/<service>[\s\S]*?<\/service>/g) ?? []) {
        if ((tag(svc, "serviceType") ?? "").trim() !== type) continue;
        const ctl = tag(svc, "controlURL")?.trim();
        if (!ctl) continue;
        this.control = new URL(ctl, base);
        this.service = type;
        break;
      }
      if (this.control) break;
    }
    if (!this.control) return { mapped: false, method: "upnp", externalIPv4: null, localIPv4: null, detail: "UPnP gateway has no WANIPConnection service" };

    const local = await localAddressToward(this.control.hostname, Number(this.control.port) || 80);
    let external: string | null = null;
    try {
      external = tag((await this.soap("GetExternalIPAddress", [])).body, "NewExternalIPAddress")?.trim() ?? null;
    } catch (e) {
      if (!(e instanceof UpnpError)) throw e; // some routers refuse this but still map
    }
    this.lease = this.o.leaseSeconds;
    try {
      await this.addUpnpBoth(local, this.lease);
    } catch (e) {
      if (!(e instanceof UpnpError)) throw e;
      if (e.code === 725) {
        // OnlyPermanentLeasesSupported
        this.lease = 0;
        await this.addUpnpBoth(local, 0);
      } else return { mapped: false, method: "upnp", externalIPv4: external, localIPv4: local, detail: `UPnP ${e.message}` };
    }
    return { mapped: true, method: "upnp", externalIPv4: external, localIPv4: local, detail: "UPnP" };
  }

  private async addUpnpBoth(local: string, lease: number): Promise<void> {
    for (const proto of ["TCP", "UDP"])
      await this.soap("AddPortMapping", [
        ["NewRemoteHost", ""], ["NewExternalPort", String(this.port)], ["NewProtocol", proto], ["NewInternalPort", String(this.port)],
        ["NewInternalClient", local], ["NewEnabled", "1"], ["NewPortMappingDescription", this.o.description], ["NewLeaseDuration", String(lease)],
      ]);
  }

  /**
   * SSDP search: multicast once per interface that has a gateway (so a Hyper-V, WSL or Docker adapter cannot swallow
   * it), plus a unicast copy to the gateway.
   */
  private discover(): Promise<URL | null> {
    const multicast = Number(this.o.ssdp.address.split(".")[0]) >= 224;
    const locals = multicast ? gatewayInterfaces() : [];
    if (locals.length === 0) locals.push({ local: "0.0.0.0", gateway: null });
    return new Promise((resolve) => {
      const sockets: UdpSocket[] = [];
      let finished = false;
      const finish = (u: URL | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        for (const s of sockets) s.close();
        resolve(u);
      };
      const timer = setTimeout(() => finish(null), this.o.discoveryTimeoutMs);
      for (const { local, gateway } of locals) {
        const s = createSocket({ type: "udp4", reuseAddr: false });
        sockets.push(s);
        s.on("error", () => {});
        s.on("message", (m) => {
          const u = parseSsdp(m.toString("latin1"));
          if (u) finish(u);
        });
        s.bind(0, local === "0.0.0.0" ? undefined : local, () => {
          try {
            s.setMulticastTTL(2);
            if (local !== "0.0.0.0") s.setMulticastInterface(local);
          } catch {
            /* not fatal: the OS default interface is used */
          }
          for (const st of SEARCH_TARGETS) {
            const b = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`);
            s.send(b, this.o.ssdp.port, this.o.ssdp.address, () => {});
            if (gateway) s.send(b, 1900, gateway, () => {});
          }
        });
      }
    });
  }

  private async soap(action: string, args: [string, string][]): Promise<{ status: number; body: string }> {
    const inner = args.map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join("");
    const body =
      `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
      `<s:Body><u:${action} xmlns:u="${this.service}">${inner}</u:${action}></s:Body></s:Envelope>`;
    const res = await this.http("POST", this.control!, body, { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${this.service}#${action}"` });
    if (res.status < 200 || res.status >= 300) {
      const code = tag(res.body, "errorCode");
      const desc = tag(res.body, "errorDescription") ?? "";
      throw new UpnpError(Number(code) || 0, `${action} error ${code ?? res.status} ${desc}`.trim());
    }
    return res;
  }

  /**
   * One connection per request: some routers close after each reply without saying so, and a reused
   * keep-alive socket then fails every second request with "socket hang up".
   */
  private http(method: string, url: URL, body: string | null, headers: Record<string, string>): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const h = { ...headers, Connection: "close" };
      const req = httpRequest(
        { method, hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search, timeout: this.o.requestTimeoutMs, agent: false,
          headers: body === null ? h : { ...h, "Content-Length": Buffer.byteLength(body) } },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
        },
      );
      req.on("timeout", () => req.destroy(new Error(`${method} ${url.pathname} timed out`)));
      req.on("error", reject);
      if (body !== null) req.write(body);
      req.end();
    });
  }

  // ------------------------------------------------------------------------------------------------ NAT-PMP

  private async tryNatPmp(): Promise<PortMapResult | null> {
    // One gateway only: each silent one costs the full retransmission budget.
    let gw0 = this.o.natPmp ?? null;
    if (!gw0) {
      const routed = (await defaultGatewayFallback()) ?? gatewayInterfaces().find((g) => g.gateway)?.gateway ?? null;
      if (routed) gw0 = { address: routed, port: 5351 };
    }
    const candidates = gw0 ? [gw0] : [];
    for (const gw of candidates) {
      const ext = await this.natPmpRequest(gw, Buffer.from([0, 0]), 12);
      if (!ext) continue;
      this.natPmpAt = gw;
      const local = await localAddressToward(gw.address, gw.port);
      const external = ext.readUInt16BE(2) === 0 ? `${ext[8]}.${ext[9]}.${ext[10]}.${ext[11]}` : null;
      const err = await this.natPmpMapBoth(this.o.leaseSeconds);
      if (err) return { mapped: false, method: "natpmp", externalIPv4: external, localIPv4: local, detail: `NAT-PMP ${err}` };
      return { mapped: true, method: "natpmp", externalIPv4: external, localIPv4: local, detail: "NAT-PMP" };
    }
    return null;
  }

  /** Maps UDP then TCP; null on success, else why. A different external port counts as failure (and is undone). */
  private async natPmpMapBoth(lifetime: number): Promise<string | null> {
    for (const op of [1, 2]) {
      const reply = await this.natPmpRequest(this.natPmpAt!, this.mapRequest(op, lifetime), 16);
      if (!reply) return "no answer to the mapping request";
      const rc = reply.readUInt16BE(2);
      if (rc !== 0) return `result code ${rc}`;
      const mapped = reply.readUInt16BE(10);
      if (lifetime > 0 && mapped !== this.port) {
        await this.natPmpRequest(this.natPmpAt!, this.mapRequest(op, 0), 16);
        return `router offered port ${mapped} instead of ${this.port}`;
      }
    }
    return null;
  }

  private mapRequest(op: number, lifetime: number): Buffer {
    const b = Buffer.alloc(12);
    b[1] = op;
    b.writeUInt16BE(this.port, 4);
    b.writeUInt16BE(lifetime > 0 ? this.port : 0, 6);
    b.writeUInt32BE(lifetime, 8);
    return b;
  }

  /** RFC 6886 s.3.1 retransmission: 250 ms, doubling, 3 tries (under 2 s). Null when nobody answers. */
  private natPmpRequest(to: { address: string; port: number }, req: Buffer, replyLength: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const s = createSocket("udp4");
      let wait = 250;
      let tries = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (b: Buffer | null) => {
        if (timer) clearTimeout(timer);
        s.close();
        resolve(b);
      };
      s.on("error", () => {}); // ICMP port unreachable on Windows: keep waiting for the timer
      s.on("message", (b) => {
        if (b.length >= replyLength && b[0] === 0 && b[1] === req[1] + 128) finish(b);
      });
      const attempt = () => {
        if (tries++ >= 3) return finish(null);
        s.send(req, to.port, to.address, () => {});
        timer = setTimeout(attempt, wait);
        wait *= 2;
      };
      s.bind(0, attempt);
    });
  }

  /** Deletes the mappings (best effort, bounded to about 1.5 s) and stops renewing. */
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.renew) clearInterval(this.renew);
    const r = this.result;
    if (!r?.mapped) return;
    const work =
      r.method === "upnp"
        ? Promise.all(["TCP", "UDP"].map((p) => this.soap("DeletePortMapping", [["NewRemoteHost", ""], ["NewExternalPort", String(this.port)], ["NewProtocol", p]])))
        : Promise.all([1, 2].map((op) => this.natPmpOnce(this.mapRequest(op, 0))));
    await Promise.race([work.catch(() => {}), new Promise((r2) => setTimeout(r2, 1500).unref?.())]);
  }

  private natPmpOnce(req: Buffer): Promise<void> {
    return new Promise((resolve) => {
      const s = createSocket("udp4");
      s.on("error", () => {});
      s.send(req, this.natPmpAt!.port, this.natPmpAt!.address, () => {
        s.close();
        resolve();
      });
    });
  }
}

// ------------------------------------------------------------------------------------------------ helpers

/**
 * True for an address the internet can route to: not private (RFC 1918), carrier-grade NAT (100.64/10), loopback,
 * link-local, 0/8, or multicast/reserved (224+). A router that reports a non-public WAN address is itself behind NAT.
 */
export function isPublicIPv4(address: string | null | undefined): boolean {
  if (!address) return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b < 128) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b < 32) return false;
  if (a === 192 && b === 168) return false;
  return true;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${name}>`).exec(xml);
  return m ? m[1] : null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function parseSsdp(text: string): URL | null {
  let location: string | null = null;
  let gateway = false;
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (name === "location") location = value;
    if ((name === "st" || name === "usn") && /InternetGatewayDevice|WANIPConnection/.test(value)) gateway = true;
  }
  if (!gateway || !location) return null;
  try {
    return new URL(location);
  } catch {
    return null;
  }
}

/**
 * Each IPv4 interface address, with its gateway when one can be guessed. Node's `os` does not report gateways, so the
 * gateway is the interface's .1 (true for nearly every home router); the SSDP multicast does not depend on it.
 */
function gatewayInterfaces(): { local: string; gateway: string | null }[] {
  const out: { local: string; gateway: string | null }[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      const net = ip.map((x, i) => x & mask[i]);
      out.push({ local: a.address, gateway: mask[3] === 255 ? null : `${net[0]}.${net[1]}.${net[2]}.${net[3] + 1}` });
    }
  }
  return out;
}

/** The IPv4 default gateway from the OS route table (Windows `route print`, else `ip route`); null if it will not say. */
function defaultGatewayFallback(): Promise<string | null> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    execFile(win ? "route" : "ip", win ? ["print", "0.0.0.0"] : ["route", "show", "default"], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = win ? /0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/.exec(stdout) : /default via (\d+\.\d+\.\d+\.\d+)/.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
}

/** The local IPv4 the OS would use to reach `host` (a connected UDP socket sends nothing). */
function localAddressToward(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createSocket("udp4");
    s.on("error", (e) => {
      s.close();
      reject(e);
    });
    s.connect(port, host, () => {
      const a = s.address().address;
      s.close();
      resolve(a);
    });
  });
}

/** The IPv4 a same-network join code carries when the router was not found (see C#'s DirectAddress.LanIPv4). */
export async function lanIPv4(): Promise<string | null> {
  try {
    const a = await localAddressToward("192.0.2.1", 9); // TEST-NET-1: routed like the internet, never contacted
    if (a && a !== "0.0.0.0" && !a.startsWith("127.")) return a;
  } catch {
    /* no default route: offline LAN party, look at the interfaces instead */
  }
  return gatewayInterfaces()[0]?.local ?? null;
}

/** This machine's addresses with the port, IPv4 first, for an "Advanced" fold-out on the host screen. */
export function localAddresses(port: number): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4" && !a.address.startsWith("169.254.")) v4.push(`${a.address}:${port}`);
      else if (a.family === "IPv6" && !/^fe80:/i.test(a.address) && !/^ff/i.test(a.address)) v6.push(`[${a.address}]:${port}`);
    }
  }
  return [...v4, ...v6];
}
