/**
 * Every player-facing string of `<one-lobby>` in one table. The shared part has the same keys and the same English as the
 * Godot menu's `menu_text.gd` (a test reads that file and fails when a key or a word differs); the web-only part below it
 * holds what the Godot menu has no key for. Reword or translate by passing a table of your own keys to `override()`, or set
 * the `texts` property of the element.
 *
 * Sentences about errors, removals and the connection check are not here: they come from `describeError`, `diagnose` and the
 * room layer's removal reasons, so a game that rewords one of those does it at the source. A value may hold `%s` / `%d`
 * placeholders (`%%` is a percent sign); `t()` fills them from its arguments in order.
 *
 * A reworded invite sentence (`invite_sentence`, `invite_sentence_untitled`) must keep the code as its last word or right
 * after its "code" marker: the Join box finds the code there when a player pastes the sentence.
 */

/** The keys shared with the Godot, C# and Unity menus: same names, same English. */
export const MENU_TEXT_SHARED: Readonly<Record<string, string>> = Object.freeze({
  // start
  title: "Multiplayer",
  name_label: "Your name",
  name_placeholder: "Player",
  host: "Host a game",
  join: "Join",
  join_label: "Join with a code, an address or an invite link",
  join_placeholder: "7HQ 4K2",
  password_label: "Password (only if the lobby has one)",
  password_placeholder: "Password",
  browse: "Browse games",
  settings: "Settings",
  start_invited: "You're invited! Check your name, then press Join.",
  // connecting
  connecting_host: "Setting up your game...",
  connecting_join: "Joining %s...",
  connecting_join_address: "Connecting to the host...",
  cancel: "Cancel",
  // lobby
  code_caption: "Join code",
  copy_code: "Copy code",
  copy_invite: "Copy invite",
  invite_sentence: "Join my game in %s: code %s",
  invite_sentence_untitled: "Join my game: code %s",
  copied: "Copied!",
  copy_failed: "Couldn't copy, select it by hand",
  players_header: "Players %d/%d",
  players_header_plain: "Players %d",
  mark_host: "Host",
  mark_ready: "Ready",
  mark_spectator: "Watching",
  mark_reconnecting: "Reconnecting",
  ping: "%d ms",
  you: "(you)",
  ready: "Ready",
  not_ready: "Not ready",
  start: "Start game",
  start_wait: "Waiting for the host to start the game.",
  countdown: "Starting in %d...",
  cancel_countdown: "Cancel start",
  leave: "Leave",
  kick: "Kick",
  ban: "Ban",
  unban: "Unban",
  reason_placeholder: "Reason for a kick or ban (optional)",
  bans_header: "Banned players",
  ban_row: "%s",
  ban_row_reason: "%s: %s",
  ban_unknown: "A banned player",
  lobby_settings: "Lobby settings",
  setting_auto_start: "Start by itself",
  auto_start_off: "No",
  auto_start_all_ready: "When everyone is ready",
  auto_start_players: "When enough players are in",
  setting_min_players: "Players needed to start",
  setting_countdown: "Countdown (seconds)",
  setting_late_join: "Players may join after the start",
  requests_header: "Asking to join",
  let_in: "Let in",
  refuse: "Refuse",
  chat_placeholder: "Say something",
  chat_send: "Send",
  chat_line: "%s: %s",
  plain_list_note: "The host's game is older and has no ready or start buttons. The host starts the game.",
  host_start_plain: "Start game",
  // error / removed
  error_title: "Couldn't connect",
  removed_title: "You were removed",
  banned_title: "You were banned",
  ended_title: "The game ended",
  error_code: "Code: %s",
  copy_logs: "Copy logs",
  save_logs: "Save logs",
  logs_copied: "Logs copied (addresses are hidden).",
  logs_saved: "Logs saved to %s (addresses are hidden).",
  logs_not_saved: "Couldn't save the logs.",
  back: "Back",
  bad_code: "That doesn't look like a lobby code.",
  bad_code_hint: "Paste the code the host shows, an address like 192.168.1.20:47810, or an invite link.",
  host_left: "The host left, so the game ended.",
  host_left_hint: "Go back and host or join another game.",
  // settings
  settings_title: "Settings",
  relay_label: "Relay line (only needed on strict networks)",
  relay_placeholder: "Paste a relay line",
  relay_none: "No relay is set.",
  relay_set: "Relay in use: %s",
  relay_invalid: "The saved relay line is not valid, so it is not used.",
  relay_bad_input: "That relay line is not valid, so it was not saved.",
  relay_saved: "Relay saved.",
  relay_cleared: "Relay cleared.",
  relay_save: "Save relay",
  relay_clear: "Clear relay",
  server_label: "Lobby server",
  server_placeholder: "wss://lobby.example.org/ws",
  server_save: "Save server",
  server_saved: "Lobby server saved.",
  server_bad_input: "That doesn't look like a lobby server address.",
  check: "Check my connection",
  check_running: "Checking...",
  check_udp: "UDP: %s",
  check_nat: "Network type: %s",
  check_relay: "Relay: %s",
  udp_ok: "gets out",
  udp_blocked: "blocked",
  udp_unknown: "unknown",
  nat_open: "open",
  nat_cone: "normal (cone)",
  nat_symmetric: "strict (symmetric)",
  nat_unknown: "unknown",
  nat_blocked: "unknown",
  relay_ok: "login accepted",
  relay_refused: "login refused",
  relay_unreachable: "did not answer",
  relay_unknown: "unknown",
  relay_none_fact: "none set",
  // browse
  browse_title: "Games to join",
  browse_loading: "Looking for games...",
  browse_empty: "No games found right now.",
  browse_row: "%s (%s) %d/%d",
  browse_refresh: "Refresh",
  browse_join: "Join",
});

