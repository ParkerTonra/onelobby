using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json.Serialization;
using LowkeyIndustries.Sim.Commands;
using Xunit.Abstractions;

namespace Keepalive.Lowkey.Tests;

public class CodecRoundTripTests
{
    private readonly ITestOutputHelper _out;
    public CodecRoundTripTests(ITestOutputHelper output) => _out = output;

    public static IReadOnlyList<Type> ConcreteCommandTypes { get; } =
        typeof(Command).Assembly.GetTypes()
            .Where(t => typeof(Command).IsAssignableFrom(t) && !t.IsAbstract)
            .OrderBy(t => t.FullName, StringComparer.Ordinal)
            .ToList();

    [Fact]
    public void Every_concrete_command_is_registered_with_a_discriminator()
    {
        var registered = typeof(Command).GetCustomAttributes<JsonDerivedTypeAttribute>().Select(a => a.DerivedType).ToHashSet();
        var missing = ConcreteCommandTypes.Where(t => !registered.Contains(t)).Select(t => t.Name).ToList();
        Assert.Empty(missing);
        Assert.True(ConcreteCommandTypes.Count > 150, $"found only {ConcreteCommandTypes.Count} command types");
    }

    [Fact]
    public void Every_command_type_round_trips_defaults_and_populated_with_identical_bytes()
    {
        var failures = new List<string>();
        int ok = 0;
        foreach (var type in ConcreteCommandTypes)
        {
            foreach (var populated in new[] { false, true })
            {
                try
                {
                    var cmd = (Command)Make(type, populated, 0);
                    var bytes = LowkeyCommandCodec.Encode(cmd);
                    var json = Encoding.UTF8.GetString(bytes);
                    Assert.StartsWith("{\"$cmd\":\"", json);
                    var back = LowkeyCommandCodec.Decode(bytes);
                    Assert.Same(type, back.GetType());
                    var again = LowkeyCommandCodec.Encode(back);
                    Assert.Equal(json, Encoding.UTF8.GetString(again));
                    ok++;
                }
                catch (Exception e)
                {
                    failures.Add($"{type.Name} (populated={populated}): {e.GetType().Name}: {e.Message}");
                }
            }
        }
        _out.WriteLine($"{ConcreteCommandTypes.Count} command types, {ok} round trips ok");
        Assert.Empty(failures);
    }

    [Fact]
    public void Populated_commands_actually_carry_data()
    {
        // Guards the populator: a round trip of an all-default command proves little.
        int withData = 0;
        var same = new List<string>();
        foreach (var type in ConcreteCommandTypes)
        {
            var json = Encoding.UTF8.GetString(LowkeyCommandCodec.Encode((Command)Make(type, true, 0)));
            var def = Encoding.UTF8.GetString(LowkeyCommandCodec.Encode((Command)Make(type, false, 0)));
            if (json != def) withData++;
            else if (type.GetProperties().Any(p => p.CanWrite && p.DeclaringType != typeof(Command))) same.Add(type.Name);
        }
        _out.WriteLine($"{withData} of {ConcreteCommandTypes.Count} commands changed when populated; unchanged with writable props: {string.Join(",", same)}");
        Assert.Empty(same);
    }

    [Fact]
    public void Garbage_and_unknown_commands_are_refused_not_crashed_on()
    {
        Assert.False(LowkeyCommandCodec.TryDecode("not json"u8, out _));
        Assert.False(LowkeyCommandCodec.TryDecode("null"u8, out _));
        Assert.False(LowkeyCommandCodec.TryDecode("{\"$cmd\":\"no_such_command\"}"u8, out _));
        Assert.False(LowkeyCommandCodec.TryDecode("{\"x\":1}"u8, out _));
        Assert.False(LowkeyCommandCodec.TryDecode(ReadOnlySpan<byte>.Empty, out _));
    }

    [Fact]
    public void Dev_commands_are_flagged()
    {
        Assert.True(LowkeyCommandCodec.IsDev(new DevCash()));
        Assert.False(LowkeyCommandCodec.IsDev(new Moved()));
    }

