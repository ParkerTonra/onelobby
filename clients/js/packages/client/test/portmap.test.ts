import { afterEach, describe, expect, it } from "vitest";
import { createSocket, type Socket } from "node:dgram";
import { createServer, type Server } from "node:http";
import { PortMapper, isPublicIPv4, type PortMapperOptions } from "../src/direct/portmap.js";

/** PortMapper against fake gateways on loopback (C#'s PortMapperTests, ported). */

const env = (body: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const arg = (body: string, name: string) => new RegExp(`<${name}>(.*?)</${name}>`).exec(body)?.[1] ?? "";

class FakeUpnp {
  ssdp: Socket = createSocket("udp4");
  http: Server;
  mappings = new Map<string, string>();
  external = "203.0.113.7";
  addError = 0;
  constructor() {
    this.http = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const send = (status: number, xml: string) => {
          res.writeHead(status, { "Content-Type": "text/xml" });
          res.end(xml);
        };
        if (req.method === "GET" && req.url === "/desc.xml")
          return send(200, `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device><serviceList><service>` +
            `<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>`);
        const action = /#(\w+)"/.exec(String(req.headers.soapaction))?.[1];
        if (action === "GetExternalIPAddress") return send(200, env(`<u:R xmlns:u="x"><NewExternalIPAddress>${this.external}</NewExternalIPAddress></u:R>`));
        if (action === "AddPortMapping") {
          if (this.addError && !(this.addError === 725 && arg(body, "NewLeaseDuration") === "0"))
            return send(500, env(`<s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${this.addError}</errorCode><errorDescription>nope</errorDescription></UPnPError></detail></s:Fault>`));
          this.mappings.set(`${arg(body, "NewProtocol")} ${arg(body, "NewExternalPort")}`, `${arg(body, "NewInternalClient")} lease ${arg(body, "NewLeaseDuration")}`);
          return send(200, env(""));
        }
        if (action === "DeletePortMapping") {
          this.mappings.delete(`${arg(body, "NewProtocol")} ${arg(body, "NewExternalPort")}`);
          return send(200, env(""));
        }
        send(500, "");
      });
    });
    this.ssdp.on("message", (m, r) => {
      if (!m.toString().startsWith("M-SEARCH") || !m.toString().includes("InternetGatewayDevice:1")) return;
      const port = (this.http.address() as { port: number }).port;
      this.ssdp.send(`HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://127.0.0.1:${port}/desc.xml\r\n\r\n`, r.port, r.address);
    });
  }
  async start() {
    await new Promise<void>((r) => this.ssdp.bind(0, "127.0.0.1", () => r()));
    await new Promise<void>((r) => this.http.listen(0, "127.0.0.1", () => r()));
    return this;
  }
  get ssdpEndpoint() {
    return { address: "127.0.0.1", port: this.ssdp.address().port };
  }
  stop() {
    this.ssdp.close();
    this.http.close();
  }
}

class FakeNatPmp {
  udp: Socket = createSocket("udp4");
  mappings = new Map<string, number>(); // "op internalPort" -> lifetime
  offerPortDelta = 0;
  constructor() {
    this.udp.on("message", (q, r) => {
      let reply: Buffer;
      if (q[1] === 0) reply = Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 9]);
      else {
        const internal = q.readUInt16BE(4);
        const life = q.readUInt32BE(8);
        const ext = life === 0 ? 0 : internal + this.offerPortDelta;
        if (life === 0) this.mappings.delete(`${q[1]} ${internal}`);
        else this.mappings.set(`${q[1]} ${internal}`, life);
        reply = Buffer.alloc(16);
        reply[1] = 128 + q[1];
        reply.writeUInt32BE(1, 4);
        reply.writeUInt16BE(internal, 8);
        reply.writeUInt16BE(ext, 10);
        reply.writeUInt32BE(life, 12);
      }
      this.udp.send(reply, r.port, r.address);
    });
  }
  async start() {
    await new Promise<void>((r) => this.udp.bind(0, "127.0.0.1", () => r()));
    return this;
  }
  get endpoint() {
    return { address: "127.0.0.1", port: this.udp.address().port };
  }
  stop() {
    this.udp.close();
  }
}

