using System;
using System.Text;

namespace OneLobby.Replication
{
    /// <summary>
    /// The debug view (spec/replication.md "Debug view"): one replication message as a JSON object text. The wire stays
    /// binary; this only reads it. A delta record needs its baseline (the state length decides the mask size), so pass the
    /// baseline world when you have it.
    /// </summary>
    internal static class Describe
    {
        public static string Json(ReadOnlySpan<byte> p, World? baseline = null)
        {
            if (!Proto.IsReplication(p)) return "{\"kind\":\"other\",\"bytes\":" + p.Length + "}";
            if (p[1] != Proto.Version) return "{\"kind\":\"ignored\",\"reason\":\"version\",\"version\":" + p[1] + ",\"bytes\":" + p.Length + "}";
            var name = p[2] switch { 1 => "snapshot", 2 => "input", 3 => "event", 4 => "streamEvent", _ => null };
            if (name == null) return "{\"kind\":\"unknown\",\"number\":" + p[2] + ",\"bytes\":" + p.Length + "}";
            var sb = new StringBuilder();
            sb.Append("{\"kind\":\"").Append(name).Append("\",\"bytes\":").Append(p.Length);
            var body = new StringBuilder();
            try
            {
                var r = new ByteReader(p.Slice(3));
                switch (p[2])
                {
                    case 1: Snapshot(ref r, body, baseline); break;
                    case 2: Input(ref r, body); break;
                    case 3: body.Append(",\"tick\":").Append(r.Var32()); Payload(body, "payload", r.Rest()); break;
                    default: Stream(ref r, body); break;
                }
                sb.Append(body);
            }
            catch (MalformedException e) { sb.Append(",\"error\":\"").Append(e.Message).Append('"'); }
            return sb.Append('}').ToString();
        }

        private static void Payload(StringBuilder sb, string key, ReadOnlySpan<byte> b)
        {
            sb.Append(",\"len\":").Append(b.Length).Append(",\"").Append(key).Append("\":\"");
            foreach (var x in b) sb.Append(x.ToString("x2"));
            sb.Append('"');
        }

        private static void Stream(ref ByteReader r, StringBuilder sb)
        {
            var tick = r.Var32();
            var stream = r.U8();
            if (stream == 0) throw new MalformedException("stream_0");
            var seq = r.Var32();
            if (seq == 0) throw new MalformedException("seq_0");
            sb.Append(",\"tick\":").Append(tick).Append(",\"stream\":").Append(stream).Append(",\"seq\":").Append(seq);
            Payload(sb, "payload", r.Rest());
        }

        private static void Input(ref ByteReader r, StringBuilder sb)
        {
            var ack = r.Var32(); var newest = r.Var32(); int n = r.U8();
            if (n > newest) throw new MalformedException("seq");
            sb.Append(",\"ack\":").Append(ack).Append(",\"newest\":").Append(newest).Append(",\"n\":").Append(n).Append(",\"inputs\":[");
            for (var i = 0; i < n; i++)
            {
                var view = r.Var(); var len = (int)Math.Min(r.Var(), int.MaxValue);
                sb.Append(i > 0 ? "," : "").Append("{\"seq\":").Append(newest - (uint)i).Append(",\"view256\":").Append(view);
                Payload(sb, "hex", r.Bytes(len));
                sb.Append('}');
            }
            sb.Append(']');
            if (r.Remaining != 0) throw new MalformedException("trailing");
        }

        private static void Snapshot(ref ByteReader r, StringBuilder sb, World? baseline)
        {
            var tick = r.Var32(); var back = r.Var32(); var last = r.Var32();
            if (tick == 0 || back > tick) throw new MalformedException("tick");
            var count = r.Var();
            sb.Append(",\"tick\":").Append(tick).Append(",\"back\":").Append(back).Append(",\"baselineTick\":").Append(back == 0 ? 0 : tick - back)
              .Append(",\"lastInput\":").Append(last).Append(",\"count\":").Append(count).Append(",\"records\":[");
            uint prev = 0;
            var truncated = false;
            for (ulong n = 0; n < count && !truncated; n++)
            {
                var head = r.Var();
                var delta = head >> 2;
                if (delta == 0 || prev + delta > uint.MaxValue) throw new MalformedException("id");
                var id = (uint)(prev + delta);
                prev = id;
                sb.Append(n > 0 ? "," : "").Append("{\"id\":").Append(id);
                switch ((int)(head & 3))
                {
                    case Proto.OpFull:
                    {
                        var type = r.Var(); var owner = r.Var(); var len = r.Var();
                        if (type > ushort.MaxValue || owner > int.MaxValue || len > Proto.MaxStateBytes) throw new MalformedException("full");
                        sb.Append(",\"op\":\"full\",\"type\":").Append(type).Append(",\"owner\":").Append(owner);
                        Payload(sb, "state", r.Bytes((int)len));
                        break;
                    }
                    case Proto.OpDespawn: sb.Append(",\"op\":\"despawn\""); break;
                    case Proto.OpDelta:
                    {
                        sb.Append(",\"op\":\"delta\"");
                        var at = baseline?.IndexOf(id) ?? -1;
                        if (baseline == null) { sb.Append(",\"unknown\":true"); truncated = true; break; }
                        if (at < 0) throw new MalformedException("delta");
                        var len = baseline.Ents[at].State.Length;
                        var mask = r.Bytes((len + 7) >> 3).ToArray();
                        var vals = new StringBuilder();
                        sb.Append(",\"changed\":[");
                        var first = true;
                        for (var k = 0; k < len; k++)
                            if ((mask[k >> 3] >> (k & 7) & 1) != 0) { sb.Append(first ? "" : ",").Append(k); first = false; vals.Append(r.U8().ToString("x2")); }
                        sb.Append("],\"values\":\"").Append(vals).Append('"');
                        break;
                    }
                    default: throw new MalformedException("op");
                }
                sb.Append('}');
            }
            sb.Append(']');
            if (truncated) sb.Append(",\"truncated\":true");
            else if (r.Remaining != 0) throw new MalformedException("trailing");
        }
    }
}
