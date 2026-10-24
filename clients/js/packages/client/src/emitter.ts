/** Minimal typed event emitter (zero deps). */
export class Emitter<E extends { [k: string]: unknown[] }> {
  private handlers = new Map<keyof E, Array<(...a: any[]) => void>>();

  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {
    let list = this.handlers.get(event);
    if (!list) this.handlers.set(event, (list = []));
    list.push(fn as (...a: any[]) => void);
    return () => this.off(event, fn);
  }

  off<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {
    const list = this.handlers.get(event);
    if (!list) return;
    const i = list.indexOf(fn as (...a: any[]) => void);
    if (i >= 0) list.splice(i, 1);
  }

  protected emit<K extends keyof E>(event: K, ...args: E[K]): void {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const fn of [...list]) {
      try {
        fn(...args);
      } catch (e) {
        // A throwing listener must never break the protocol state machine.
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }
}