const NOBODY = { address: "127.0.0.1", port: 9 };
const opts = (u?: FakeUpnp, n?: FakeNatPmp): PortMapperOptions => ({
  ssdp: u?.ssdpEndpoint ?? NOBODY, natPmp: n?.endpoint ?? NOBODY, tryUpnp: !!u, tryNatPmp: !!n, discoveryTimeoutMs: 800, description: "OneLobby test",
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

describe("PortMapper", () => {
  it("UPnP maps TCP and UDP and deletes on close", async () => {
    const gw = await new FakeUpnp().start();
    stops.push(() => gw.stop());
    const m = new PortMapper(47810, opts(gw));
    const r = await m.open();
    expect(r).toMatchObject({ mapped: true, method: "upnp", externalIPv4: "203.0.113.7", localIPv4: "127.0.0.1" });
    expect(gw.mappings.get("TCP 47810")).toBe("127.0.0.1 lease 7200");
    expect(gw.mappings.get("UDP 47810")).toBe("127.0.0.1 lease 7200");
    await m.close();
    expect(gw.mappings.size).toBe(0);
  });

  it("UPnP falls back to a permanent lease on 725", async () => {
    const gw = await new FakeUpnp().start();
    gw.addError = 725;
    stops.push(() => gw.stop());
    const m = new PortMapper(47810, opts(gw));
    expect((await m.open()).mapped).toBe(true);
    expect(gw.mappings.get("UDP 47810")).toBe("127.0.0.1 lease 0");
    await m.close();
  });

  it("UPnP conflict is reported, not thrown", async () => {
    const gw = await new FakeUpnp().start();
    gw.addError = 718;
    stops.push(() => gw.stop());
    const r = await new PortMapper(47810, opts(gw)).open();
    expect(r.mapped).toBe(false);
    expect(r.detail).toContain("718");
    expect(r.externalIPv4).toBe("203.0.113.7");
  });

  it("NAT-PMP maps both and reports the external address", async () => {
    const gw = await new FakeNatPmp().start();
    stops.push(() => gw.stop());
    const m = new PortMapper(47810, opts(undefined, gw));
    const r = await m.open();
    expect(r).toMatchObject({ mapped: true, method: "natpmp", externalIPv4: "198.51.100.9" });
    expect(gw.mappings.get("1 47810")).toBe(7200);
    expect(gw.mappings.get("2 47810")).toBe(7200);
    await m.close();
    await new Promise((r2) => setTimeout(r2, 100));
    expect(gw.mappings.size).toBe(0);
  });

  it("NAT-PMP with a different external port is a failure (and undone)", async () => {
    const gw = await new FakeNatPmp().start();
    gw.offerPortDelta = 1;
    stops.push(() => gw.stop());
    const r = await new PortMapper(47810, opts(undefined, gw)).open();
    expect(r.mapped).toBe(false);
    expect(r.detail).toContain("47811");
    expect(gw.mappings.size).toBe(0);
  });

  it("no gateway gives an unmapped result quickly", async () => {
    const t0 = Date.now();
    const r = await new PortMapper(47810, { ssdp: NOBODY, natPmp: NOBODY, discoveryTimeoutMs: 300 }).open();
    expect(r).toMatchObject({ mapped: false, method: "none" });
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  it.each([
    ["203.0.113.7", true], ["8.8.8.8", true], ["192.168.1.1", false], ["10.0.0.1", false], ["172.20.0.1", false], ["100.64.0.1", false],
    ["100.127.255.255", false], ["100.128.0.1", true], ["127.0.0.1", false], ["169.254.1.1", false], ["0.0.0.0", false], [null, false],
  ])("public rule %s", (ip, expected) => expect(isPublicIPv4(ip)).toBe(expected));

  it.runIf(process.env.ONELOBBY_LIVE_UPNP === "1")("live router", async () => {
    const m = new PortMapper(47819, { description: "OneLobby live test" });
    const r = await m.open();
    console.log("LIVE", r);
    await m.close();
    expect(r.mapped).toBe(true);
  });
});
