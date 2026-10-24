using System;
using System.Runtime.InteropServices;
using System.Text;

namespace OneLobby.DataChannel
{
    /// <summary>
    /// IL2CPP needs this on every static method handed to native code as a callback; it matches the attribute by name,
    /// so this local copy works without referencing UnityEngine (Mono and CoreCLR ignore it).
    /// </summary>
    [AttributeUsage(AttributeTargets.Method)]
    internal sealed class MonoPInvokeCallbackAttribute : Attribute
    {
        public MonoPInvokeCallbackAttribute(Type type) { Type = type; }
        public Type Type { get; }
    }

    /// <summary>P/Invoke surface over libdatachannel's C API (<c>include/rtc/rtc.h</c>, pinned in native/versions.env).</summary>
    internal static unsafe class Rtc
    {
        /// <summary>datachannel.dll / libdatachannel.so / libdatachannel.dylib. iOS links it statically as "__Internal" (not wired yet).</summary>
        public const string Lib = "datachannel";

        public const int ErrSuccess = 0;

        public enum State { New = 0, Connecting = 1, Connected = 2, Disconnected = 3, Failed = 4, Closed = 5 }
        public enum LogLevel { None = 0, Fatal = 1, Error = 2, Warning = 3, Info = 4, Debug = 5, Verbose = 6 }

        [StructLayout(LayoutKind.Sequential)]
        public struct Configuration
        {
            public IntPtr IceServers;      // const char **
            public int IceServersCount;
            public IntPtr ProxyServer;     // const char *
            public IntPtr BindAddress;     // const char *
            public int CertificateType;    // rtcCertificateType
            public int IceTransportPolicy; // 0 all, 1 relay
            public byte EnableIceTcp;      // C bool
            public byte EnableIceUdpMux;
            public byte DisableAutoNegotiation;
            public byte ForceMediaTransport;
            public ushort PortRangeBegin;
            public ushort PortRangeEnd;
            public int Mtu;
            public int MaxMessageSize;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Reliability
        {
            public byte Unordered;
            public byte Unreliable;
            public uint MaxPacketLifeTime;
            public uint MaxRetransmits;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct DataChannelInit
        {
            public Reliability Reliability;
            public IntPtr Protocol;     // const char *
            public byte Negotiated;
            public byte ManualStream;
            public ushort Stream;
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void LogCallback(LogLevel level, IntPtr message);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void DescriptionCallback(int pc, IntPtr sdp, IntPtr type, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void CandidateCallback(int pc, IntPtr cand, IntPtr mid, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void StateCallback(int pc, State state, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void OpenCallback(int id, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void ClosedCallback(int id, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void ErrorCallback(int id, IntPtr error, IntPtr ptr);
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate void MessageCallback(int id, IntPtr message, int size, IntPtr ptr);

        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void rtcInitLogger(LogLevel level, LogCallback? cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern void rtcSetUserPointer(int id, IntPtr ptr);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcCreatePeerConnection(ref Configuration config);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcClosePeerConnection(int pc);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcDeletePeerConnection(int pc);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetLocalDescriptionCallback(int pc, DescriptionCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetLocalCandidateCallback(int pc, CandidateCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetStateChangeCallback(int pc, StateCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetLocalDescription(int pc, byte* type);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetRemoteDescription(int pc, byte* sdp, byte* type);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcAddRemoteCandidate(int pc, byte* cand, byte* mid);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcGetSelectedCandidatePair(int pc, byte* local, int localSize, byte* remote, int remoteSize);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcCreateDataChannelEx(int pc, byte* label, ref DataChannelInit init);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcDeleteDataChannel(int dc);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetOpenCallback(int id, OpenCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetClosedCallback(int id, ClosedCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetErrorCallback(int id, ErrorCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSetMessageCallback(int id, MessageCallback cb);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcSendMessage(int id, byte* data, int size);
        [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] public static extern int rtcGetBufferedAmount(int id);

        /// <summary>Null-terminated UTF-8 (manual marshalling: works the same on CoreCLR, Mono and IL2CPP).</summary>
        public static byte[] Utf8z(string? s)
        {
            if (s == null) return Array.Empty<byte>();
            var n = Encoding.UTF8.GetByteCount(s);
            var b = new byte[n + 1];
            Encoding.UTF8.GetBytes(s, 0, s.Length, b, 0);
            return b;
        }

        public static string? FromUtf8z(IntPtr p)
        {
            if (p == IntPtr.Zero) return null;
            var bp = (byte*)p;
            var n = 0;
            while (bp[n] != 0) n++;
            return Encoding.UTF8.GetString(bp, n);
        }
    }
}
