import type { SocketLike } from "../transport.js";
import type { SignalingHub, Session } from "./hub.js";

/**
 * A direct host's own signaling socket (C#'s `HubSignalingSocket`): sends go straight into the hub; the hub's
 * replies are delivered on a microtask, so callbacks never run inside the hub. No Node APIs, so a browser tab can
 * use it too (`kit.hostNostr`).
 */
export class LocalHubSocket implements SocketLike {
  /** Address the hub sees for the host itself (rate limits and kicks are per address). */
  static readonly ADDRESS = "local";
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  private session: Session | null;

  constructor(private readonly hub: SignalingHub) {
    this.session = hub.connect(LocalHubSocket.ADDRESS, (text) => queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data: text })), () =>
      this.finish(),
    );
    queueMicrotask(() => {
      if (!this.session) {
        this.finish();
        return;
      }
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    if (this.readyState === 1 && this.session) this.hub.receive(this.session, data);
  }

  close(): void {
    const s = this.session;
    const wasOpen = this.readyState === 1;
    this.finish();
    if (wasOpen && s) this.hub.disconnect(s);
  }

  private finish(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.());
  }
}
