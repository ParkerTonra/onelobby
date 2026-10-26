#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using NUnit.Framework;
using UnityEngine.TestTools;

namespace OneLobby.Unity.Tests
{
    /// <summary>
    /// ogc1 (docs/recipes/game-console.md) over real loopback HTTP on port 47833: health without a token, 401 without
    /// one, /info and /cmd through the main-thread pump, the size and method guards, and the token file's life cycle.
    /// </summary>
    public sealed class GameConsoleServerTests
    {
        private const int Port = 47833;
        private const int TimeoutMs = 10000;

        private static IEnumerator Await(Task t, Action pump, string what)
        {
            var start = DateTime.UtcNow;
            while (!t.IsCompleted)
            {
                pump();
                if ((DateTime.UtcNow - start).TotalMilliseconds > TimeoutMs) Assert.Fail("timed out: " + what);
                yield return null;
            }
            if (t.IsFaulted) throw t.Exception!.GetBaseException();
        }

        private static async Task<(int status, string body)> Send(HttpClient http, HttpMethod method, string path, string? token = null, string? body = null)
        {
            var req = new HttpRequestMessage(method, "http://127.0.0.1:" + Port + path);
            if (token != null) req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + token);
            if (body != null) req.Content = new StringContent(body, Encoding.UTF8, "application/json");
            using var res = await http.SendAsync(req);
            return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
        }

        [Test]
        public void PortFromArgsReadsTheFlagOnly()
        {
            Assert.AreEqual(47820, GameConsoleServer.PortFromArgs(new[] { "game.exe", "--console-port=47820" }));
            Assert.IsNull(GameConsoleServer.PortFromArgs(new[] { "game.exe" }));
            Assert.IsNull(GameConsoleServer.PortFromArgs(new[] { "--console-port=abc" }));
            Assert.IsNull(GameConsoleServer.PortFromArgs(new[] { "--console-port=70000" }));
            Assert.IsNull(GameConsoleServer.PortFromArgs(new[] { "--console-port=-1" }));
        }

        [UnityTest]
        public IEnumerator ServesOgc1OnLoopbackWithATokenFile()
        {
            string tokenPath = Path.Combine(Path.GetTempPath(), "onelobby-console-test", "console-" + Port + ".token");
            var logs = new List<string>();
            var ran = new List<string>();
            var server = GameConsoleServer.Start(Port, tokenPath,
                line =>
                {
                    ran.Add(line);
                    return line == "round 10" ? (true, new[] { "round 10 in 1 s" }) : (false, new[] { "unknown: " + line });
                },
                () => "{\"proto\":\"ogc1\",\"game\":\"com.onelobby.unitytest\",\"netVersion\":\"1\",\"role\":\"solo\",\"commands\":[]}",
                logs.Add);
            Assert.IsNotNull(server, "server started");
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            try
            {
                Assert.IsTrue(File.Exists(tokenPath), "token file written");
                string token = File.ReadAllText(tokenPath);
                Assert.AreEqual(32, token.Length);
                Assert.AreEqual(1, logs.Count);
                StringAssert.Contains(tokenPath, logs[0]);
                Assert.IsFalse(logs[0].Contains(token), "the log never holds the token");

                var health = Send(http, HttpMethod.Get, "/healthz");
                yield return Await(health, () => server!.Pump(), "healthz");
                Assert.AreEqual((200, "ok"), health.Result);

                var noToken = Send(http, HttpMethod.Get, "/info");
                yield return Await(noToken, () => server!.Pump(), "info without token");
                Assert.AreEqual(401, noToken.Result.status);

                var badToken = Send(http, HttpMethod.Get, "/info", new string('0', 32));
                yield return Await(badToken, () => server!.Pump(), "info with a wrong token");
                Assert.AreEqual(401, badToken.Result.status);

                var info = Send(http, HttpMethod.Get, "/info", token);
                yield return Await(info, () => server!.Pump(), "info");
                Assert.AreEqual(200, info.Result.status);
                StringAssert.Contains("\"proto\":\"ogc1\"", info.Result.body);

                var cmd = Send(http, HttpMethod.Post, "/cmd", token, "{\"line\":\"round 10\"}");
                yield return Await(cmd, () => server!.Pump(), "cmd");
                Assert.AreEqual(200, cmd.Result.status);
                StringAssert.Contains("\"ok\":true", cmd.Result.body);
                StringAssert.Contains("round 10 in 1 s", cmd.Result.body);

                var refused = Send(http, HttpMethod.Post, "/cmd", token, "{\"line\":\"fly\"}");
                yield return Await(refused, () => server!.Pump(), "refused cmd");
                Assert.AreEqual(200, refused.Result.status, "a refused command is still 200");
                StringAssert.Contains("\"ok\":false", refused.Result.body);
                CollectionAssert.AreEqual(new[] { "round 10", "fly" }, ran);

                var big = Send(http, HttpMethod.Post, "/cmd", token, "{\"line\":\"" + new string('x', 5000) + "\"}");
                yield return Await(big, () => server!.Pump(), "big body");
                Assert.AreEqual(413, big.Result.status);

                var longLine = Send(http, HttpMethod.Post, "/cmd", token, "{\"line\":\"" + new string('x', 201) + "\"}");
                yield return Await(longLine, () => server!.Pump(), "long line");
                Assert.AreEqual(400, longLine.Result.status);

                var options = Send(http, HttpMethod.Options, "/cmd", token);
                yield return Await(options, () => server!.Pump(), "options");
                Assert.AreEqual(403, options.Result.status);

                var missing = Send(http, HttpMethod.Get, "/nope", token);
                yield return Await(missing, () => server!.Pump(), "404");
                Assert.AreEqual(404, missing.Result.status);

                var busy = Send(http, HttpMethod.Post, "/cmd", token, "{\"line\":\"round 10\"}");
                yield return Await(busy, () => { }, "unpumped cmd");   // nobody pumps: the 2 s wait runs out
                Assert.AreEqual(504, busy.Result.status);
            }
            finally
            {
                server!.Stop();
            }
            Assert.IsFalse(File.Exists(tokenPath), "Stop deletes the token file");
            Assert.IsFalse(server.Running);
        }
    }
}