/** Keys only the web element has (the Godot menu draws these as part of its scenes or has no such control). */
export const MENU_TEXT_WEB: Readonly<Record<string, string>> = Object.freeze({
  // status line (the sentences `<one-lobby>` has always shown)
  status_idle: "Host a game, or type a code to join one.",
  status_joining: "Joining…",
  status_resuming: "Getting your seat back…",
  status_creating: "Creating a game…",
  status_error: "Something went wrong.",
  status_waiting: "Waiting for players… Share the code with your friends.",
  status_players_here: "%d players here. Press Start when everyone's in.",
  status_linking: "Connecting to %s…",
  status_connected: "Connected! Waiting for %s to start.",
  status_playing: "Game on!",
  status_host_fallback: "the host",
  // start
  start_invited_noname: "You're invited! Type your name, then press Join.",
  join_or: "or join a friend",
  // lobby
  copy_link: "Copy invite link",
  link_copied: "Link copied!",
  start_need_players: "Wait for at least one more player",
  back_to_lobby: "Back to lobby",
  chat_label: "Chat",
  chat_off_note: "Chat is turned off in this game.",
  host_name: "Host",
  // error
  retry: "Try again",
  error_code_label: "Code: %s",
  logs_downloaded: "Logs downloaded (addresses are hidden).",
  no_server_status: "This page is missing its lobby server address.",
  no_server_hint: "Put your lobby server address in server=\"…\" on the <one-lobby> tag (it looks like https://your-name.onrender.com). The guide shows how to get one.",
  // settings
  server_page_note: "This page sets its own lobby server, so the one you save here is used only on pages that set none.",
  relay_hidden_note: "The relay line is never shown again after you save it.",
});

/** The table in use by default: shared plus web-only keys. */
export const MENU_TEXT: Readonly<Record<string, string>> = Object.freeze({ ...MENU_TEXT_SHARED, ...MENU_TEXT_WEB });

/** `%s` / `%d` placeholders filled from `args` in order, `%%` as a percent sign. */
export function fillText(format: string, args: readonly unknown[]): string {
  let next = 0;
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== "%" || i + 1 >= format.length) {
      out += c;
      continue;
    }
    const k = format[i + 1];
    if (k === "%") {
      out += "%";
      i++;
    } else if (k === "s" || k === "d") {
      out += next < args.length ? String(args[next]) : "";
      next++;
      i++;
    } else out += c;
  }
  return out;
}

/** One table with an override: the controller owns one, so two elements on a page can be worded differently. */
export class MenuTexts {
  private extra: Record<string, string> = {};

  /** The string for `key` (the key itself when there is none, so a typo shows up on screen), placeholders filled from `args`. */
  t(key: string, ...args: unknown[]): string {
    const s = Object.prototype.hasOwnProperty.call(this.extra, key) ? this.extra[key] : MENU_TEXT[key] ?? key;
    return args.length === 0 ? s : fillText(s, args);
  }

  /** True when the default table has this key. */
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(MENU_TEXT, key);
  }

  /** Replaces some strings (keys as in `MENU_TEXT`); `override(null)` puts the defaults back. Non-string values are ignored. */
  override(values: Record<string, unknown> | null | undefined): void {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(values ?? {})) if (typeof v === "string") next[k] = v;
    this.extra = next;
  }

  /** A copy of what was overridden. */
  get overrides(): Record<string, string> {
    return { ...this.extra };
  }
}
