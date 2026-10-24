using System;
using System.Collections.Generic;

namespace Keepalive.Gridpaint
{
    /// <summary>The shared demo game (spec/demo-game.md): 16x16 grid, xorshift32 spread, FNV-1a 64 hash.</summary>
    public sealed class GridpaintGame
    {
        public const int Size = 16;
        public const string GameId = "gridpaint";
        public const string NetVersion = "1";
        public const int TickRate = 20;
        public const int HashEveryTicks = 20;
        public const int MaxPlayers = 8;

        private readonly byte[] _grid = new byte[Size * Size];
        private uint _rng;

        public long Tick { get; private set; }
        public ReadOnlySpan<byte> Grid => _grid;

        /// <param name="lobbyCode">Canonical or user-typed join code; the RNG is seeded from it.</param>
        public GridpaintGame(string lobbyCode)
        {
            _rng = Seed(Crockford.Normalize(lobbyCode) ?? lobbyCode);
        }

        /// <summary>FNV-1a-32 of the 6 ASCII bytes of the canonical code; 0 becomes 1.</summary>
        public static uint Seed(string canonicalCode)
        {
            uint h = 0x811c9dc5;
            foreach (var c in canonicalCode) { h ^= (byte)c; h = unchecked(h * 0x01000193); }
            return h == 0 ? 1u : h;
        }

        public static byte[] PaintCommand(int x, int y) => new byte[] { 0x01, (byte)x, (byte)y };

        public static int ColourOf(int peerId) => ((peerId - 1) % 15) + 1;

        private uint Next()
        {
            var x = _rng;
            x ^= x << 13; x ^= x >> 17; x ^= x << 5;
            _rng = x;
            return x;
        }

        /// <summary>Apply frame <paramref name="tick"/> (must be consecutive) with its commands in frame order.</summary>
        public void Apply(long tick, IEnumerable<(int PeerId, ReadOnlyMemory<byte> Command)> commands)
        {
            if (tick != Tick + 1) throw new InvalidOperationException("gap: expected tick " + (Tick + 1) + ", got " + tick);
            foreach (var (peer, cmd) in commands)
            {
                var b = cmd.Span;
                if (b.Length != 3 || b[0] != 0x01) continue;
                if (b[1] < Size && b[2] < Size) _grid[b[2] * Size + b[1]] = (byte)ColourOf(peer);
            }
            var old = (byte[])_grid.Clone();
            for (var i = 0; i < old.Length; i++)
            {
                if (old[i] == 0) continue;
                var d = (int)(Next() % 4);
                int x = i % Size, y = i / Size;
                switch (d) { case 0: y--; break; case 1: x++; break; case 2: y++; break; default: x--; break; }
                if (x < 0 || y < 0 || x >= Size || y >= Size) continue;
                _grid[y * Size + x] = old[i];
            }
            Tick = tick;
        }

        public ulong Hash()
        {
            ulong h = 0xcbf29ce484222325UL;
            foreach (var b in _grid) { h ^= b; h = unchecked(h * 0x100000001b3UL); }
            return h;
        }

        /// <summary>rng u32 LE then the 256 grid bytes.</summary>
        public byte[] Snapshot()
        {
            var o = new byte[4 + _grid.Length];
            o[0] = (byte)_rng; o[1] = (byte)(_rng >> 8); o[2] = (byte)(_rng >> 16); o[3] = (byte)(_rng >> 24);
            Buffer.BlockCopy(_grid, 0, o, 4, _grid.Length);
            return o;
        }

        public void Restore(long tick, ReadOnlySpan<byte> bytes)
        {
            if (bytes.Length != 4 + _grid.Length) throw new ArgumentException("bad snapshot length " + bytes.Length);
            _rng = (uint)(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24);
            bytes.Slice(4).CopyTo(_grid);
            Tick = tick;
        }
    }
}
