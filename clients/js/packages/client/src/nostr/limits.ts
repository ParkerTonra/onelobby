/**
 * Every Nostr limit and timer shared with the C# client. Pinned by `spec/vectors/nostr-limits.json` (test/nostr.test.ts);
 * C# mirror: OneLobby.Direct/Nostr/NostrLimits.cs. Change a number in all three.
 */

// Reliable link (spec s.4)
export const BATCH_MS = 30;
export const RESEND_MS = 3000;
export const MAX_RESENDS = 5;
export const BEAT_MS = 10_000;
export const SILENCE_MS = 30_000;
export const MAX_HELD = 64;
/** Outbound: queued texts plus unacknowledged frames, at most this many frames and bytes; excess texts are dropped. */
export const MAX_OUT_FRAMES = 128;
export const MAX_OUT_BYTES = 256 * 1024;
export const MAX_FRAME_BYTES = 30_000; // under the 32 KiB content limit, room for the JSON envelope
export const TICK_MS = 250;

// Host bridge: new joiner token bucket (spec s.4)
export const NEW_SESSION_BURST = 16;
export const MAX_SESSION_BURST = 64;
export const NEW_SESSION_REFILL_MS = 1_000;
export const WAITING_MAX = 64;
export const WAITING_STALE_MS = 5_000;

// Joiner socket (spec s.4)
export const OPEN_EVERY_MS = 2000;
export const GIVE_UP_MS = 15_000;

// Relay waits (spec s.6)
/** `hostDirect`: how long to wait for a first relay before hosting by IP alone. */
export const HOST_FIRST_RELAY_MS = 10_000;
/** `hostNostr` (no IP fallback): how long to wait for a first relay before `direct_unreachable`. */
export const HOST_NOSTR_FIRST_RELAY_MS = 10_000;
/** A joiner: how long to wait for a first relay before `connect_failed`. */
export const JOINER_FIRST_RELAY_MS = 10_000;
/** After the first relay: at most this long for the rest of the list. */
export const RELAY_REST_WAIT_MS = 1500;
export const RELAY_REST_POLL_MS = 50;
