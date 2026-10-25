# Recipe: voice and text chat

Both are optional channels on an existing lobby, never seen by the server, never part of a lockstep frame or hash.
Join a lobby first (`js-web.md`, `dotnet-generic.md`, `godot-csharp.md`).

## Text chat

Limits: 256 UTF-8 bytes per message, 5 messages per 5 s per peer. The host stamps `id` and `ts`, strips control characters,
and sends `chat_history` (last 100 lines) to late joiners. Join/leave notices are yours to generate from roster events.

```ts compile file=chat.ts
import type { Lobby } from "onelobby";

export function wireChat(lobby: Lobby, log: HTMLElement, input: HTMLInputElement): void {
  const add = (text: string) => { const p = document.createElement("p"); p.textContent = text; log.append(p); };

  for (const line of lobby.chat.history) add(`${nameOf(lobby, line.peerId)}: ${line.text}`);
  lobby.chat.on("message", ({ peerId, text }) => add(`${nameOf(lobby, peerId)}: ${text}`));
  lobby.chat.on("rejected", (_id, reason) => add(`(message not sent: ${reason})`));   // rate | length | muted_by_host
  lobby.on("peerJoined", (p) => add(`${p.name} joined`));
  lobby.on("peerLeft", (p) => add(`${p.name} left`));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) { lobby.chat.send(input.value); input.value = ""; }
  });
}

function nameOf(lobby: Lobby, peerId: number): string {
  return lobby.peers.find((p) => p.peerId === peerId)?.name ?? `#${peerId}`;
}
```

```csharp compile file=Chat.cs
using System;
using System.Linq;
using OneLobby;

public static class ChatWiring
{
    public static void Wire(Lobby lobby, Action<string> addLine)
    {
        string NameOf(int id) => lobby.Peers.FirstOrDefault(p => p.PeerId == id)?.Name ?? "#" + id;
        foreach (var l in lobby.Chat.History) addLine($"{NameOf(l.PeerId)}: {l.Text}");
        lobby.Chat.Received += l => addLine($"{NameOf(l.PeerId)}: {l.Text}");
        lobby.Chat.Rejected += (id, reason) => addLine($"(message not sent: {reason})");
        lobby.Chat.Filter = text => text;                          // your profanity hook, applied on receive
    }
    public static void Say(Lobby lobby, string text) => lobby.Chat.Send(text);   // call from your input handler
}
```

## Voice

Opus over a data channel, star-routed through the host. It is off until the player opts in, so show a button.

```ts compile file=voice.ts
import type { Lobby } from "onelobby";

export function wireVoice(lobby: Lobby, talkButton: HTMLElement, meter: HTMLElement): void {
  lobby.voice.mode = "pushToTalk";                         // or "voiceActivity"
  lobby.voice.enabled = true;                              // call from a click: browsers need a user gesture for the mic
  talkButton.onpointerdown = () => lobby.voice.pushToTalk(true);
  talkButton.onpointerup = () => lobby.voice.pushToTalk(false);
  lobby.voice.on("speaking", (peerId: number, talking: boolean) => {
    meter.textContent = talking ? `peer ${peerId} is talking` : "";
  });
  lobby.voice.on("error", (e: unknown) => { meter.textContent = `Voice off: ${String(e)}`; });
}

export function muteForMe(lobby: Lobby, peerId: number): void {
  lobby.voice.setMuted(peerId, true);                      // also hides that peer's chat locally
  lobby.voice.setVolume(peerId, 1.0);                      // 0..2
}
```

```csharp compile file=Voice.cs
using System;
using OneLobby;

public static class VoiceWiring
{
    public static void Wire(Lobby lobby, Action<string> show)
    {
        lobby.Voice.Mode = VoiceMode.PushToTalk;
        lobby.Voice.Enabled = true;                            // after the player opts in
        lobby.Voice.ReleaseHangMs = 150;                       // keep sending briefly after the key comes up
        lobby.Voice.Speaking += (peerId, talking) => show(talking ? $"peer {peerId} is talking" : "");   // false after 300 ms quiet
        lobby.Voice.VoiceError += msg => show("Voice off: " + msg);
    }
    public static void Talk(Lobby lobby, bool down) => lobby.Voice.PushToTalk(down);   // bind to a key
    public static float Meter(Lobby lobby) => lobby.Voice.InputLevel;                   // 0..1, also while not talking
    public static bool Me(Lobby lobby) => lobby.Voice.IsTransmitting;                   // my own speaker icon
    public static void MuteEveryone(Lobby lobby, bool on) => lobby.Voice.MuteAll(on);  // includes later joiners
    public static bool IsMuted(Lobby lobby, int peerId) => lobby.Voice.IsMuted(peerId);
}
```

C# voice options: `ReleaseHangMs` (push-to-talk tail, default 0), `SpeakingHoldMs` (how long a speaker must be quiet
before `Speaking` goes false, default 300), `MuteAll(bool)` / `AllMuted` / `IsMuted(peer)`, `IsTransmitting`.
`InputLevel` updates on every captured frame while `Enabled`, so it doubles as a mic-test meter.

In Unity, `UnityVoiceAudio.Attach(transform, lobby.Voice)` supplies the codec and audio. `UnityVoiceAudio.Devices` lists
microphones and setting `Device` switches while capturing. The package's **Mic Check** sample (Package Manager, Samples)
runs the same capture and Opus path with no lobby: a device picker, a level meter and loopback.

In Godot, `OneLobby.Godot` supplies `Voice.Codec` and `Voice.Audio` (mic bus and playback); set project setting
`audio/driver/enable_input` to on and keep an `AudioEffectCapture` bus named as in the demo. The host can silence a chatty
peer for everyone with `Chat.HostMute(peerId, true)` (C#) / `lobby.chat.hostMute(peerId, true)` (JS).

## Done when

- Two clients in one lobby: a line typed in one appears in the other with the sender's name; a third client joining late sees
  the earlier lines (history).
- A 300-byte message is refused with `length`; six quick messages trigger `rate`.
- Holding the talk key in one client makes `speaking(peerId, true)` fire in the other and audio plays; releasing fires
  `false`. Chat and voice work while the game is `InGame`.
- Real hardware (Unity): the Mic Check sample's meter moves with your voice on each listed microphone, switching
  devices takes effect at once, and loopback sounds clean through headphones.
