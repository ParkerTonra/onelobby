/**
 * Binary replication (spec/replication.md): bit-packed, quantised, delta-compressed state sync over a raw-mode lobby.
 * Byte for byte compatible with the C# `OneLobby.Replication`.
 */
export { NetWriter, NetReader, Quantize, NetMath } from "./bits.js";
export {
  ReplicationSession, NetworkClock, ReplicationStats, replicated, DEFAULT_REPLICATION_CONFIG,
  STREAM_GAP_TIMEOUT_MS, MAX_STREAM_BUFFERED, MAX_STREAM_BUFFERED_BYTES, MAX_STREAM_AHEAD,
} from "./session.js";
export type {
  EntityInfo, ReplicatedEntity, StateSchema, InputFrame, ReplicationConfig, StreamGap, ReplicatedEvent, ClientInputStats,
  TrafficRates, ReplicationEvents,
} from "./session.js";
export {
  ReplicationError, describe as describeReplication, encodeSnapshot, decodeSnapshot, peekSnapshot, encodeInput, decodeInput, encodeEvent,
  decodeEvent, encodeStreamEvent, decodeStreamEvent, isReplication, indexOf as indexOfEntity, ByteWriter, MAX_STATE_BYTES,
  toHex, fromHex,
} from "./protocol.js";
export type { Ent, World, ReplicationErrorCode, SnapshotHeader, DecodedInput, InputEntry, Json } from "./protocol.js";
export { Reconciler, PredictionSmoother, HistoryRing } from "./helpers.js";
export { NetPlayers, NET_PLAYER } from "./player.js";
export type {
  PlayerAuthority, PlayerLimits, PlayerBlueprint, NetPlayersOptions, ActionEvent, PlayerStats, NetPlayersEvents,
} from "./player.js";
export {
  PlayerCodec, PLAYER_TYPE_ID, KIND_PLAYER_EVENTS, TELEPORT_MODULO, DEFAULT_PLAYER_WIRE, MOVEMENT_MODES, BUTTONS, ACTION_EVENTS, OMITTABLE,
  OMITTABLE_FIELDS, defaultPlayerState, defaultPlayerInput, positionBits, encodePlayerEvents, decodePlayerEvents, actionByName, actionById,
} from "./player-wire.js";
export type {
  PlayerState, PlayerInput, PlayerSpace, PlayerWireConfig, ActionName, ActionArgs, ActionEventDef, ButtonName, WireEvent,
} from "./player-wire.js";
