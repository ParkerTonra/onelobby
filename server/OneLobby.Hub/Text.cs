using System.Text;

namespace OneLobby.Server;

public static class Text
{
    /// <summary>
    /// Removes control characters (U+0000-U+001F, U+007F-U+009F) and bidi overrides (U+202A-U+202E, U+2066-U+2069), then
    /// truncates to <paramref name="max"/> UTF-16 units without splitting a surrogate pair (spec/signaling.md). Otherwise opaque.
    /// </summary>
    public static string Sanitize(string? s, int max, string fallback = "")
    {
        if (string.IsNullOrEmpty(s)) return fallback;
        var sb = new StringBuilder(Math.Min(s.Length, max + 2));
        foreach (char ch in s)
        {
            if (ch <= 0x1F || (ch >= 0x7F && ch <= 0x9F) || (ch >= 0x202A && ch <= 0x202E) || (ch >= 0x2066 && ch <= 0x2069)) continue;
            sb.Append(ch);
        }
        string r = sb.ToString();
        if (r.Length > max)
        {
            r = r[..max];
            if (r.Length > 0 && char.IsHighSurrogate(r[^1])) r = r[..^1];
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

    /// <summary>Milliseconds until a hit would be admitted again.</summary>
    public long RetryAfterMs(long nowMs)
    {
        Trim(nowMs);
        return _hits.Count < Limit || _hits.Count == 0 ? 0 : Math.Max(1, WindowMs - (nowMs - _hits.Peek()));
    }

    public bool IsIdle(long nowMs) { Trim(nowMs); return _hits.Count == 0; }

    private void Trim(long nowMs)
    {
        while (_hits.Count > 0 && nowMs - _hits.Peek() >= WindowMs) _hits.Dequeue();
    }
}
