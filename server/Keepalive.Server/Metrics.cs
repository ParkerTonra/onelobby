using System.Collections.Concurrent;
using System.Globalization;
using System.Text;

namespace Keepalive.Server;

/// <summary>Tiny Prometheus text exposition: labelled counters plus gauges read at scrape time.</summary>
public sealed class Metrics
{
    private readonly ConcurrentDictionary<string, long> _counters = new(StringComparer.Ordinal);
    private readonly SortedDictionary<string, (string Help, Func<long> Read)> _gauges = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _help = new(StringComparer.Ordinal);

    public void Describe(string name, string help) => _help[name] = help;

    public void Gauge(string name, string help, Func<long> read) => _gauges[name] = (help, read);

    /// <summary>Counter name plus optional single label, e.g. Inc("keepalive_path_total", "path", "relayed").</summary>
    public void Inc(string name, string? label = null, string? value = null, long by = 1)
    {
        string key = label is null ? name : $"{name}{{{label}=\"{Escape(value ?? "")}\"}}";
        _counters.AddOrUpdate(key, by, (_, v) => v + by);
    }

    public long Get(string name, string? label = null, string? value = null)
    {
        string key = label is null ? name : $"{name}{{{label}=\"{Escape(value ?? "")}\"}}";
        return _counters.TryGetValue(key, out var v) ? v : 0;
    }

    private static string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");

    public string Render()
    {
        var sb = new StringBuilder();
        foreach (var (name, (help, read)) in _gauges)
        {
            sb.Append("# HELP ").Append(name).Append(' ').Append(help).Append('\n');
            sb.Append("# TYPE ").Append(name).Append(" gauge\n");
            sb.Append(name).Append(' ').Append(read().ToString(CultureInfo.InvariantCulture)).Append('\n');
        }
        string? lastBase = null;
        foreach (var kv in _counters.OrderBy(k => k.Key, StringComparer.Ordinal))
        {
            int br = kv.Key.IndexOf('{');
            string bas = br < 0 ? kv.Key : kv.Key[..br];
            if (bas != lastBase)
            {
                if (_help.TryGetValue(bas, out var h)) sb.Append("# HELP ").Append(bas).Append(' ').Append(h).Append('\n');
                sb.Append("# TYPE ").Append(bas).Append(" counter\n");
                lastBase = bas;
            }
            sb.Append(kv.Key).Append(' ').Append(kv.Value.ToString(CultureInfo.InvariantCulture)).Append('\n');
        }
        return sb.ToString();
    }
}
