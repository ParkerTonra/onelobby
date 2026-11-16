using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace OneLobby
{
    /// <summary>The causes of a failed connection (spec/diagnostics.md s.3). A newer peer may report a code this client does not list: it reads as <see cref="TimeoutUnknown"/>.</summary>
    public static class Causes
    {
        public const string NatBlocked = "nat_blocked";
        public const string RelayRefused = "relay_refused";
        public const string RelayUnreachable = "relay_unreachable";
        public const string UdpBlocked = "udp_blocked";
        public const string Firewall = "firewall";
        public const string VersionMismatch = "version_mismatch";
        public const string HostUnreachable = "host_unreachable";
        public const string SignalingUnreachable = "signaling_unreachable";
        public const string TimeoutUnknown = "timeout_unknown";
    }

    /// <summary>How far a connection attempt got (the last step it completed).</summary>
    public enum Reached { None, Signaling, Joined, Offer, Ice, Channels }

    /// <summary>What a TURN allocation did on a link (<c>None</c>: no TURN entry; <c>Failed</c>: gathering ended with no relay, reason unknown).</summary>
    public enum RelayState { None, Pending, Ok, Refused, Unreachable, Failed }

    /// <summary>Everything a client can observe about one connection attempt (spec/diagnostics.md s.2). Candidate types are <c>host</c>, <c>srflx</c>, <c>relay</c> (sorted, unique).</summary>
    public sealed record DiagnoseFacts
    {
        /// <summary><c>joiner</c> or <c>host</c>.</summary>
        public string Side { get; init; } = "joiner";
        /// <summary><c>server</c>, <c>ip</c> or <c>nostr</c>.</summary>
        public string Route { get; init; } = "server";
        /// <summary>The error code that ended the attempt, or null.</summary>
        public string? Error { get; init; }
        public Reached Reached { get; init; }
        public long ElapsedMs { get; init; }
        public (string Mine, string Theirs)? Versions { get; init; }
        /// <summary>Route nostr: at least one relay connected; null otherwise or unknown.</summary>
        public bool? RelaysUp { get; init; }
        /// <summary>A <c>stun:</c> server was in the link's ICE list.</summary>
        public bool Stun { get; init; }
        public RelayState Relay { get; init; } = RelayState.None;
        public IReadOnlyList<string> Local { get; init; } = Array.Empty<string>();
        public IReadOnlyList<string> Remote { get; init; } = Array.Empty<string>();
        public bool Retried { get; init; }
        /// <summary><c>unknown</c>, <c>open</c>, <c>cone</c>, <c>symmetric</c> or <c>blocked</c>.</summary>
        public string Nat { get; init; } = "unknown";
        /// <summary>Host side: any ICE traffic from this joiner reached the listener; null when the platform cannot tell.</summary>
        public bool? Heard { get; init; }
    }

    /// <summary>What <see cref="Diagnose.Run"/> says: the cause and the sentences a player reads.</summary>
    /// <param name="Cause">A cause code (<see cref="Causes"/>).</param>
    /// <param name="Message">What happened, one sentence.</param>
    /// <param name="Hint">The one concrete next step, for the failing player.</param>
    /// <param name="Stage"><c>signaling</c>, <c>join</c>, <c>offer</c>, <c>ice</c>, <c>channels</c> or <c>handshake</c>.</param>
    public sealed record Diagnosis(string Cause, string Message, string Hint, string Stage);

    /// <summary>The text of one cause (spec/diagnostics.md s.4).</summary>
    public sealed record CauseExplanation(string Cause, string Message, string Hint, string HostHint, string Short);

    /// <summary>What a joiner tells the host it dialed: fixed, typed fields, never an address, name, free text or credential (s.7.1).</summary>
    public sealed record DiagnosisReport(string Cause, string Stage, long ElapsedMs, bool RelaySet, string? NatType,
        IReadOnlyList<string> LocalTypes, IReadOnlyList<string> RemoteTypes, string ClientVersion)
    {
        /// <summary>The report as the JSON object the wire carries (key order as the spec's).</summary>
        public string ToJson()
        {
            using var ms = new System.IO.MemoryStream();
            using (var w = new Utf8JsonWriter(ms))
            {
                Write(w);
            }
            return System.Text.Encoding.UTF8.GetString(ms.ToArray());
        }

        internal void Write(Utf8JsonWriter w)
        {
            w.WriteStartObject();
            w.WriteString("cause", Cause);
            w.WriteString("stage", Stage);
            w.WriteNumber("elapsedMs", ElapsedMs);
            w.WriteBoolean("relaySet", RelaySet);
            if (NatType != null) w.WriteString("natType", NatType);
            w.WriteStartObject("candidateTypes");
            w.WriteStartArray("local"); foreach (var t in LocalTypes) w.WriteStringValue(t); w.WriteEndArray();
            w.WriteStartArray("remote"); foreach (var t in RemoteTypes) w.WriteStringValue(t); w.WriteEndArray();
            w.WriteEndObject();
            w.WriteString("clientVersion", ClientVersion);
            w.WriteEndObject();
        }
    }

    /// <summary>What a host learns when a joiner it dialed could not connect (<see cref="Lobby.PeerDiagnosis"/>, spec/diagnostics.md s.7.3).</summary>
    /// <param name="Peer">The joiner.</param>
    /// <param name="Name">The joiner's name in the roster.</param>
    /// <param name="Report">The cleaned report.</param>
    /// <param name="Message">The same sentence the joiner saw.</param>
    /// <param name="Hint">What the host can do about it.</param>
    /// <param name="Line">One line for a host screen: <c>Sam: strict NAT, no relay set, stopped at the connection check after 15 s.</c></param>
    public sealed record PeerDiagnosisInfo(Peer Peer, string Name, DiagnosisReport Report, string Message, string Hint, string Line);

    /// <summary>The connection check's findings (what <see cref="Diagnose.CheckVerdict"/> reads).</summary>
    public sealed record CheckFindings(string Udp, string NatType, string Relay);

    /// <summary>What <see cref="LobbyClient.CheckConnectionAsync"/> returns.</summary>
    /// <param name="Udp"><c>ok</c>, <c>blocked</c> or <c>unknown</c>.</param>
    /// <param name="NatType"><c>open</c>, <c>cone</c>, <c>symmetric</c> or <c>unknown</c>.</param>
    /// <param name="Relay"><c>ok</c>, <c>refused</c>, <c>unreachable</c>, <c>unknown</c> or <c>none</c>.</param>
    /// <param name="Verdict"><c>good</c>, <c>likely_fail</c>, <c>relay_works</c>, <c>blocked</c>, <c>relay_refused</c>, <c>relay_unreachable</c> or <c>unknown</c>.</param>
    /// <param name="Message">One plain line for a menu.</param>
    public sealed record CheckResult(string Udp, string NatType, string Relay, string Verdict, string Message);

    /// <summary>The pure part of diagnostics (spec/diagnostics.md, vectors in spec/vectors/diagnostics.json): the cause table, <see cref="Run"/>, the host line, the report cleaner and the check verdict. No network, no clock.</summary>
    public static class Diagnose
    {
        private static readonly Dictionary<string, CauseExplanation> CauseText = new Dictionary<string, CauseExplanation>
        {
            [Causes.NatBlocked] = new(Causes.NatBlocked,
                "Your network blocks direct connections (strict NAT) and no relay is set.",
                "Paste a relay line in the game's settings, ask the host for one, or try another network such as a phone hotspot.",
                "A relay (TURN) set on your side, or a forwarded game port, would let this player in.",
                "strict NAT, no relay set"),
            [Causes.RelayRefused] = new(Causes.RelayRefused,
                "The relay rejected the login.",
                "Check the relay line in the settings; it may have been typed wrong or expired.",
                "Their relay line may be wrong or expired.",
                "the relay rejected the login"),
            [Causes.RelayUnreachable] = new(Causes.RelayUnreachable,
                "The relay could not be used: it did not answer.",
                "Check the relay line for typos and that the relay is online; some networks block relays.",
                "Their relay is down or their network blocks it.",
                "the relay did not answer"),
            [Causes.UdpBlocked] = new(Causes.UdpBlocked,
                "Your network blocks UDP, the kind of traffic games use to connect.",
                "Try another network, such as a phone hotspot, or a relay that can be reached from this network.",
                "Their network blocks UDP. Ask them to try another network.",
                "UDP blocked"),
            [Causes.Firewall] = new(Causes.Firewall,
                "A firewall may be blocking the game on the host's computer: nothing from the player ever reached it.",
                "Allow the game in the firewall (on Windows, tick Private networks when asked), then try again.",
                "Allow the game in your firewall (on Windows, tick Private networks when asked), then ask them to try again.",
                "nothing reached the host (firewall?)"),
            [Causes.VersionMismatch] = new(Causes.VersionMismatch,
                "You have version {mine}, the host has {theirs}.",
                "Update the game on the older side, then try again.",
                "Make sure you both have the same version of the game.",
                "different game version"),
            [Causes.HostUnreachable] = new(Causes.HostUnreachable,
                "The host did not answer.",
                "Check the code or address, and that the host is online with the game open.",
                "They could not reach you. Check that your game is open and the code is current.",
                "the host did not answer"),
            [Causes.SignalingUnreachable] = new(Causes.SignalingUnreachable,
                "Could not reach the lobby server or any relay that introduces players.",
                "Check your internet connection; if it works elsewhere, try again in a few minutes.",
                "Their internet connection or the lobby service may be down.",
                "no lobby server or relay reachable"),
            [Causes.TimeoutUnknown] = new(Causes.TimeoutUnknown,
                "The connection did not finish. It stopped at {stage_text} after {elapsed}.",
                "Try again. If it keeps happening, copy the log and send it to the host.",
                "Ask them to copy their log and send it to you.",
                "unknown cause"),
        };

        private const string VersionMismatchPlain = "You and the host have different versions of the game.";

        private static readonly Dictionary<string, string> StageTexts = new Dictionary<string, string>
        {
            ["signaling"] = "reaching the lobby",
            ["join"] = "joining the lobby",
            ["offer"] = "waiting for the host to start the connection",
            ["ice"] = "the connection check",
            ["channels"] = "opening the game connection",
            ["handshake"] = "the final hello with the host",
        };

        /// <summary>The stage a failed attempt stopped at, from how far it got.</summary>
        public static string StageOf(Reached reached) => reached switch
        {
            Reached.None => "signaling",
            Reached.Signaling => "join",
            Reached.Joined => "offer",
            Reached.Offer => "ice",
            Reached.Ice => "channels",
            Reached.Channels => "handshake",
            _ => "ice",
        };

        /// <summary>The <see cref="Reached"/> a vector names (<c>none</c>, <c>signaling</c>, ...).</summary>
        public static Reached ParseReached(string s) => s switch
        {
            "signaling" => Reached.Signaling,
            "joined" => Reached.Joined,
            "offer" => Reached.Offer,
            "ice" => Reached.Ice,
            "channels" => Reached.Channels,
            _ => Reached.None,
        };

        /// <summary>The <see cref="RelayState"/> a vector names.</summary>
        public static RelayState ParseRelay(string s) => s switch
        {
            "pending" => RelayState.Pending,
            "ok" => RelayState.Ok,
            "refused" => RelayState.Refused,
            "unreachable" => RelayState.Unreachable,
            "failed" => RelayState.Failed,
            _ => RelayState.None,
        };

        /// <summary><c>under 1 s</c> below a second, else whole seconds rounded to nearest (halves up) and <c> s</c>.</summary>
        public static string ElapsedText(long ms) =>
            ms < 1000 ? "under 1 s" : ((long)Math.Floor(ms / 1000.0 + 0.5)).ToString(CultureInfo.InvariantCulture) + " s";

        /// <summary>How a stage reads in a sentence (an unknown stage reads as <c>ice</c>).</summary>
        public static string StageText(string stage) => StageTexts.TryGetValue(stage, out var t) ? t : StageTexts["ice"];

        /// <summary>The sentence, next step and host-side step for a cause code (an unknown code reads as <c>timeout_unknown</c>).</summary>
        public static CauseExplanation Explain(string cause, string stage = "ice", long elapsedMs = 0, string? mine = null, string? theirs = null)
        {
            var known = CauseText.TryGetValue(cause, out var t);
            if (!known) t = CauseText[Causes.TimeoutUnknown];
            var message = t!.Message;
            if (cause == Causes.VersionMismatch && (string.IsNullOrEmpty(mine) || string.IsNullOrEmpty(theirs))) message = VersionMismatchPlain;
            message = message.Replace("{mine}", mine ?? "").Replace("{theirs}", theirs ?? "")
                .Replace("{stage_text}", StageText(stage)).Replace("{elapsed}", ElapsedText(elapsedMs));
            return new CauseExplanation(known ? cause : Causes.TimeoutUnknown, message, t.Hint, t.HostHint, t.Short);
        }

        private static readonly string[] Unreached = { "direct_unreachable", "connect_failed", "no_server", "server_closed", "closed" };

        private static string CauseOf(DiagnoseFacts f)
        {
            if (f.Error == "version_mismatch") return Causes.VersionMismatch;
            if ((f.Reached == Reached.None || f.Reached == Reached.Signaling) && f.Error != null && Array.IndexOf(Unreached, f.Error) >= 0)
            {
                if (f.Route == "server") return Causes.SignalingUnreachable;
                if (f.Route == "nostr") return f.RelaysUp == false ? Causes.SignalingUnreachable : Causes.HostUnreachable;
                return Causes.HostUnreachable;
            }
            if (f.Error == "ice_failed" || f.Error == "timeout")
            {
                if (f.Relay == RelayState.Refused) return Causes.RelayRefused;
                if (f.Relay == RelayState.Unreachable || f.Relay == RelayState.Failed) return Causes.RelayUnreachable;
                var negotiated = f.Reached == Reached.Offer;
                if (negotiated && f.Relay == RelayState.None)
                {
                    if (f.Nat == "blocked") return Causes.UdpBlocked;
                    if (f.Stun && f.Local.Count > 0 && !f.Local.Contains("srflx")) return Causes.UdpBlocked;
                    if (f.Nat == "symmetric") return Causes.NatBlocked;
                    if (f.Side == "host" && f.Heard == false) return Causes.Firewall;
                    if (f.Side == "joiner" && f.Local.Count > 0 && f.Remote.Count > 0) return Causes.NatBlocked;
                }
            }
            return Causes.TimeoutUnknown;
        }

        /// <summary>The cause of a failed connection, from what the client observed. Pure: every client gives the same answer for the same facts.</summary>
        public static Diagnosis Run(DiagnoseFacts facts)
        {
            var stage = StageOf(facts.Reached);
            var cause = CauseOf(facts);
            var e = Explain(cause, stage, facts.ElapsedMs, facts.Versions?.Mine, facts.Versions?.Theirs);
            return new Diagnosis(cause, e.Message, e.Hint, stage);
        }

        /// <summary>The line a host shows for a joiner's failure: <c>Sam: strict NAT, no relay set, stopped at the connection check after 15 s.</c></summary>
        public static string HostLine(string name, string cause, string stage, long elapsedMs) =>
            name + ": " + Explain(cause).Short + ", stopped at " + StageText(stage) + " after " + ElapsedText(elapsedMs) + ".";

        // ---- the report -----------------------------------------------------------------------------------------

        public const int ReportMaxBytes = 1024;
        public const int ReportsPerWindow = 3;
        public const int ReportWindowMs = 60_000;
        /// <summary>The host keeps at most one report per peer in this long.</summary>
        public const int ReportHostGapMs = 10_000;

        private static readonly Regex NameRe = new Regex("^[a-z][a-z0-9_]{0,31}\\z", RegexOptions.CultureInvariant);
        private static readonly Regex VersionRe = new Regex("^[A-Za-z0-9._+-]{1,32}\\z", RegexOptions.CultureInvariant);
        private static readonly string[] CandTypes = { "host", "srflx", "relay" };
        private static readonly string[] NatTypes = { "open", "cone", "symmetric", "blocked" };

        private static List<string>? TypeList(JsonElement v)
        {
            if (v.ValueKind != JsonValueKind.Array || v.GetArrayLength() > 3) return null;
            var o = new List<string>();
            foreach (var x in v.EnumerateArray())
            {
                if (x.ValueKind != JsonValueKind.String) return null;
                var s = x.GetString()!;
                if (Array.IndexOf(CandTypes, s) < 0 || o.Contains(s)) return null;
                o.Add(s);
            }
            return o;
        }

        /// <summary>The report rebuilt from the known fields (anything else is dropped), or null when it is not a valid report.</summary>
        public static DiagnosisReport? CleanReport(JsonElement r)
        {
            if (r.ValueKind != JsonValueKind.Object) return null;
            if (!r.TryGetProperty("cause", out var cause) || cause.ValueKind != JsonValueKind.String || !NameRe.IsMatch(cause.GetString()!)) return null;
            if (!r.TryGetProperty("stage", out var stage) || stage.ValueKind != JsonValueKind.String || !NameRe.IsMatch(stage.GetString()!)) return null;
            if (!r.TryGetProperty("elapsedMs", out var el) || el.ValueKind != JsonValueKind.Number) return null;
            long elapsed;
            if (el.TryGetInt64(out var l)) elapsed = l;
            else if (el.TryGetDouble(out var d) && d == Math.Floor(d) && Math.Abs(d) < 1e15) elapsed = (long)d;
            else return null;
            if (elapsed < 0 || elapsed > 3_600_000) return null;
            if (!r.TryGetProperty("relaySet", out var rs) || (rs.ValueKind != JsonValueKind.True && rs.ValueKind != JsonValueKind.False)) return null;
            string? nat = null;
            if (r.TryGetProperty("natType", out var nt))
            {
                if (nt.ValueKind != JsonValueKind.String || Array.IndexOf(NatTypes, nt.GetString()) < 0) return null;
                nat = nt.GetString();
            }
            if (!r.TryGetProperty("candidateTypes", out var ct) || ct.ValueKind != JsonValueKind.Object) return null;
            if (!ct.TryGetProperty("local", out var lo) || !ct.TryGetProperty("remote", out var re)) return null;
            var local = TypeList(lo);
            var remote = TypeList(re);
            if (local == null || remote == null) return null;
            if (!r.TryGetProperty("clientVersion", out var ver) || ver.ValueKind != JsonValueKind.String || !VersionRe.IsMatch(ver.GetString()!)) return null;
            return new DiagnosisReport(cause.GetString()!, stage.GetString()!, elapsed, rs.ValueKind == JsonValueKind.True, nat, local, remote, ver.GetString()!);
        }

        // ---- the connection check's verdict and NAT classification (s.8) ---------------------------------------

        /// <summary>The one line a menu shows for a check (first match wins, spec/diagnostics.md s.8).</summary>
        public static (string Verdict, string Message) CheckVerdict(CheckFindings r)
        {
            if (r.Relay == "refused") return ("relay_refused", "The relay rejected the login. Check the relay line; it may have expired.");
            if (r.Relay == "unreachable") return ("relay_unreachable", "The relay did not answer. Check the relay line and your network.");
            if (r.Udp == "blocked" && r.Relay == "ok") return ("relay_works", "Direct connections will fail, but your relay works.");
            if (r.Udp == "blocked")
                return ("blocked", "Direct connections: will fail. Your network blocks UDP (or the test servers could not be reached). A relay or another network is needed.");
            if (r.NatType == "symmetric" && r.Relay == "ok") return ("relay_works", "Direct connections may fail, but your relay works.");
            if (r.NatType == "symmetric") return ("likely_fail", "Direct connections: likely to fail. A relay is recommended.");
            if (r.NatType == "open" || r.NatType == "cone") return ("good", "Direct connections: likely to work.");
            return ("unknown", "Could not tell how your network handles direct connections.");
        }

        /// <summary><c>udp</c> and <c>natType</c> from what the STUN servers saw: <paramref name="asked"/> servers were queried from one socket, <paramref name="answers"/> are the mapped addresses that came back, <paramref name="local"/> the socket's own address when known (it decides <c>open</c>).</summary>
        public static (string Udp, string NatType) ClassifyNat(int asked, IReadOnlyList<(string Ip, int Port)> answers, (string Ip, int Port)? local)
        {
            if (answers.Count == 0) return (asked > 0 ? "blocked" : "unknown", "unknown");
            if (answers.Count == 1) return ("ok", "unknown");
            var first = answers[0];
            if (answers.Any(a => a.Ip != first.Ip || a.Port != first.Port)) return ("ok", "symmetric");
            if (local is { } me && me.Ip == first.Ip && me.Port == first.Port) return ("ok", "open");
            return ("ok", "cone");
        }

        /// <summary>The <c>nat</c> fact a <see cref="Run"/> call takes from a check result.</summary>
        public static string NatFact(CheckResult? r) => r == null ? "unknown" : r.Udp == "blocked" ? "blocked" : r.NatType;
    }
}
