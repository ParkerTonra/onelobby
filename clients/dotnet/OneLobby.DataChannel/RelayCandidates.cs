using System;
using System.Text;

namespace OneLobby.DataChannel
{
    /// <summary>Relay-only enforcement (spec/nostr-signaling.md s.5): a relay-only link sends and accepts only <c>typ relay</c> candidates.</summary>
    internal static class RelayCandidates
    {
        /// <summary>An ICE candidate line (or SDP <c>a=candidate:</c> line) of type relay.</summary>
        public static bool IsRelay(string candidate) => candidate != null && candidate.Contains(" typ relay");

        /// <summary><paramref name="sdp"/> without its <c>a=candidate:</c> lines that are not relay candidates; other lines and the line ending style stay.</summary>
        public static string FilterSdp(string sdp)
        {
            if (string.IsNullOrEmpty(sdp)) return sdp;
            var lines = sdp.Split('\n');
            var sb = new StringBuilder(sdp.Length);
            for (var i = 0; i < lines.Length; i++)
            {
                var line = lines[i];
                if (line.StartsWith("a=candidate:", StringComparison.Ordinal) && !IsRelay(line)) continue;
                sb.Append(line);
                if (i < lines.Length - 1) sb.Append('\n');
            }
            return sb.ToString();
        }
    }
}
