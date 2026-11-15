using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace OneLobby
{
    /// <summary>
    /// A tiny synchronous key/value store for what a client keeps on the player's machine: the per-install player id and the
    /// host's ban list (spec/room.md s.1 and s.5.3). Implement it over PlayerPrefs, a settings file or anything else.
    /// </summary>
    public interface IKeyValueStore
    {
        string? GetItem(string key);
        void SetItem(string key, string value);
        void RemoveItem(string key);
    }

    /// <summary>The stores the kit ships: memory (the process) and one JSON file.</summary>
    public static class KeyValueStores
    {
        private sealed class MemoryStore : IKeyValueStore
        {
            private readonly Dictionary<string, string> _m = new();
            public string? GetItem(string key) => _m.TryGetValue(key, out var v) ? v : null;
            public void SetItem(string key, string value) => _m[key] = value;
            public void RemoveItem(string key) => _m.Remove(key);
        }

        private sealed class FileStore : IKeyValueStore
        {
            private readonly string _path;
            private Dictionary<string, string> _d = new();
            public FileStore(string path)
            {
                _path = path;
                try
                {
                    using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(path));
                    if (doc.RootElement.ValueKind == JsonValueKind.Object)
                        foreach (var p in doc.RootElement.EnumerateObject())
                            if (p.Value.ValueKind == JsonValueKind.String) _d[p.Name] = p.Value.GetString()!;
                }
                catch (Exception) { _d = new Dictionary<string, string>(); }
            }
            public string? GetItem(string key) => _d.TryGetValue(key, out var v) ? v : null;
            public void SetItem(string key, string value) { _d[key] = value; Flush(); }
            public void RemoveItem(string key) { _d.Remove(key); Flush(); }
            private void Flush()
            {
                var dir = Path.GetDirectoryName(Path.GetFullPath(_path));
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                System.IO.File.WriteAllText(_path, JsonSerializer.Serialize(_d));
            }
        }

        /// <summary>Keeps values for the life of the process.</summary>
        public static IKeyValueStore Memory() => new MemoryStore();

        /// <summary>A JSON file <c>{ key: value }</c> at <paramref name="path"/>: read once, written on every change. A missing or corrupt file reads as empty.</summary>
        public static IKeyValueStore FromFile(string path) => new FileStore(path ?? throw new ArgumentNullException(nameof(path)));

        /// <summary>The store key of a game's player id (same as JS).</summary>
        public static string PlayerIdKey(string gameId) => "onelobby.pid." + gameId;
        /// <summary>The store key of a game's ban list (same as JS).</summary>
        public static string BansKey(string gameId) => "onelobby.bans." + gameId;

        /// <summary>
        /// This install's player id for <paramref name="gameId"/>: read from the store, else made (32 hex characters from the
        /// CSPRNG) and saved. A store that cannot save still returns a fresh id, so the id then lasts one session. It is not an
        /// account or a hardware id (spec/room.md s.1).
        /// </summary>
        public static string LoadPlayerId(IKeyValueStore? store, string gameId)
        {
            var key = PlayerIdKey(gameId);
            try { var have = store?.GetItem(key); if (RoomRules.IsPlayerId(have)) return have!; }
            catch (Exception) { /* unreadable: make a new one */ }
            var id = RoomRules.NewPlayerId();
            try { store?.SetItem(key, id); } catch (Exception) { /* not saved */ }
            return id;
        }
    }

    /// <summary>
    /// The host's ban list: survives the lobby because it is saved in an <see cref="IKeyValueStore"/>. Entries are keyed by the
    /// player id, with the address as the fallback (spec/room.md s.5.3). A corrupt store loads as empty and is only overwritten
    /// by the next change.
    /// </summary>
    public sealed class BanList
    {
        /// <summary>At most this many entries are kept; the oldest goes first.</summary>
        public const int MaxBans = 1000;
        /// <summary>The hub holds at most this many player ids per lobby.</summary>
        public const int HubBanIds = 256;

        private readonly IKeyValueStore? _store;
        private readonly string _key;
        private List<BanEntry> _entries = new();

        public event Action? Changed;

        public BanList(IKeyValueStore? store, string gameId)
        {
            _store = store;
            _key = KeyValueStores.BansKey(gameId);
            Reload();
        }

        /// <summary>Reads the store again.</summary>
        public void Reload()
        {
            _entries = new List<BanEntry>();
            string? text;
            try { text = _store?.GetItem(_key); } catch (Exception) { return; }
            if (string.IsNullOrEmpty(text)) return;
            try
            {
                using var doc = JsonDocument.Parse(text!);
                if (!doc.RootElement.TryGetProperty("bans", out var list) || list.ValueKind != JsonValueKind.Array) return;
                foreach (var o in list.EnumerateArray())
                {
                    if (o.ValueKind != JsonValueKind.Object) continue;
                    var id = Signaling.Str(o, "id");
                    var ip = Signaling.Str(o, "ip");
                    if (!RoomRules.IsPlayerId(id)) id = "";
                    if (id.Length == 0 && ip.Length == 0) continue;
                    var at = o.TryGetProperty("at", out var a) && a.ValueKind == JsonValueKind.Number && a.TryGetInt64(out var l) ? l : 0;
                    _entries.Add(new BanEntry(id.Length > 0 ? id : null, ip.Length > 0 ? RoomRules.NormalizeIp(ip) : null,
                        Opt(o, "name"), Opt(o, "reason"), Opt(o, "code"), at));
                }
                if (_entries.Count > MaxBans) _entries.RemoveRange(0, _entries.Count - MaxBans);
            }
            catch (Exception) { _entries = new List<BanEntry>(); }
        }

        private static string? Opt(JsonElement o, string k) => o.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        public IReadOnlyList<BanEntry> List() => _entries.ToArray();
        public int Count => _entries.Count;

        /// <summary>The entry that bans this id and/or address, if any.</summary>
        public BanEntry? Match(string? id, string? ip)
        {
            foreach (var e in _entries) if (RoomRules.BanMatches(e, id, ip)) return e;
            return null;
        }

        /// <summary>Adds a ban for a player id and/or an address. A loopback address is never stored. Throws when neither is usable.</summary>
        public BanEntry Add(string? id = null, string? ip = null, string? name = null, string? reason = null, string? code = null, long? at = null)
        {
            var pid = RoomRules.IsPlayerId(id) ? id : null;
            var addr = string.IsNullOrEmpty(ip) ? null : RoomRules.NormalizeIp(ip);
            if (addr != null && RoomRules.IsLoopbackIp(addr)) addr = null;
            if (pid == null && addr == null) throw new ArgumentException("a ban needs a player id or an address");
            var entry = new BanEntry(pid, addr, string.IsNullOrEmpty(name) ? null : name, string.IsNullOrEmpty(reason) ? null : reason,
                string.IsNullOrEmpty(code) ? null : code, at ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            // one entry per id (or per address when it has no id): a new ban replaces the old
            _entries.RemoveAll(x => pid != null ? x.Id == pid : x.Id == null && x.Ip == addr);
            _entries.Add(entry);
            if (_entries.Count > MaxBans) _entries.RemoveRange(0, _entries.Count - MaxBans);
            Save();
            return entry;
        }

        /// <summary>Unban by player id or address; returns how many entries went.</summary>
        public int Remove(string idOrIp) => RoomRules.IsPlayerId(idOrIp) ? Remove(idOrIp, null) : Remove(null, idOrIp);

        /// <summary>Unban every entry with this id or this address.</summary>
        public int Remove(string? id, string? ip)
        {
            var addr = string.IsNullOrEmpty(ip) ? null : RoomRules.NormalizeIp(ip);
            var n = _entries.RemoveAll(e => (!string.IsNullOrEmpty(id) && e.Id == id) || (addr != null && e.Ip == addr));
            if (n > 0) Save();
            return n;
        }

        public void Clear()
        {
            if (_entries.Count == 0) return;
            _entries.Clear();
            Save();
        }

        /// <summary>The newest player ids, for the hub's <c>bans</c> message.</summary>
        public IReadOnlyList<string> HubIds()
        {
            var ids = new List<string>();
            foreach (var e in _entries) if (e.Id != null) ids.Add(e.Id);
            if (ids.Count > HubBanIds) ids.RemoveRange(0, ids.Count - HubBanIds);
            return ids;
        }

        private void Save()
        {
            try
            {
                var text = Signaling.Build(w =>
                {
                    w.WriteNumber("v", 1);
                    w.WriteStartArray("bans");
                    foreach (var e in _entries)
                    {
                        w.WriteStartObject();
                        if (e.Id != null) w.WriteString("id", e.Id);
                        if (e.Ip != null) w.WriteString("ip", e.Ip);
                        if (e.Name != null) w.WriteString("name", e.Name);
                        if (e.Reason != null) w.WriteString("reason", e.Reason);
                        if (e.Code != null) w.WriteString("code", e.Code);
                        w.WriteNumber("at", e.At);
                        w.WriteEndObject();
                    }
                    w.WriteEndArray();
                });
                _store?.SetItem(_key, text);
            }
            catch (Exception) { /* a store that cannot save: the list lasts this session */ }
            Changed?.Invoke();
        }
    }
}
