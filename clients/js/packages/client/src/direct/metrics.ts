/** Tiny Prometheus text exposition: labelled counters plus gauges read at scrape time (C#'s `Metrics` in `server/OneLobby.Hub`). */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, { help: string; read: () => number }>();
  private readonly help = new Map<string, string>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  gauge(name: string, help: string, read: () => number): void {
    this.gauges.set(name, { help, read });
  }

  /** Counter name plus optional single label, e.g. inc("onelobby_path_total", "path", "relayed"). */
  inc(name: string, label?: string, value?: string, by = 1): void {
    const key = keyOf(name, label, value);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  get(name: string, label?: string, value?: string): number {
    return this.counters.get(keyOf(name, label, value)) ?? 0;
  }

  render(): string {
    let out = "";
    for (const name of [...this.gauges.keys()].sort(ordinal)) {
      const g = this.gauges.get(name)!;
      out += `# HELP ${name} ${g.help}\n# TYPE ${name} gauge\n${name} ${g.read()}\n`;
    }
    let lastBase: string | null = null;
    for (const key of [...this.counters.keys()].sort(ordinal)) {
      const br = key.indexOf("{");
      const base = br < 0 ? key : key.slice(0, br);
      if (base !== lastBase) {
        const h = this.help.get(base);
        if (h !== undefined) out += `# HELP ${base} ${h}\n`;
        out += `# TYPE ${base} counter\n`;
        lastBase = base;
      }
      out += `${key} ${this.counters.get(key)}\n`;
    }
    return out;
  }
}

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const escape = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const keyOf = (name: string, label?: string, value?: string): string => (label === undefined ? name : `${name}{${label}="${escape(value ?? "")}"}`);
