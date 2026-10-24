/**
 * Host migration rule (DESIGN s.9). Pure functions so the rule is testable without any network.
 *
 *  - New host = lowest peerId still connected.
 *  - Two claims: higher epoch wins; equal epoch -> lower peerId wins; the loser demotes itself.
 */

export interface Claim {
  epoch: number;
  hostId: number;
}

/** Lowest peerId among `connected`, skipping the failed host. Null when nobody is left. */
export function pickNewHost(connected: Iterable<number>, failedHost: number): number | null {
  let best: number | null = null;
  for (const id of connected) {
    if (id === failedHost) continue;
    if (best === null || id < best) best = id;
  }
  return best;
}

/** True when claim `a` beats claim `b`. */
export function claimWins(a: Claim, b: Claim): boolean {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch;
  return a.hostId < b.hostId;
}

/** Epochs are u16 on the wire; compare with wraparound so a long-lived lobby never sticks. */
export function epochAfter(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

export function claimWinsWrapped(a: Claim, b: Claim): boolean {
  if (a.epoch !== b.epoch) return epochAfter(a.epoch, b.epoch);
  return a.hostId < b.hostId;
}
