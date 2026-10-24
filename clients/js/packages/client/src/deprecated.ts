/**
 * Names from before the Keepalive -> OneLobby rename. They are the same classes and types, so old code keeps
 * working unchanged; they will be removed in the next minor release.
 */
import { OneLobby, type OneLobbyEvents, type OneLobbyOptions } from "./onelobby.js";
import { OneLobbyError } from "./signaling.js";

/** @deprecated renamed to `OneLobby`; this alias goes away in the next minor release. */
export const Keepalive = OneLobby;
/** @deprecated renamed to `OneLobby`. */
export type Keepalive = OneLobby;
/** @deprecated renamed to `OneLobbyError`; this alias goes away in the next minor release. */
export const KeepaliveError = OneLobbyError;
/** @deprecated renamed to `OneLobbyError`. */
export type KeepaliveError = OneLobbyError;
/** @deprecated renamed to `OneLobbyOptions`. */
export type KeepaliveOptions = OneLobbyOptions;
/** @deprecated renamed to `OneLobbyEvents`. */
export type KeepaliveEvents = OneLobbyEvents;
