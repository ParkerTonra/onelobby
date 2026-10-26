#nullable enable
using System;
using System.Collections.Concurrent;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// "OneLobby game console v1" (<c>ogc1</c>, docs/recipes/game-console.md): a loopback-only, token-authenticated HTTP
    /// door into the game's own dev console, so a local tool can send <c>round 10</c> to a running game. The game keeps its
    /// command set: this class only carries a line in (<c>run</c>) and lines out, plus the <c>/info</c> body (<c>info</c>).
    /// Bound to <c>127.0.0.1</c> only; the per-process token lives in a file and is never logged; no CORS headers, ever.
    /// Open it only behind a flag (<see cref="PortFromArgs"/> reads <c>--console-port=N</c>).
    /// <para>Requests land on pool threads; call <see cref="Pump"/> every frame on the main thread to run them.</para>
    /// </summary>
    public sealed class GameConsoleServer : IDisposable
    {
        public const int MaxBody = 4096, MaxLine = 200, MaxLines = 50, MaxLineChars = 400;
        public const int ReplyWaitMs = 2000;
        /// <summary>Game consoles start here, above OneLobby direct-IP hosting (47810-47819).</summary>
        public const int DefaultPort = 47820;

        [Serializable] private class CmdRequest { public string? line; }
        [Serializable] private class CmdReply { public bool ok; public string[]? lines; public int ms; }
        [Serializable] private class ErrReply { public bool ok; public string? error; }

        private sealed class Pending
        {
            public bool IsInfo;
            public string Line = "";
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
            public volatile bool Abandoned;
            public bool Ok;
            public string[]? Lines;
            public string? Info;
            public int Ms;
        }

        private HttpListener? _listener;
        private readonly ConcurrentQueue<Pending> _queue = new ConcurrentQueue<Pending>();
        private Func<string, (bool ok, string[] lines)> _run = _ => (false, Array.Empty<string>());
        private Func<string> _info = () => "{}";
        private Action<string> _log = _ => { };
        private string _token = "";

        public int Port { get; private set; }
        /// <summary>Where the token is written (the path is logged; the token never is).</summary>
        public string TokenPath { get; private set; } = "";
        public bool Running => _listener != null && _listener.IsListening;

        /// <summary>
        /// <c>Application.persistentDataPath/onelobby-console/console-PORT.token</c>: the user's own app-data folder, one file
        /// per port so a host and a joiner on one machine do not clash. Main thread only (it reads a Unity property).
        /// </summary>
        public static string DefaultTokenPath(int port) =>
            Path.Combine(Application.persistentDataPath, "onelobby-console", "console-" + port.ToString(CultureInfo.InvariantCulture) + ".token");

        /// <summary>The port from <c>--console-port=N</c> on the command line, or null when the flag is absent or bad (console off).</summary>
        public static int? PortFromArgs(string[]? args = null)
        {
            const string flag = "--console-port=";
            foreach (var a in args ?? Environment.GetCommandLineArgs())
            {
                if (a == null || !a.StartsWith(flag, StringComparison.Ordinal)) continue;
                if (int.TryParse(a.Substring(flag.Length), NumberStyles.None, CultureInfo.InvariantCulture, out int p) && p > 0 && p < 65536) return p;
                return null;
            }
            return null;
        }

        /// <summary>Open the door on <c>127.0.0.1:port</c> with the token at <see cref="DefaultTokenPath"/>. Main thread.</summary>
        public static GameConsoleServer? Start(int port, Func<string, (bool ok, string[] lines)> run, Func<string> info, Action<string>? log = null) =>
            Start(port, DefaultTokenPath(port), run, info, log);

        /// <summary>
        /// Open the door on <c>127.0.0.1:port</c>. Returns null when the port is busy or the token file cannot be written
        /// (logged, no retry). <paramref name="run"/> runs one command line; <paramref name="info"/> returns the <c>/info</c>
        /// JSON body. Both run on the thread that calls <see cref="Pump"/>.
        /// </summary>
        public static GameConsoleServer? Start(int port, string tokenPath, Func<string, (bool ok, string[] lines)> run, Func<string> info, Action<string>? log = null)
        {
            var s = new GameConsoleServer { Port = port, TokenPath = tokenPath, _run = run, _info = info, _log = log ?? (_ => { }) };
            byte[] raw = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(raw);
            var sb = new StringBuilder(32);
            foreach (byte b in raw) sb.Append(b.ToString("x2"));
            s._token = sb.ToString();
            try
            {
                s._listener = new HttpListener();
                s._listener.Prefixes.Add("http://127.0.0.1:" + port + "/");  // never + or * or localhost (::1)
                s._listener.Start();
            }
            catch (Exception)
            {
                s._log("[console] port " + port + " busy; console server off");
                s._listener = null;
                return null;
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(tokenPath) ?? ".");
                File.WriteAllText(tokenPath, s._token);
            }
            catch (Exception e)
            {
                s._log("[console] cannot write the token file (" + e.GetType().Name + "); console server off");
                s.Stop();
                return null;
            }
            s._listener.BeginGetContext(s.OnContext, null);
            s._log("[console] listening http://127.0.0.1:" + port + " token file " + tokenPath);
            return s;
        }

        /// <summary>Close the port and delete the token file. Safe to call twice.</summary>
        public void Stop()
        {
            var l = _listener;
            _listener = null;
            try { l?.Stop(); l?.Close(); } catch { }
            try { if (TokenPath.Length > 0 && File.Exists(TokenPath)) File.Delete(TokenPath); } catch { }
        }

        public void Dispose() => Stop();

        /// <summary>Main thread, every frame: run up to <paramref name="max"/> queued requests.</summary>
        public void Pump(int max = 20)
        {
            while (max-- > 0 && _queue.TryDequeue(out var p))
            {
                if (p.Abandoned) continue;
                var sw = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    if (p.IsInfo) p.Info = _info();
                    else
                    {
                        var (ok, lines) = _run(p.Line);
                        p.Ok = ok;
                        p.Lines = Clip(lines);
                    }
                }
                catch (Exception e)
                {
                    p.Ok = false;
                    p.Lines = new[] { e.Message };
                    p.Info = null;
                }
                p.Ms = (int)sw.ElapsedMilliseconds;
                p.Done.Set();
            }
        }

        private static string[] Clip(string[]? lines)
        {
            lines ??= Array.Empty<string>();
            int n = Math.Min(lines.Length, MaxLines);
            var o = new string[n];
            for (int i = 0; i < n; i++)
            {
                string l = lines[i] ?? "";
                o[i] = l.Length > MaxLineChars ? l.Substring(0, MaxLineChars - 1) + "…" : l;
            }
            return o;
        }

        // ---------------------------------------------------------------- pool threads

        private void OnContext(IAsyncResult ar)
        {
            var l = _listener;
            if (l == null) return;
            HttpListenerContext ctx;
            try { ctx = l.EndGetContext(ar); }
            catch { return; }  // stopped
            try { l.BeginGetContext(OnContext, null); } catch { }
            try { Handle(ctx); }
            catch (Exception)
            {
                try { Write(ctx, 500, Err("server error")); } catch { }
            }
        }

        private static string Err(string error) => JsonUtility.ToJson(new ErrReply { ok = false, error = error });

        private void Handle(HttpListenerContext ctx)
        {
            var req = ctx.Request;
            if (req.RemoteEndPoint == null || !IPAddress.IsLoopback(req.RemoteEndPoint.Address)) { Write(ctx, 403, Err("forbidden")); return; }
            if (string.Equals(req.HttpMethod, "OPTIONS", StringComparison.OrdinalIgnoreCase)) { Write(ctx, 403, Err("forbidden")); return; }
            string path = req.Url.AbsolutePath;
            bool get = string.Equals(req.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase);
            bool post = string.Equals(req.HttpMethod, "POST", StringComparison.OrdinalIgnoreCase);
            if (get && path == "/healthz") { Write(ctx, 200, "ok", "text/plain"); return; }
            if (!Authorised(req.Headers["Authorization"])) { Write(ctx, 401, Err("unauthorized")); return; }

            if (post && path == "/cmd")
            {
                string body = ReadBody(req, out bool tooBig);
                if (tooBig) { Write(ctx, 413, Err("body too large")); return; }
                CmdRequest? cr = null;
                try { cr = JsonUtility.FromJson<CmdRequest>(body); } catch { }
                if (cr == null || cr.line == null) { Write(ctx, 400, Err("bad request")); return; }
                if (cr.line.Length > MaxLine) { Write(ctx, 400, Err("line too long")); return; }
                var p = new Pending { Line = cr.line };
                _queue.Enqueue(p);
                if (!p.Done.Wait(ReplyWaitMs)) { p.Abandoned = true; Write(ctx, 504, Err("game thread busy")); return; }
                Write(ctx, 200, JsonUtility.ToJson(new CmdReply { ok = p.Ok, lines = p.Lines ?? Array.Empty<string>(), ms = p.Ms }));
                return;
            }
            if (get && path == "/info")
            {
                var p = new Pending { IsInfo = true };
                _queue.Enqueue(p);
                if (!p.Done.Wait(ReplyWaitMs)) { p.Abandoned = true; Write(ctx, 504, Err("game thread busy")); return; }
                if (p.Info == null) { Write(ctx, 500, Err("info failed")); return; }
                Write(ctx, 200, p.Info);
                return;
            }
            Write(ctx, 404, Err("not found"));
        }

        private bool Authorised(string? header)
        {
            const string prefix = "Bearer ";
            if (header == null || !header.StartsWith(prefix, StringComparison.Ordinal)) return false;
            string given = header.Substring(prefix.Length).Trim();
            // Constant-time compare over the token's length.
            int diff = given.Length ^ _token.Length;
            for (int i = 0; i < _token.Length; i++) diff |= (i < given.Length ? given[i] : '\0') ^ _token[i];
            return diff == 0;
        }

        private static string ReadBody(HttpListenerRequest req, out bool tooBig)
        {
            tooBig = false;
            if (!req.HasEntityBody) return "";
            if (req.ContentLength64 > MaxBody) { Drain(req); tooBig = true; return ""; }
            using (var ms = new MemoryStream())
            {
                var buf = new byte[1024];
                int n;
                while ((n = req.InputStream.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > MaxBody) { Drain(req); tooBig = true; return ""; }
                }
                return Encoding.UTF8.GetString(ms.ToArray());
            }
        }

        private static void Drain(HttpListenerRequest req)
        {
            try
            {
                var buf = new byte[4096];
                long total = 0;
                while (total < (1 << 20) && req.InputStream.Read(buf, 0, buf.Length) is int n && n > 0) total += n;
            }
            catch { }
        }

        private static void Write(HttpListenerContext ctx, int status, string body, string type = "application/json")
        {
            var bytes = Encoding.UTF8.GetBytes(body ?? "");
            var res = ctx.Response;
            res.StatusCode = status;
            res.ContentType = type + "; charset=utf-8";
            res.ContentLength64 = bytes.Length;
            // No Access-Control-Allow-Origin, ever: a web page cannot read a reply, and preflights get 403.
            res.OutputStream.Write(bytes, 0, bytes.Length);
            res.OutputStream.Close();
        }
    }
}
