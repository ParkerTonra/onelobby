using Godot;

namespace OneLobby.Godot
{
    /// <summary>
    /// Connection diagnostics on Godot (spec/diagnostics.md): <c>LobbyClient.NetLog</c>, <c>LobbyClient.CheckConnectionAsync</c>
    /// and <c>Lobby.PeerDiagnosis</c> are the same as in OneLobby.Core; this only picks the default log file under the
    /// project's <c>user://</c> folder.
    /// </summary>
    public static class GodotDiagnostics
    {
        /// <summary>The log file inside the project's user folder (<c>user://onelobby-netlog.txt</c>) as a real path.</summary>
        public static string DefaultLogPath => ProjectSettings.GlobalizePath("user://onelobby-netlog.txt");

        /// <summary>The config with the log saved at <paramref name="path"/> (default <see cref="DefaultLogPath"/>) on exit, on a crash and on <c>NetLog.Save()</c>.</summary>
        public static OneLobbyConfig WithNetLog(this OneLobbyConfig config, string? path = null) =>
            config with { Diagnostics = config.Diagnostics with { LogPath = path ?? DefaultLogPath } };
    }
}
