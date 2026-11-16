/**
 * `onelobby/ui`: the `<one-lobby>` drop-in element. Loading this module registers the tag.
 */
import { defineLobbyElement } from "./element.js";

export { defineLobbyElement, LOBBY_TAG } from "./element.js";
export type { OneLobbyElement } from "./element.js";
export { LobbyController, SharedState } from "./controller.js";
export { lobbyServerUrl } from "./server-url.js";
export type { Player, UiState, ControllerEvents, ControllerOptions, KitLike } from "./controller.js";
// the drop-in menu: screens, rows, the text table and the Join box parser (docs/recipes/menu.md, "Web")
export type { UiScreen, MenuError, RosterRow, ChatLine, JoinRequest, BanRow, LobbySettingsView } from "./controller.js";
export { CHAT_KEEP } from "./controller.js";
export { MENU_TEXT, MENU_TEXT_SHARED, MENU_TEXT_WEB, MenuTexts } from "./menu-text.js";
export { parseJoin, cleanJoinText } from "./menu-join.js";
export type { MenuJoinKind, MenuJoinParse } from "./menu-join.js";

defineLobbyElement();
