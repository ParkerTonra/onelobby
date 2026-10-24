/**
 * Public API of `@keepalive/client`: create a `Keepalive`, `host()` / `join(code)` / `list()` lobbies, then use the
 * `Lobby`'s lockstep, raw messages, chat and voice. Lower-level pieces (codec, chunking, migration, jitter buffer,
 * WebRTC/signaling classes, clocks, the gridpaint demo game) live in `@keepalive/client/internals`.
 */
export { Keepalive, LIB_NAME, LIB_VERSION } from "./keepalive.js";
export type { KeepaliveOptions, HostOptions, ListOptions, KeepaliveEvents } from "./keepalive.js";
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
export { KeepaliveError } from "./signaling.js";
export type { LobbySummary, LobbyState, PeerInfo } from "./signaling.js";
// Types for the seams in KeepaliveOptions (ChannelName also tags raw messages).
export type { PeerLink, LinkFactory, SocketFactory, SocketLike, IceServer, ChannelName } from "./transport.js";
export type { Clock } from "./clock.js";
