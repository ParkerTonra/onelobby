#nullable enable
using UnityEngine;

namespace OneLobby.Unity
{
    /// <summary>
    /// An <see cref="IKeyValueStore"/> over Unity's <see cref="PlayerPrefs"/>: the default place for the player's saved
    /// multiplayer settings (name, relay line, last code, lobby server; spec/settings.md). <see cref="OneLobbyRunner"/> uses it
    /// unless <c>OneLobbyConfig.SettingsStore</c> or <c>SettingsFile</c> is set. Values are saved on every write.
    /// </summary>
    public sealed class PlayerPrefsStore : IKeyValueStore
    {
        public string? GetItem(string key) => PlayerPrefs.HasKey(key) ? PlayerPrefs.GetString(key) : null;

        public void SetItem(string key, string value)
        {
            PlayerPrefs.SetString(key, value);
            PlayerPrefs.Save();
        }

        public void RemoveItem(string key)
        {
            PlayerPrefs.DeleteKey(key);
            PlayerPrefs.Save();
        }
    }
}
