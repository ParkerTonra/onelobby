using System;
using System.Net;
using OneLobby;
using OneLobby.Direct;
using OneLobby.Direct.Nostr;

namespace {{ns}};

/// <summary>
/// What the drop-in menu needs from <c>OneLobby.Direct</c>: how to host and join without a lobby server. The menu lives in
/// <c>OneLobby.Core</c>, which cannot reference that package, so the game passes these two functions. Written by create-onelobby;
/// yours to edit (it is not part of the pinned menu folder). Recipe: {{recipeUrl}}
/// </summary>
public static class OneLobbyNet
{
    /// <summary>The port a direct host listens on unless the blueprint says otherwise (hosting.directPort).</summary>
    public const int DefaultPort = DirectLobby.DefaultPort;

    /// <summary><c>--local</c> after <c>--</c>: host and join on 127.0.0.1 only, no Nostr, no router request. For tests and for two windows on one PC.</summary>
    public static bool IsLocal(string[] args) => Array.IndexOf(args, "--local") >= 0;

    /// <summary>Give the menu its direct route when <c>hosting.direct</c> is on; with <c>--local</c> also pick that route.</summary>
    public static void Wire(OneLobbyMenu menu, string[] args)
    {
        var client = menu.Client!;
        if (client.Blueprint is not { Hosting.Direct: true }) return;
        var local = IsLocal(args);
        if (local) menu.Route = MenuRoute.Direct;
        menu.HostDirect = password => client.HostDirectAsync(HostOptions(client, menu.Model?.NameText, password, local));
        menu.JoinDirect = (address, password) => client.JoinDirectAsync(address, password);
    }

    /// <summary>The blueprint's direct-hosting settings; <paramref name="local"/> listens on 127.0.0.1 only and turns Nostr and the router request off.</summary>
    public static DirectHostOptions HostOptions(LobbyClient client, string? playerName, string? password, bool local)
    {
        var options = client.Blueprint!.ToDirectHostOptions(null, string.IsNullOrEmpty(playerName) ? null : playerName);
        options.Password = password;
        if (local)
        {
            options.BindAddress = IPAddress.Loopback;
            options.Nostr = new NostrOptions { Enabled = false };
            options.OpenPort = false;
            options.PublicAddress = "127.0.0.1"; // the join code a local host shows must work on this PC: it carries this address, not the network one
        }
        return options;
    }
}
