using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>Every case in spec/vectors/diagnostics.json (the contract the JS client and the GDScript client share).</summary>
    public class DiagnosticsVectorTests
    {
        private static readonly JsonDocument Doc = Spec.Load("vectors/diagnostics.json");
        private static JsonElement V => Doc.RootElement;

        private static string? S(JsonElement e, string n) => e.TryGetProperty(n, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
        private static List<string> Strs(JsonElement e) => e.EnumerateArray().Select(x => x.GetString()!).ToList();

        private static string Canon(JsonElement e)
        {
            using var ms = new MemoryStream();
            using (var w = new Utf8JsonWriter(ms)) e.WriteTo(w);
            return Encoding.UTF8.GetString(ms.ToArray());
        }

        private static DiagnoseFacts FactsOf(JsonElement f) => new DiagnoseFacts
        {
            Side = S(f, "side")!,
            Route = S(f, "route")!,
            Error = S(f, "error"),
            Reached = Diagnose.ParseReached(S(f, "reached")!),
            ElapsedMs = f.GetProperty("elapsedMs").GetInt64(),
            Versions = f.GetProperty("versions").ValueKind == JsonValueKind.Object ? (S(f.GetProperty("versions"), "mine")!, S(f.GetProperty("versions"), "theirs")!) : ((string, string)?)null,
            RelaysUp = f.GetProperty("relaysUp").ValueKind == JsonValueKind.Null ? null : f.GetProperty("relaysUp").GetBoolean(),
            Stun = f.GetProperty("stun").GetBoolean(),
            Relay = Diagnose.ParseRelay(S(f, "relay")!),
            Local = Strs(f.GetProperty("local")),
            Remote = Strs(f.GetProperty("remote")),
            Retried = f.GetProperty("retried").GetBoolean(),
            Nat = S(f, "nat")!,
            Heard = f.GetProperty("heard").ValueKind == JsonValueKind.Null ? null : f.GetProperty("heard").GetBoolean(),
        };

        [Fact]
        public void TheCauseTableMatchesTheVectorsTextForText()
        {
            foreach (var c in V.GetProperty("causes").EnumerateArray())
            {
                var code = S(c, "code")!;
                var e = Diagnose.Explain(code, "ice", 0, "{mine}", "{theirs}");
                var raw = c.GetProperty("message").GetString()!;
                // the placeholders are filled by Explain; compare the unfilled text through placeholders passed as their own names
                Assert.Equal(raw.Replace("{stage_text}", Diagnose.StageText("ice")).Replace("{elapsed}", Diagnose.ElapsedText(0)), e.Message);
                Assert.Equal(S(c, "hint"), e.Hint);
                Assert.Equal(S(c, "hostHint"), e.HostHint);
                Assert.Equal(S(c, "short"), e.Short);
            }
        }

        [Fact]
        public void StageTextAndStageOf()
        {
            foreach (var p in V.GetProperty("stageText").EnumerateObject()) Assert.Equal(p.Value.GetString(), Diagnose.StageText(p.Name));
            foreach (var p in V.GetProperty("stageOf").EnumerateObject()) Assert.Equal(p.Value.GetString(), Diagnose.StageOf(Diagnose.ParseReached(p.Name)));
        }

        [Fact]
        public void Diagnose28Cases()
        {
            var n = 0;
            foreach (var c in V.GetProperty("diagnose").EnumerateArray())
            {
                var d = Diagnose.Run(FactsOf(c.GetProperty("facts")));
                var x = c.GetProperty("expect");
                var name = S(c, "name");
                Assert.True(S(x, "cause") == d.Cause, name + ": cause");
                Assert.True(S(x, "message") == d.Message, name + ": message");
                Assert.True(S(x, "hint") == d.Hint, name + ": hint");
                Assert.True(S(x, "stage") == d.Stage, name + ": stage");
                n++;
            }
            Assert.Equal(28, n);
        }

        [Fact]
        public void HostLinesAndExplain()
        {
            foreach (var c in V.GetProperty("hostLine").EnumerateArray())
            {
                var i = c.GetProperty("input");
                Assert.Equal(S(c, "expect"), Diagnose.HostLine(S(i, "name")!, S(i, "cause")!, S(i, "stage")!, i.GetProperty("elapsedMs").GetInt64()));
            }
            foreach (var c in V.GetProperty("explain").EnumerateArray())
            {
                var i = c.GetProperty("input");
                var e = Diagnose.Explain(S(i, "cause")!, S(i, "stage")!, i.GetProperty("elapsedMs").GetInt64(), S(i, "mine"), S(i, "theirs"));
                var x = c.GetProperty("expect");
                Assert.Equal(S(x, "message"), e.Message);
                Assert.Equal(S(x, "hint"), e.Hint);
                Assert.Equal(S(x, "hostHint"), e.HostHint);
            }
        }

        [Fact]
        public void MaskCases()
        {
            foreach (var c in V.GetProperty("mask").EnumerateArray())
            {
                Assert.True(S(c, "masked") == NetLog.Mask(S(c, "input")!, false), S(c, "name") + " (masked)");
                Assert.True(S(c, "included") == NetLog.Mask(S(c, "input")!, true), S(c, "name") + " (included)");
            }
        }

        [Fact]
        public void ExportFormatMaskedAndWithAddresses()
        {
            var ex = V.GetProperty("export");
            long now = 0;
            var m = ex.GetProperty("meta");
            var log = new NetLog(10, () => now, new NetLogMeta(S(m, "client")!, S(m, "protocol")!, S(m, "platform")!), raw: true);
            foreach (var e in ex.GetProperty("entries").EnumerateArray())
            {
                now = e.GetProperty("t").GetInt64();
                log.Add(S(e, "kind")!, S(e, "text")!, S(e, "addr"), S(e, "code"));
            }
            Assert.Equal(S(ex, "masked"), log.Export());
            Assert.Equal(S(ex, "included"), log.Export(includeAddresses: true));
        }

        [Fact]
        public void TheRingDropsTheOldestAndTheSequenceKeepsCounting()
        {
            var r = V.GetProperty("ring");
            var log = new NetLog(r.GetProperty("capacity").GetInt32());
            var a = r.GetProperty("add");
            for (var i = 1; i <= a.GetProperty("count").GetInt32(); i++) log.Add(S(a, "kind")!, S(a, "text")!.Replace("{i}", i.ToString()));
            var x = r.GetProperty("expect");
            Assert.Equal(x.GetProperty("kept").GetInt32(), log.Entries.Count);
            Assert.Equal(x.GetProperty("dropped").GetInt64(), log.Dropped);
            Assert.Equal(x.GetProperty("firstSeq").GetInt64(), log.Entries[0].Seq);
            Assert.Equal(x.GetProperty("lastSeq").GetInt64(), log.Entries[^1].Seq);
            Assert.Equal(S(x, "headerEntries"), log.Export().Split('\n')[2]);
        }

        [Fact]
        public void CapacityIsClampedAndTextIsCut()
        {
            var log = new NetLog(5);
            for (var i = 0; i < 60; i++) log.Add("info", "x");
            Assert.Equal(50, log.Entries.Count);
            log.Add("info", new string('x', 300));
            Assert.Equal(200, log.Entries[^1].Text.Length);
        }

        [Fact]
        public void ReportValidAndInvalid()
        {
            var r = V.GetProperty("report");
            foreach (var c in r.GetProperty("valid").EnumerateArray())
            {
                var rep = Diagnose.CleanReport(c.GetProperty("input"));
                Assert.NotNull(rep);
                using var d = JsonDocument.Parse(rep!.ToJson());
                Assert.True(Canon(c.GetProperty("output")) == Canon(d.RootElement), S(c, "name"));
            }
            foreach (var c in r.GetProperty("invalid").EnumerateArray())
                Assert.True(Diagnose.CleanReport(c.GetProperty("input")) == null, S(c, "name"));
        }

        [Fact]
        public void CheckVerdicts()
        {
            foreach (var c in V.GetProperty("check").GetProperty("verdict").EnumerateArray())
            {
                var i = c.GetProperty("input");
                var (verdict, message) = Diagnose.CheckVerdict(new CheckFindings(S(i, "udp")!, S(i, "natType")!, S(i, "relay")!));
                Assert.True(S(c, "verdict") == verdict, S(c, "name"));
                Assert.Equal(S(c, "message"), message);
            }
        }

        [Fact]
        public void NatClassification()
        {
            foreach (var c in V.GetProperty("check").GetProperty("classify").EnumerateArray())
            {
                var answers = c.GetProperty("answers").EnumerateArray().Select(a => (S(a, "ip")!, a.GetProperty("port").GetInt32())).ToList();
                (string, int)? local = c.GetProperty("local").ValueKind == JsonValueKind.Object ? (S(c.GetProperty("local"), "ip")!, c.GetProperty("local").GetProperty("port").GetInt32()) : null;
                var (udp, nat) = Diagnose.ClassifyNat(c.GetProperty("asked").GetInt32(), answers, local);
                var x = c.GetProperty("expect");
                Assert.True(S(x, "udp") == udp && S(x, "natType") == nat, S(c, "name"));
            }
        }

        [Fact]
        public void StunRequestAndResponseBytes()
        {
            var st = V.GetProperty("stun");
            var tid = Spec.Hex(S(st.GetProperty("request"), "transactionId")!);
            Assert.Equal(S(st.GetProperty("request"), "bytes"), Spec.ToHex(StunMessages.BindingRequest(tid)));
            foreach (var r in st.GetProperty("responses").EnumerateArray())
            {
                var got = StunMessages.ParseBindingResponse(Spec.Hex(S(r, "bytes")!), Spec.Hex(S(r, "transactionId")!));
                var x = r.GetProperty("expect");
                if (x.ValueKind == JsonValueKind.Null) Assert.True(got == null, S(r, "name"));
                else
                {
                    Assert.True(got != null, S(r, "name"));
                    Assert.Equal(S(x, "ip"), got!.Value.Ip);
                    Assert.Equal(x.GetProperty("port").GetInt32(), got.Value.Port);
                }
            }
        }

        [Fact]
        public void AnAddressPrintedByIncludeAddressesNeverShowsACredential()
        {
            var log = new NetLog();
            log.Add("sig", "open", "wss://sam:hunter2@198.51.100.2:8080/ws?token=abc123");
            var text = log.Export(includeAddresses: true);
            Assert.DoesNotContain("hunter2", text);
            Assert.DoesNotContain("abc123", text);
            Assert.Contains("198.51.100.2:8080", text);
        }

        [Fact]
        public void TheNetLogSavesAndFlushesToItsPath()
        {
            var dir = Path.Combine(Path.GetTempPath(), "onelobby-netlog-" + Guid.NewGuid().ToString("N"));
            try
            {
                var path = Path.Combine(dir, "sub", "log.txt");
                var log = new NetLog(path: path);
                log.Add("error", "ice_failed", code: "ice_failed");
                Assert.Equal(path, log.Save());
                Assert.Contains("error ice_failed", File.ReadAllText(path));
                File.Delete(path);
                log.Flush();
                Assert.True(File.Exists(path));
                Assert.Throws<InvalidOperationException>(() => new NetLog().Save());
            }
            finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        }

        [Fact]
        public void ALiveNetLogHasEveryLineOnDiskAsItIsAdded()
        {
            var dir = Path.Combine(Path.GetTempPath(), "onelobby-netlog-live-" + Guid.NewGuid().ToString("N"));
            try
            {
                var path = Path.Combine(dir, "live.txt");
                var live = new NetLog(path: path) { Live = true };
                Assert.False(File.Exists(path)); // nothing yet: the first entry opens the file
                live.Add("info", "first");
                live.Add("sig", "dial 192.0.2.7:47810");
                var text = File.ReadAllText(path); // no Save, no Flush, no exit: the file is already there
                Assert.StartsWith("# onelobby netlog v1", text);
                Assert.Contains("info first", text);
                Assert.Contains("sig dial <ip4>", text); // masked like the export
                Assert.DoesNotContain("192.0.2.7", text);
                // negative control: not live, nothing is written until Save or Flush
                var quietPath = Path.Combine(dir, "quiet.txt");
                var quiet = new NetLog(path: quietPath);
                quiet.Add("info", "first");
                Assert.False(File.Exists(quietPath));
                // the environment variable names the file; blank means none
                Assert.Equal("x.txt", NetLog.EnvPath(_ => " x.txt "));
                Assert.Null(NetLog.EnvPath(_ => "  "));
                Assert.Null(NetLog.EnvPath(_ => null));
            }
            finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
        }

        [Fact]
        public void LoopbackTargetsBindLoopback()
        {
            Assert.True(ConnectionCheck.AllLoopback(new[] { ("127.0.0.1", 1), ("localhost", 2) }));
            Assert.False(ConnectionCheck.AllLoopback(new[] { ("127.0.0.1", 1), ("203.0.113.9", 2) }));
            Assert.False(ConnectionCheck.AllLoopback(Array.Empty<(string, int)>()));
        }
    }
}
