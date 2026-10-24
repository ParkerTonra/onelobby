/** Time source. Lockstep timing never uses requestAnimationFrame (DESIGN s.4). */
export interface Clock {
  now(): number;
  /** Repeating timer; returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void;
  setTimeout(fn: () => void, ms: number): () => void;
}

/**
 * Interval driven from a dedicated Worker when available (hidden tabs clamp main-thread timers to 1 Hz),
 * main-thread setInterval otherwise.
 */
function workerInterval(fn: () => void, ms: number): (() => void) | null {
  if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) {
    return null;
  }
  try {
    const src = `let h=0;onmessage=e=>{if(e.data&&e.data.start){h=setInterval(()=>postMessage(0),e.data.ms)}else{clearInterval(h);close()}}`;
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = () => fn();
    w.postMessage({ start: true, ms });
    return () => {
      w.postMessage({ stop: true });
      w.terminate();
    };
  } catch {
    return null;
  }
}

export const systemClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  setInterval(fn, ms) {
    const w = workerInterval(fn, ms);
    if (w) return w;
    const h = setInterval(fn, ms);
    return () => clearInterval(h);
  },
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};
