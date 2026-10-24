/**
 * Public API of `onelobby`: create a `OneLobby`, `host()` / `join(code)` / `list()` lobbies, then use the
 * `Lobby`'s lockstep, raw messages, chat and voice. Lower-level pieces (codec, chunking, migration, jitter buffer,
 * WebRTC/signaling classes, clocks, the gridpaint demo game) live in `onelobby/internals`.
 */
export { OneLobby, LIB_NAME, LIB_VERSION } from "./onelobby.js";
export type { OneLobbyOptions, HostOptions, ListOptions, OneLobbyEvents, JoinDirectOptions } from "./onelobby.js";
export { DEFAULT_READY_TIMEOUT_MS } from "./onelobby.js";
export type { AdvancedOptions, SeatStorage } from "./onelobby.js";
export { Lobby } from "./lobby.js";
export type { LobbyEvents, LobbyConfig, Peer, Phase } from "./lobby.js";
export { Lockstep } from "./lockstep.js";
export type { Frame, DesyncInfo, LockstepEvents } from "./lockstep.js";
export { Chat, CHAT_MAX_BYTES } from "./chat.js";
export type { ChatMessage, ChatEvents } from "./chat.js";
export { Voice } from "./voice.js";
export type { VoiceEvents, VoiceDeps } from "./voice.js";
export type { VoiceMode } from "./voice-core.js";
export type { VoiceCodec, VoiceEncoderHandle, VoiceDecoderHandle, FrameSource, AudioSink, VoiceError } from "./voice-types.js";
export { webCodecsOpusAvailable } from "./voice-browser.js";
export { normalizeCode, formatCode } from "./crockford.js";
// Direct IP (docs/direct-ip.md): kit.joinDirect(code); the code is the host's address in disguise. Hosting is in
// onelobby/direct (Node). webRtcLinkFactoryFor gives Node joiners a WebRTC stack (node-datachannel/polyfill).
export { decodeJoinCode, looksLikeJoinCode } from "./joincode.js";
export type { DecodedJoinCode, JoinCodeError } from "./joincode.js";
export { webRtcLinkFactoryFor } from "./webrtc.js";
export { OneLobbyError } from "./signaling.js";
export type { LobbySummary, LobbyState, PeerInfo } from "./signaling.js";
// Types for the seams in OneLobbyOptions (ChannelName also tags raw messages).
export type { PeerLink, LinkFactory, SocketFactory, SocketLike, IceServer, ChannelName } from "./transport.js";
export type { Clock } from "./clock.js";
export { describeError, shareUrl, codeFromUrl } from "./friendly.js";
export type { FriendlyError } from "./friendly.js";
// Pre-rename names, kept for one version so existing games (Ant Arena) keep working.
export { Keepalive, KeepaliveError } from "./deprecated.js";
export type { KeepaliveOptions, KeepaliveEvents } from "./deprecated.js";
