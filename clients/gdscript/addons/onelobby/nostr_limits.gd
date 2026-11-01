class_name OneLobbyNostrLimits
extends RefCounted
## Every Nostr limit and timer shared with the JS and C# clients. Pinned by spec/vectors/nostr-limits.json
## (tests/nostr_unit.gd compares groups() with that file). Change a number in all three clients.

# Reliable link (spec s.4)
const BATCH_MS := 30
const RESEND_MS := 3000
const MAX_RESENDS := 5
const BEAT_MS := 10000
const SILENCE_MS := 30000
const MAX_HELD := 64
const MAX_OUT_FRAMES := 128
const MAX_OUT_BYTES := 256 * 1024
const MAX_FRAME_BYTES := 30000
const TICK_MS := 250

# Host bridge: new joiner token bucket
const NEW_SESSION_BURST := 16
const MAX_SESSION_BURST := 64
const NEW_SESSION_REFILL_MS := 1000
const WAITING_MAX := 64
const WAITING_STALE_MS := 5000

# Joiner socket
const OPEN_EVERY_MS := 2000
const GIVE_UP_MS := 15000

# Relay waits (spec s.6)
const HOST_FIRST_RELAY_MS := 3000
const HOST_NOSTR_FIRST_RELAY_MS := 10000
const JOINER_FIRST_RELAY_MS := 10000
const RELAY_REST_WAIT_MS := 1500
const RELAY_REST_POLL_MS := 50

# Relay reconnect backoff (spec s.6)
const BACKOFF_START_MS := 1000
const BACKOFF_MAX_MS := 30000

## The same grouping and key names as spec/vectors/nostr-limits.json.
static func groups() -> Dictionary:
	return {
		"link": {"batchMs": BATCH_MS, "resendMs": RESEND_MS, "maxResends": MAX_RESENDS, "beatMs": BEAT_MS, "silenceMs": SILENCE_MS,
			"maxHeld": MAX_HELD, "maxOutFrames": MAX_OUT_FRAMES, "maxOutBytes": MAX_OUT_BYTES, "maxFrameBytes": MAX_FRAME_BYTES, "tickMs": TICK_MS},
		"host": {"newSessionBurst": NEW_SESSION_BURST, "maxSessionBurst": MAX_SESSION_BURST, "newSessionRefillMs": NEW_SESSION_REFILL_MS,
			"waitingMax": WAITING_MAX, "waitingStaleMs": WAITING_STALE_MS},
		"socket": {"openEveryMs": OPEN_EVERY_MS, "giveUpMs": GIVE_UP_MS},
		"relays": {"hostFirstRelayMs": HOST_FIRST_RELAY_MS, "hostNostrFirstRelayMs": HOST_NOSTR_FIRST_RELAY_MS,
			"joinerFirstRelayMs": JOINER_FIRST_RELAY_MS, "restWaitMs": RELAY_REST_WAIT_MS, "restPollMs": RELAY_REST_POLL_MS},
	}
