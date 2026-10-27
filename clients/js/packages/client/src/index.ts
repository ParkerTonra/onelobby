/**
 * Public API of `onelobby`: create a `OneLobby`, `host()` / `join(code)` / `list()` lobbies, then use the
 * `Lobby`'s lockstep, raw messages, chat and voice. Lower-level pieces (codec, chunking, migration, jitter buffer,
 * WebRTC/signaling classes, clocks, the gridpaint demo game) live in `onelobby/internals`.
 */
export { OneLobby, LIB_NAME, LIB_VERSION } from "./onelobby.js";
export type { OneLobbyOptions, FromConfigOverrides, HostOptions, ListOptions, OneLobbyEvents, JoinDirectOptions } from "./onelobby.js";
export { DEFAULT_READY_TIMEOUT_MS } from "./onelobby.js";
export type { AdvancedOptions, SeatStorage } from "./onelobby.js";
// Blueprint v1: onelobby.json (docs/design/blueprint.md). OneLobby.fromConfig(json) builds a kit from it.
export { parseBlueprint, defineBlueprint, BlueprintError } from "./blueprint.js";
export type { Blueprint, BlueprintInput, BlueprintEngine } from "./blueprint.js";
export { Lobby } from "./lobby.js";
export type { LobbyEvents, LobbyConfig, Peer, Phase, RateLimit } from "./lobby.js";
export { MIN_PEER_TIMEOUT_MS } from "./lobby.js";
// WebSocket-shaped sockets over a lobby: lobby.asWebSocket() (joiner), lobby.onConnection(conn => ...) (host).
export { closeCodeFor } from "./socket.js";
export type { LobbySocket, LobbySocketOptions } from "./socket.js";
export { Lockstep } from "./lockstep.js";
export type { Frame, DesyncInfo, LockstepEvents } from "./lockstep.js";
export { Chat, CHAT_MAX_BYTES } from "./chat.js";
export { Pause } from "./pause.js";
export type { PauseState, PauseEvents, PauseMode, PauseRefusal } from "./pause.js";
export type { ChatMessage, ChatEvents } from "./chat.js";
export { Voice } from "./voice.js";
export type { VoiceEvents, VoiceDeps } from "./voice.js";
export type { VoiceMode } from "./voice-core.js";
export type { VoiceCodec, VoiceEncoderHandle, VoiceDecoderHandle, FrameSource, AudioSink, VoiceError } from "./voice-types.js";
export { webCodecsOpusAvailable } from "./voice-browser.js";
export { normalizeCode, formatCode } from "./crockford.js";
// Direct IP (docs/design/direct-ip.md): kit.joinDirect(code); the code is the host's address in disguise. Hosting is in
// onelobby/direct (Node). webRtcLinkFactoryFor gives Node joiners a WebRTC stack (node-datachannel/polyfill).
export { decodeJoinCode, looksLikeJoinCode } from "./joincode.js";
export type { DecodedJoinCode, JoinCodeError } from "./joincode.js";
export { webRtcLinkFactoryFor } from "./webrtc.js";
export { OneLobbyError } from "./signaling.js";
export type { LobbySummary, LobbyState, PeerInfo } from "./signaling.js";
// Types for the seams in OneLobbyOptions (ChannelName also tags raw messages).
export type { PeerLink, LinkFactory, SocketFactory, SocketLike, IceServer, ChannelName } from "./transport.js";
export type { Clock } from "./clock.js";
export { describeError, shareUrl, codeFromUrl, directJoinInfo, ErrorCodes } from "./friendly.js";
export type { FriendlyError, ErrorCode, JoinInfo } from "./friendly.js";
// Pre-rename names, kept for one version so existing games keep working.
export { Keepalive, KeepaliveError } from "./deprecated.js";
export type { KeepaliveOptions, KeepaliveEvents } from "./deprecated.js";
// Nostr signaling for direct hosts (spec/nostr-signaling.md): relay probe for picking hosting.nostrRelays.
export { checkNostrRelays, DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_STUN } from "./nostr/relays.js";
export type { RelayCheck, RelayConnect } from "./nostr/relays.js";
export { encodeRoomCode } from "./joincode.js";
// Browser host (no Node process, no port): kit.hostNostr(options).
export type { BrowserHostOptions, VisibilityDoc } from "./direct/browser-host.js";
