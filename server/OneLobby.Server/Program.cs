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
// one plain stdout line, the same shape as the direct hosts', so tools (olc) parse every hub alike
Console.WriteLine(options.StartupLine());
await app.RunAsync();
return 0;
