using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace OneLobby.Server;

/// <summary>
/// The joiner's diagnosis report (spec/diagnostics.md s.7): fixed, typed fields, never an address, a name, free text or a
/// credential. A hub rebuilds every report from the known fields before it forwards it to the host.
/// </summary>
public static class DiagReport
{
    /// <summary>The largest <c>diag</c> frame a hub accepts, in characters of JSON text.</summary>
    public const int MaxBytes = 1024;
    /// <summary>Reports forwarded per peer in <see cref="WindowMs"/>.</summary>
    public const int PerWindow = 3;
    public const int WindowMs = 60_000;

    private static readonly Regex NameRx = new("^[a-z][a-z0-9_]{0,31}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly Regex VersionRx = new("^[A-Za-z0-9._+-]{1,32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
    private static readonly string[] CandTypes = { "host", "srflx", "relay" };
    private static readonly string[] NatTypes = { "open", "cone", "symmetric", "blocked" };

    /// <summary>The report rebuilt from the known fields (anything else dropped), or null when it is not a valid report.</summary>
    public static JsonObject? Clean(JsonNode? input)
    {
        if (input is not JsonObject r) return null;
        if (Str(r, "cause") is not { } cause || !NameRx.IsMatch(cause)) return null;
        if (Str(r, "stage") is not { } stage || !NameRx.IsMatch(stage)) return null;
        if (!IntIn(r["elapsedMs"], 0, 3_600_000, out long elapsed)) return null;
        if (r["relaySet"] is not JsonValue rs || !rs.TryGetValue<bool>(out bool relaySet)) return null;
        string? nat = null;
        if (r["natType"] is { } nt)
        {
            if (nt is not JsonValue nv || !nv.TryGetValue<string>(out nat) || Array.IndexOf(NatTypes, nat) < 0) return null;
        }
        if (r["candidateTypes"] is not JsonObject ct) return null;
        if (Types(ct["local"]) is not { } local || Types(ct["remote"]) is not { } remote) return null;
        if (Str(r, "clientVersion") is not { } ver || !VersionRx.IsMatch(ver)) return null;
        var o = new JsonObject { ["cause"] = cause, ["stage"] = stage, ["elapsedMs"] = elapsed, ["relaySet"] = relaySet };
        if (nat is not null) o["natType"] = nat;
        o["candidateTypes"] = new JsonObject { ["local"] = local, ["remote"] = remote };
        o["clientVersion"] = ver;
        return o;
    }

    private static string? Str(JsonObject o, string k) => o[k] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool IntIn(JsonNode? n, long lo, long hi, out long value)
    {
        value = 0;
        if (n is not JsonValue v) return false;
        if (v.TryGetValue<long>(out var l)) { value = l; return l >= lo && l <= hi; }
        if (v.TryGetValue<double>(out var d) && d == Math.Floor(d)) { value = (long)d; return d >= lo && d <= hi; }
        return false;
    }

    private static JsonArray? Types(JsonNode? n)
    {
        if (n is not JsonArray a || a.Count > 3) return null;
        var seen = new List<string>();
        foreach (var x in a)
        {
            if (x is not JsonValue v || !v.TryGetValue<string>(out var t) || Array.IndexOf(CandTypes, t) < 0 || seen.Contains(t)) return null;
            seen.Add(t);
        }
        var o = new JsonArray();
        foreach (var t in seen) o.Add(t);
        return o;
    }
}
