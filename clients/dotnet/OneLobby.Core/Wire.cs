using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace OneLobby
{
    /// <summary>Binary data-channel framing (DESIGN s.8): little-endian, 3-byte header type:u8 route:u16.</summary>
    public static class Wire
    {
        public const int ProtoVersion = 1;
        public const int MaxFrame = 16 * 1024;
        public const int ChunkPayload = 15 * 1024;
        /// <summary>Cap on one reassembled chunk set (spec/binary.md "Snapshot and chunks").</summary>
        public const int MaxReassembled = 64 * 1024 * 1024;

        public const byte Hi = 0x01, WelcomeDc = 0x02, Cmd = 0x10, FrameMsg = 0x11, Hash = 0x12, Desync = 0x13,
            SnapshotReq = 0x14, Snapshot = 0x15, Chunk = 0x16, Raw = 0x20, Ping = 0x30, Pong = 0x31,
            HostClaim = 0x40, Voice = 0x50, Chat = 0x60, ChatHistory = 0x61, ChatReject = 0x62,
            PauseRequest = 0x70, PauseState = 0x71, PauseRefuse = 0x72;

        public const byte ModeLockstep = 1, ModeRaw = 2;
        public const byte SnapshotDeflate = 1;
        public const byte ChatRate = 1, ChatLength = 2, ChatMuted = 3;
        public const byte PauseRefusedNotInGame = 1, PauseRefusedRate = 2, PauseRefusedNotAllowed = 3;
        public const byte PauseFlagPauserLeft = 1;

        public sealed class Writer
        {
            private readonly MemoryStream _ms = new();
            public Writer(byte type, int route) { U8(type); U16(route); }
            public Writer U8(int v) { _ms.WriteByte((byte)v); return this; }
            public Writer U16(int v) { Span<byte> b = stackalloc byte[2]; BinaryPrimitives.WriteUInt16LittleEndian(b, (ushort)v); _ms.Write(b); return this; }
            public Writer U32(uint v) { Span<byte> b = stackalloc byte[4]; BinaryPrimitives.WriteUInt32LittleEndian(b, v); _ms.Write(b); return this; }
            public Writer I64(long v) { Span<byte> b = stackalloc byte[8]; BinaryPrimitives.WriteInt64LittleEndian(b, v); _ms.Write(b); return this; }
            public Writer U64(ulong v) { Span<byte> b = stackalloc byte[8]; BinaryPrimitives.WriteUInt64LittleEndian(b, v); _ms.Write(b); return this; }
            public Writer Bytes(ReadOnlySpan<byte> v) { _ms.Write(v); return this; }
            public byte[] ToArray() => _ms.ToArray();
        }

        public ref struct Reader
        {
            private readonly ReadOnlySpan<byte> _s;
            private int _p;
            public Reader(ReadOnlySpan<byte> s) { _s = s; _p = 0; }
            public int Remaining => _s.Length - _p;
            private ReadOnlySpan<byte> Take(int n)
            {
                if (n < 0 || _p + n > _s.Length) throw new FormatException("truncated frame");
                var r = _s.Slice(_p, n); _p += n; return r;
            }
            public byte U8() => Take(1)[0];
            public int U16() => BinaryPrimitives.ReadUInt16LittleEndian(Take(2));
            public uint U32() => BinaryPrimitives.ReadUInt32LittleEndian(Take(4));
            public long I64() => BinaryPrimitives.ReadInt64LittleEndian(Take(8));
            public ulong U64() => BinaryPrimitives.ReadUInt64LittleEndian(Take(8));
            public ReadOnlySpan<byte> Bytes(int n) => Take(n);
            public ReadOnlySpan<byte> Rest() => Take(Remaining);
        }

        /// <summary>
        /// Strict structural check of one frame (spec/binary.md): null when valid or of an unknown type (those are ignored),
        /// else "too_short", "trailing", "too_long" or "bad_utf8". A frame reassembled from chunks passes
        /// <see cref="MaxReassembled"/> as <paramref name="maxLength"/>.
        /// </summary>
        public static string? Validate(ReadOnlySpan<byte> frame, int maxLength = MaxFrame)
        {
            if (frame.Length > maxLength) return "too_long";
            if (frame.Length < 3) return "too_short";
            var r = new Reader(frame.Slice(3));
            try
            {
                switch (frame[0])
                {
                    case Hi: r.U8(); r.U16(); r.I64(); break;
                    case WelcomeDc: r.I64(); r.U8(); r.U8(); r.U16(); break;
                    case Cmd: r.U32(); r.Bytes(r.U16()); break;
                    case FrameMsg:
                    {
                        r.I64(); int n = r.U16();
                        for (var i = 0; i < n; i++) { r.U16(); r.Bytes(r.U16()); }
                        break;
                    }
                    case Hash: r.I64(); r.U64(); break;
                    case Desync: r.I64(); r.U64(); r.U64(); break;
                    case SnapshotReq: r.I64(); break;
                    case Snapshot: r.I64(); r.U32(); r.U8(); break;
                    case Chunk: r.U32(); r.U16(); r.U16(); r.Rest(); break;
                    case Raw: r.Rest(); break;
                    case Ping: case Pong: r.U32(); r.U32(); break;
                    case HostClaim: r.U16(); r.U16(); r.I64(); break;
                    case Voice:
                    {
                        r.U16(); r.U8(); int n = r.U8();
                        for (var i = 0; i < n; i++) r.Bytes(r.U16());
                        break;
                    }
                    case Chat: r.U32(); r.I64(); if (!Utf8(r.Bytes(r.U16()))) return "bad_utf8"; break;
                    case ChatHistory:
                    {
                        int n = r.U16();
                        for (var i = 0; i < n; i++) { r.U16(); r.U32(); r.I64(); if (!Utf8(r.Bytes(r.U16()))) return "bad_utf8"; }
                        break;
                    }
                    case ChatReject: r.U32(); r.U8(); break;
                    case PauseRequest: r.U8(); break;
                    case PauseState: r.U8(); r.U16(); r.U8(); break;
                    case PauseRefuse: r.U8(); r.U8(); break;
                    default: return null;
                }
            }
            catch (FormatException) { return "too_short"; }
            return r.Remaining != 0 ? "trailing" : null;
        }

        private static readonly UTF8Encoding StrictUtf8 = new(false, true);

        private static bool Utf8(ReadOnlySpan<byte> b)
        {
            try { StrictUtf8.GetCharCount(b.ToArray()); return true; }
            catch (ArgumentException) { return false; }
        }

        public static string DecodeUtf8(ReadOnlySpan<byte> b) => StrictUtf8.GetString(b.ToArray());

        public static byte Type(ReadOnlySpan<byte> frame) => frame.Length >= 3 ? frame[0] : throw new FormatException("short frame");
        public static int Route(ReadOnlySpan<byte> frame) => frame.Length >= 3 ? BinaryPrimitives.ReadUInt16LittleEndian(frame.Slice(1, 2)) : throw new FormatException("short frame");
        public static ReadOnlySpan<byte> Body(ReadOnlySpan<byte> frame) => frame.Length >= 3 ? frame.Slice(3) : throw new FormatException("short frame");

        /// <summary>Copy of a frame with the route field replaced (the host does this when relaying).</summary>
        public static byte[] WithRoute(ReadOnlySpan<byte> frame, int route)
        {
            var copy = frame.ToArray();
            BinaryPrimitives.WriteUInt16LittleEndian(copy.AsSpan(1, 2), (ushort)route);
            return copy;
        }

        public static byte[] BuildHi(int peerId, long lastTick) =>
            new Writer(Hi, 0).U8(ProtoVersion).U16(peerId).I64(lastTick).ToArray();

        public static byte[] BuildWelcomeDc(long tick, int tickRate, byte mode, int hostId) =>
            new Writer(WelcomeDc, 0).I64(tick).U8(tickRate).U8(mode).U16(hostId).ToArray();

        public static byte[] BuildCmd(uint seq, ReadOnlySpan<byte> bytes) =>
            new Writer(Cmd, 0).U32(seq).U16(bytes.Length).Bytes(bytes).ToArray();

        public static byte[] BuildFrame(long tick, IReadOnlyList<(int PeerId, ReadOnlyMemory<byte> Command)> commands)
        {
            var w = new Writer(FrameMsg, 0).I64(tick).U16(commands.Count);
            foreach (var (peer, cmd) in commands) w.U16(peer).U16(cmd.Length).Bytes(cmd.Span);
            return w.ToArray();
        }

        public static Frame ParseFrame(ReadOnlySpan<byte> body)
        {
            var r = new Reader(body);
            var tick = r.I64();
            int n = r.U16();
            var list = new List<(int, ReadOnlyMemory<byte>)>(n);
            for (var i = 0; i < n; i++)
            {
                var peer = r.U16();
                var len = r.U16();
                list.Add((peer, (ReadOnlyMemory<byte>)r.Bytes(len).ToArray()));
            }
            return new Frame(tick, list);
        }

        public static byte[] BuildHash(long tick, ulong hash) => new Writer(Hash, 0).I64(tick).U64(hash).ToArray();
        public static byte[] BuildDesync(long tick, ulong hostHash, ulong yourHash) =>
            new Writer(Desync, 0).I64(tick).U64(hostHash).U64(yourHash).ToArray();
        public static byte[] BuildSnapshotReq(long sinceTick) => new Writer(SnapshotReq, 0).I64(sinceTick).ToArray();
        public static byte[] BuildSnapshot(long tick, uint total, byte flags) =>
            new Writer(Snapshot, 0).I64(tick).U32(total).U8(flags).ToArray();
        public static byte[] BuildChunk(uint id, int index, int count, ReadOnlySpan<byte> bytes) =>
            new Writer(Chunk, 0).U32(id).U16(index).U16(count).Bytes(bytes).ToArray();
        public static byte[] BuildRaw(int route, ReadOnlySpan<byte> bytes) => new Writer(Raw, route).Bytes(bytes).ToArray();
        public static byte[] BuildPing(byte type, uint n, uint t) => new Writer(type, 0).U32(n).U32(t).ToArray();
        public static byte[] BuildHostClaim(int epoch, int hostId, long tick) =>
            new Writer(HostClaim, 0).U16(epoch).U16(hostId).I64(tick).ToArray();

        /// <summary>One voice packet: seq:u16 flags:u8 n:u8 then n x (len:u16, opus bytes).</summary>
        public static byte[] BuildVoice(int route, int seq, byte flags, IReadOnlyList<byte[]> frames)
        {
            var w = new Writer(Voice, route).U16(seq).U8(flags).U8(frames.Count);
            foreach (var f in frames) w.U16(f.Length).Bytes(f);
            return w.ToArray();
        }

        public static byte[] BuildChat(int route, uint id, long ts, string text)
        {
            var utf8 = Encoding.UTF8.GetBytes(text);
            return new Writer(Chat, route).U32(id).I64(ts).U16(utf8.Length).Bytes(utf8).ToArray();
        }

        public static byte[] BuildChatHistory(IReadOnlyList<ChatLine> lines)
        {
            var w = new Writer(ChatHistory, 0).U16(lines.Count);
            foreach (var l in lines)
            {
                var utf8 = Encoding.UTF8.GetBytes(l.Text);
                w.U16(l.PeerId).U32(l.Id).I64(l.Ts).U16(utf8.Length).Bytes(utf8);
            }
            return w.ToArray();
        }

        public static byte[] BuildChatReject(uint id, byte reason) => new Writer(ChatReject, 0).U32(id).U8(reason).ToArray();

        /// <summary>Joiner to host: pause (1) or resume (0) for everyone.</summary>
        public static byte[] BuildPauseRequest(bool paused) => new Writer(PauseRequest, 0).U8(paused ? 1 : 0).ToArray();

        /// <summary>Host to everyone: the shared pause state. Flags bit 0 = the pauser left and the host holds the pause.</summary>
        public static byte[] BuildPauseState(bool paused, int byPeer, bool pauserLeft) =>
            new Writer(PauseState, 0).U8(paused ? 1 : 0).U16(byPeer).U8(pauserLeft ? PauseFlagPauserLeft : 0).ToArray();

        /// <summary>Host to the requester: the request (<paramref name="paused"/> = what it asked for) was refused.</summary>
        public static byte[] BuildPauseRefuse(bool paused, byte reason) => new Writer(PauseRefuse, 0).U8(paused ? 1 : 0).U8(reason).ToArray();

        /// <summary>Strips C0/C1 control characters and bidi override/isolate characters (DESIGN s.9b).</summary>
        public static string SanitizeChat(string text)
        {
            var sb = new StringBuilder(text.Length);
            foreach (var c in text)
            {
                if (c < 0x20 || (c >= 0x7F && c <= 0x9F)) continue;
                if ((c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)) continue;
                sb.Append(c);
            }
            return sb.ToString();
        }
    }
}
