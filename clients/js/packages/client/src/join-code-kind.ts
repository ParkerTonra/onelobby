/**
 * What a direct host's join code is. One tuple for the whole client; C# has the `JoinCodeKind` enum and
 * `DirectLobby.KindName`, and `spec/vectors/join-code-kinds.json` pins that both spell each kind alike.
 */
export const JOIN_CODE_KINDS = ["nostr", "internet", "same_network", "none"] as const;
export type JoinCodeKind = (typeof JOIN_CODE_KINDS)[number];
/** An IP code (the host's address): everything but `nostr`. */
export type IpCodeKind = Exclude<JoinCodeKind, "nostr">;

/** The kind as the startup line spells it (C# `JoinCodeKind.ToString()`): `same_network` -> `SameNetwork`. */
export function joinCodeKindName(k: JoinCodeKind): string {
  return k === "internet" ? "Internet" : k === "same_network" ? "SameNetwork" : k === "nostr" ? "Nostr" : "None";
}
