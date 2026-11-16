using Godot;

namespace OneLobby.Godot
{
    /// <summary>
    /// Where a Godot C# game keeps the player's saved multiplayer settings (name, relay line, last code, lobby server;
    /// spec/settings.md): a JSON file under <c>user://</c>, the same <c>user://onelobby.json</c> the GDScript client uses by
    /// default, so a project that mixes both shares one settings entry per game id.
    /// <code>
    /// var config = new OneLobbyConfig("com.you.game", "1", new Uri("wss://lobby.example.org/ws")).WithUserSettings();
    /// var client = new LobbyClient(config, new GodotTransport());
    /// </code>
    /// </summary>
    public static class GodotSettings
    {
        /// <summary>The default settings file.</summary>
        public const string DefaultFile = "user://onelobby.json";

        /// <summary>A key/value store over a JSON file under <c>user://</c> (or any Godot path).</summary>
        public static IKeyValueStore UserStore(string path = DefaultFile) => KeyValueStores.FromFile(ProjectSettings.GlobalizePath(path));

        /// <summary>The config with <see cref="UserStore"/> as its settings store, unless it already names a store or a file.</summary>
        public static OneLobbyConfig WithUserSettings(this OneLobbyConfig config) =>
            config.SettingsStore == null && config.SettingsFile == null ? config with { SettingsStore = UserStore() } : config;
    }
}
