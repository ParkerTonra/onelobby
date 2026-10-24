using OneLobby.Server;

if (args.Contains("--help") || args.Contains("-h"))
{
    Console.WriteLine(ServerOptions.Help);
    return 0;
}

ServerOptions options;
try { options = ServerOptions.Parse(args, Environment.GetEnvironmentVariable); }
catch (ArgumentException e)
{
    Console.Error.WriteLine("onelobby-server: " + e.Message);
    Console.Error.WriteLine("try --help");
    return 2;
}

var app = ServerApp.Build(options);
app.Logger.LogInformation("onelobby-server listening on {Url} (turn {Turn}, games {Games})",
    options.ListenUrl(), options.TurnUrls.Count > 0 && options.TurnSecret.Length > 0 ? "on" : "off",
    options.AllowedGames.Count == 0 ? "any" : string.Join(",", options.AllowedGames));
await app.RunAsync();
return 0;
