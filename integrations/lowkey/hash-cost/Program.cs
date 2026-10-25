// Measures Simulation.StateHash() (= FNV-1a over Save()) on a bot-driven unplug game, like UnplugBotTests.Play.
// usage: dotnet run -c Release -- [seed] [samples]
using System.Diagnostics;
using System.Text;
using LowkeyIndustries.Bot;
using LowkeyIndustries.Sim;
using LowkeyIndustries.Sim.Content;
using LowkeyIndustries.Sim.Core;

ulong seed = args.Length > 0 ? ulong.Parse(args[0]) : 20261011UL;
int samples = args.Length > 1 ? int.Parse(args[1]) : 101;
string repo = Environment.GetEnvironmentVariable("LOWKEY_REPO") ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../../Lowkey"));
var content = ContentDb.LoadDirectory(Path.Combine(repo, "game", "data"), "unplug");
var sim = Simulation.NewGame(content, seed);
var bot = new UnplugBot();
int[] days = { 1, 15, 30 };
Console.WriteLine($"seed {seed}, scenario unplug, {samples} samples each, Release, {Environment.ProcessorCount} cores");
Console.WriteLine("| point | tick | save bytes | StateHash ms (median) | min | p95 | Save() only ms | Fnv1a only ms | Tick ms (median of 200) |");
Console.WriteLine("|---|---|---|---|---|---|---|---|---|");

static double Median(List<double> v) { v.Sort(); return v[v.Count / 2]; }
static double Time(Func<object?> f, int n, out double min, out double p95)
{
    for (int i = 0; i < 5; i++) f(); // warm up
    var t = new List<double>();
    for (int i = 0; i < n; i++) { long a = Stopwatch.GetTimestamp(); f(); t.Add(Stopwatch.GetElapsedTime(a).TotalMilliseconds); }
    t.Sort(); min = t[0]; p95 = t[(int)(t.Count * 0.95)];
    return t[t.Count / 2];
}

foreach (int day in days)
{
    // end of day N: first tick where the clock reads 23:00 on that day
    while (!(sim.Day == day && sim.Hour >= 23)) { bot.Step(sim); sim.Tick(); }
    string saved = sim.Save();
    int bytes = Encoding.UTF8.GetByteCount(saved);
    double hash = Time(() => sim.StateHash(), samples, out var min, out var p95);
    double save = Time(() => sim.Save(), samples, out _, out _);
    double fnv = Time(() => Hashing.Fnv1a(saved), samples, out _, out _);
    // cost of a normal tick at this point (bot not stepped, state not mutated by us beyond ticking forward 200 ticks)
    var tt = new List<double>();
    for (int i = 0; i < 200; i++) { long a = Stopwatch.GetTimestamp(); sim.Tick(); tt.Add(Stopwatch.GetElapsedTime(a).TotalMilliseconds); }
    Console.WriteLine($"| end of day {day} | {sim.State.Tick} | {bytes:N0} | {hash:F2} | {min:F2} | {p95:F2} | {save:F2} | {fnv:F2} | {Median(tt):F3} |");
}
