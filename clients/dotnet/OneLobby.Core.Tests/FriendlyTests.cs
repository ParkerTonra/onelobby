using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>Friendly.DescribeError and InviteLink against spec/vectors/describe-error.json and invite-link.json.</summary>
    public class FriendlyTests
    {
        private static FriendlyError Describe(JsonElement input)
        {
            if (input.ValueKind == JsonValueKind.Null) return Friendly.DescribeError((string?)null);
            if (input.ValueKind == JsonValueKind.String) return Friendly.DescribeError(input.GetString());
            string? S(string n) => input.TryGetProperty(n, out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
            Dictionary<string, object?>? data = null;
            if (input.TryGetProperty("data", out var d) && d.ValueKind == JsonValueKind.Object)
                data = d.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
            return Friendly.DescribeError(S("code"), data, S("message"), S("name"));
        }

        [Fact]
        public void DescribeErrorMatchesTheSharedVectors()
        {
            using var doc = Spec.Load("vectors/describe-error.json");
            var cases = doc.RootElement.GetProperty("cases").EnumerateArray().ToList();
            Assert.True(cases.Count > 60);
            foreach (var c in cases)
            {
                var want = c.GetProperty("expect");
                var got = Describe(c.GetProperty("input"));
                var name = c.GetProperty("name").GetString();
                Assert.True(want.GetProperty("code").GetString() == got.Code, name + ": code");
                Assert.True(want.GetProperty("message").GetString() == got.Message, name + ": message");
                Assert.True((want.TryGetProperty("hint", out var h) ? h.GetString() : null) == got.Hint, name + ": hint");
            }
        }

        [Fact]
        public void EveryErrorCodeHasFriendlyText()
        {
            var generic = Friendly.DescribeError((string?)null).Message;
            foreach (var f in typeof(LobbyErrorCodes).GetFields().Where(f => f.IsLiteral))
            {
                var code = (string)f.GetRawConstantValue()!;
                Assert.True(Friendly.DescribeError(code).Message != generic, code);
            }
        }

        [Fact]
        public void ExceptionsAndLobbyErrors()
        {
            var e = new OneLobbyException("lobby_full", "technical detail");
            Assert.Equal("That lobby is full.", Friendly.DescribeError(e).Message);
            Assert.Equal("lobby_full", Friendly.DescribeError(new LobbyError("lobby_full", "x")).Code);
            Assert.Equal("timeout", Friendly.DescribeError(new TimeoutException("x")).Code);
            Assert.Equal("unknown", Friendly.DescribeError(new InvalidOperationException("stack at foo.cs:12")).Code);
            Assert.Equal("unknown", Friendly.DescribeError((Exception?)null).Code);
        }

        [Fact]
        public void IceFailedMessagesMatchTheSharedVectors()
        {
            using var doc = Spec.Load("vectors/describe-error.json");
            var mine = doc.RootElement.GetProperty("iceFailedMessages").EnumerateArray()
                .Where(m => !m.TryGetProperty("clients", out var cl) || cl.EnumerateArray().Any(x => x.GetString() == "csharp")).ToList();
            Assert.Equal(3, mine.Count);
            foreach (var m in mine)
                Assert.Equal(m.GetProperty("message").GetString(), Lobby.IceFailedMessage(m.GetProperty("relayConfigured").GetBoolean()));
        }

        [Fact]
        public void InviteLinkMakeMatchesTheSharedVectors()
        {
            using var doc = Spec.Load("vectors/invite-link.json");
            foreach (var c in doc.RootElement.GetProperty("make").EnumerateArray())
            {
                var name = c.GetProperty("name").GetString();
                var code = c.GetProperty("code").GetString()!;
                var b = c.GetProperty("base").GetString()!;
                var param = c.TryGetProperty("param", out var p) ? p.GetString()! : "join";
                if (c.TryGetProperty("error", out _)) Assert.Throws<ArgumentException>(() => InviteLink.Make(code, b, param));
                else Assert.True(c.GetProperty("url").GetString() == InviteLink.Make(code, b, param), name);
            }
        }

        [Fact]
        public void InviteLinkParseMatchesTheSharedVectors()
        {
            using var doc = Spec.Load("vectors/invite-link.json");
            var cases = doc.RootElement.GetProperty("parse").EnumerateArray().ToList();
            Assert.True(cases.Count > 30);
            foreach (var c in cases)
            {
                var param = c.TryGetProperty("param", out var p) ? p.GetString()! : "join";
                var want = c.GetProperty("code").ValueKind == JsonValueKind.Null ? null : c.GetProperty("code").GetString();
                Assert.True(want == InviteLink.Parse(c.GetProperty("input").GetString(), param), c.GetProperty("name").GetString());
            }
            Assert.Null(InviteLink.Parse(null));
        }
    }
}
