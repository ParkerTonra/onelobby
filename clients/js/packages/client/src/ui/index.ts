/**
 * `onelobby/ui`: the `<one-lobby>` drop-in element. Loading this module registers the tag.
 */
import { defineLobbyElement } from "./element.js";

export { defineLobbyElement, LOBBY_TAG } from "./element.js";
export type { OneLobbyElement } from "./element.js";
export { LobbyController, SharedState } from "./controller.js";
export type { Player, UiState, ControllerEvents, ControllerOptions, KitLike } from "./controller.js";

defineLobbyElement();