    [Fact]
    public void Wire_format_is_the_command_log_format()
    {
        Assert.Equal("{\"$cmd\":\"moved\",\"x\":3,\"y\":4,\"z\":0,\"rolling\":true,\"precise\":false,\"fx\":0,\"fy\":0}",
            Encoding.UTF8.GetString(LowkeyCommandCodec.Encode(new Moved { X = 3, Y = 4, Rolling = true })));
    }

    // ---- a small reflective populator: gives every settable public property a non-default value ----

    private static object Make(Type t, bool populate, int depth)
    {
        var o = Activator.CreateInstance(t, nonPublic: true) ?? throw new InvalidOperationException($"{t.Name}: no parameterless constructor");
        if (!populate) return o;
        int n = 0;
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanWrite || p.GetIndexParameters().Length > 0 || p.GetCustomAttribute<JsonIgnoreAttribute>() is { Condition: JsonIgnoreCondition.Always }) continue;
            p.SetValue(o, Value(p.PropertyType, depth + 1, ++n));
        }
        // Read-only collection properties (`{ Ids = { "a" } }` initialisers): fill them in place.
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.CanWrite || p.GetIndexParameters().Length > 0 || p.GetValue(o) is not { } cur) continue;
            Fill(cur, depth + 1, ++n);
        }
        return o;
    }

    private static object? Value(Type t, int depth, int n)
    {
        var u = Nullable.GetUnderlyingType(t);
        if (u != null) t = u;
        if (t == typeof(string)) return "s" + n;
        if (t == typeof(bool)) return true;
        if (t == typeof(int)) return 10 + n;
        if (t == typeof(long)) return 5_000_000_000L + n;
        if (t == typeof(uint)) return (uint)(10 + n);
        if (t == typeof(ulong)) return 5_000_000_000UL + (ulong)n;
        if (t == typeof(short)) return (short)(10 + n);
        if (t == typeof(byte)) return (byte)(10 + n);
        if (t == typeof(double)) return 1.5 + n;
        if (t == typeof(float)) return 1.5f + n;
        if (t == typeof(decimal)) return 1.5m + n;
        if (t.IsEnum)
        {
            var vals = Enum.GetValues(t);
            return vals.Length > 1 ? vals.GetValue(1) : vals.GetValue(0);
        }
        if (t.IsArray)
        {
            var el = t.GetElementType()!;
            var arr = Array.CreateInstance(el, 2);
            for (int i = 0; i < 2; i++) arr.SetValue(Value(el, depth + 1, n + i), i);
            return arr;
        }
        if (t.IsInterface || t.IsAbstract)
        {
            if (!t.IsGenericType) return null;
            var g = t.GetGenericTypeDefinition();
            if (g == typeof(IList<>) || g == typeof(IReadOnlyList<>) || g == typeof(ICollection<>) || g == typeof(IEnumerable<>))
                t = typeof(List<>).MakeGenericType(t.GetGenericArguments());
            else if (g == typeof(IDictionary<,>) || g == typeof(IReadOnlyDictionary<,>))
                t = typeof(SortedDictionary<,>).MakeGenericType(t.GetGenericArguments());
            else return null;
        }
        var inst = Activator.CreateInstance(t, nonPublic: true);
        if (inst == null) return null;
        if (inst is IList or IDictionary) { Fill(inst, depth, n); return inst; }
        if (depth < 4)
            foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
                if (p.CanWrite && p.GetIndexParameters().Length == 0) p.SetValue(inst, Value(p.PropertyType, depth + 1, ++n));
        return inst;
    }

    private static void Fill(object coll, int depth, int n)
    {
        if (depth > 4) return;
        var ifaces = coll.GetType().GetInterfaces();
        if (coll is IDictionary d)
        {
            var args = ifaces.First(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IDictionary<,>)).GetGenericArguments();
            for (int i = 0; i < 2; i++) d[Value(args[0], depth + 1, n + i)!] = Value(args[1], depth + 1, n + i);
        }
        else if (coll is IList l && !l.IsFixedSize)
        {
            var el = ifaces.FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>))?.GetGenericArguments()[0] ?? typeof(string);
            for (int i = 0; i < 2; i++) l.Add(Value(el, depth + 1, n + i));
        }
    }
}
