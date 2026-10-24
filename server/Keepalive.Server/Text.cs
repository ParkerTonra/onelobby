using System.Globalization;
using System.Text;

namespace Keepalive.Server;

public static class Text
{
    /// <summary>Strips control/format/separator characters, trims, truncates to <paramref name="max"/> chars (never splitting a surrogate pair). Opaque otherwise (DESIGN s.12).</summary>
    public static string Sanitize(string? s, int max, string fallback = "")
    {
        if (string.IsNullOrEmpty(s)) return fallback;
        var sb = new StringBuilder(Math.Min(s.Length, max + 2));
        foreach (char ch in s)
        {
            if (char.IsSurrogate(ch)) { sb.Append(ch); continue; }
            var cat = char.GetUnicodeCategory(ch);
            if (cat is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.LineSeparator
                or UnicodeCategory.ParagraphSeparator or UnicodeCategory.OtherNotAssigned or UnicodeCategory.PrivateUse) continue;
            if (cat == UnicodeCategory.SpaceSeparator) { if (sb.Length > 0 && sb[^1] != ' ') sb.Append(' '); continue; }
            sb.Append(ch);
        }
        string r = sb.ToString().Trim();
        if (r.Length > max)
        {
            r = r[..max];
            if (char.IsHighSurrogate(r[^1])) r = r[..^1];
        }
        return r.Length == 0 ? fallback : r;
    }
}

/// <summary>Sliding-window counter: at most <c>Limit</c> events per <c>WindowMs</c>.</summary>
public sealed class RateWindow
{
    private readonly Queue<long> _hits = new();
    public int Limit { get; }
    public long WindowMs { get; }
    public RateWindow(int limit, long windowMs) { Limit = limit; WindowMs = windowMs; }

    public bool TryHit(long nowMs)
    {
        Trim(nowMs);
        if (_hits.Count >= Limit) return false;
        _hits.Enqueue(nowMs);
        return true;
    }

    public bool IsIdle(long nowMs) { Trim(nowMs); return _hits.Count == 0; }

    private void Trim(long nowMs)
    {
        while (_hits.Count > 0 && nowMs - _hits.Peek() >= WindowMs) _hits.Dequeue();
    }
}
