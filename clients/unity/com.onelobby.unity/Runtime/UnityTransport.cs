#nullable enable
using System;
using OneLobby.DataChannel;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// <see cref="ITransport"/> for Unity: the engine-agnostic <see cref="DataChannelTransport"/> (libdatachannel WebRTC
    /// data channels + ClientWebSocket signaling, from OneLobby.DataChannel.dll and the native plugin in
    /// Runtime/Plugins) with its native log forwarded to the Unity console. Nothing Unity-specific happens on the wire,
    /// so a Unity peer and a Godot, browser or plain .NET peer meet in the same lobby.
    /// <para>
    /// Threading: libdatachannel callbacks and the WebSocket only fill queues; everything the core sees happens in
    /// <see cref="Poll"/> (called by <c>LobbyClient.Pump</c> / <c>Lobby.Pump</c>), so pump from the main thread once per
    /// frame (<see cref="OneLobbyRunner"/> does).
    /// </para>
    /// </summary>
    public sealed class UnityTransport : ITransport
    {
        private static bool _logHooked;
        private readonly DataChannelTransport _inner = new DataChannelTransport();

        /// <summary>
        /// Forward libdatachannel warnings and errors to <see cref="Debug.LogWarning(object)"/>. Set before the first
        /// UnityTransport is created. Off by default.
        /// </summary>
        public static bool LogNativeWarnings;

        public UnityTransport()
        {
            if (LogNativeWarnings && !_logHooked)
            {
                _logHooked = true;
                DataChannelTransport.NativeLogLevel = 3;
                // raised on a native thread; Debug.Log is thread-safe
                DataChannelTransport.NativeLog += line => Debug.LogWarning(line);
            }
        }

        public long NowMs => _inner.NowMs;
        public ISignalingSocket ConnectSignaling(Uri url) => _inner.ConnectSignaling(url);
        public IPeerLink CreatePeerLink(PeerLinkOptions options) => _inner.CreatePeerLink(options);
        public void Poll() => _inner.Poll();
    }
}
