using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using Xunit;

namespace OneLobby.Tests
{
    /// <summary>
    /// The Godot C# menu scene (OneLobbyMenu.tscn) is the GDScript menu's scene (menu.tscn) with only the root script swapped:
    /// tools/make-menu-scene.mjs writes it. These tests read both files and fail when their node trees differ, so a change to
    /// one cannot leave the other behind, and when the C# controller names a node the scene does not have. They need no Godot.
    /// </summary>
    public class MenuSceneTests
    {
        private static string Root => Path.GetDirectoryName(Spec.Root)!;
        private static string GdScene => Path.Combine(Root, "clients", "gdscript", "addons", "onelobby", "menu", "menu.tscn");
        private static string CsDir => Path.Combine(Root, "clients", "dotnet", "demo-godot", "addons", "onelobby_menu");
        private static string CsScene => Path.Combine(CsDir, "OneLobbyMenu.tscn");

        /// <summary>One <c>[kind attr=value ...]</c> section of a .tscn with its property lines.</summary>
        private sealed record Section(string Kind, SortedDictionary<string, string> Attrs, SortedDictionary<string, string> Props);

        private static List<Section> Parse(string path)
        {
            var sections = new List<Section>();
            Section? cur = null;
            foreach (var raw in File.ReadAllText(path).Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.TrimEnd();
                if (line.Length == 0) continue;
                if (line[0] == '[')
                {
                    var m = Regex.Match(line, @"^\[(\w+)(.*)\]$");
                    Assert.True(m.Success, "unreadable section: " + line);
                    var attrs = new SortedDictionary<string, string>();
                    foreach (Match a in Regex.Matches(m.Groups[2].Value, @"(\w+)=(""[^""]*""|\S+)")) attrs[a.Groups[1].Value] = a.Groups[2].Value;
                    cur = new Section(m.Groups[1].Value, attrs, new SortedDictionary<string, string>());
                    sections.Add(cur);
                }
                else
                {
                    var eq = line.IndexOf('=');
                    Assert.True(cur != null && eq > 0, "a property outside a section: " + line);
                    cur!.Props[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            return sections;
        }

        private static string Describe(Section s) =>
            s.Kind + " " + string.Join(" ", s.Attrs.Select(a => a.Key + "=" + a.Value)) + " { " + string.Join("; ", s.Props.Select(p => p.Key + " = " + p.Value)) + " }";

        [Fact]
        public void TheCSharpSceneIsTheGdscriptSceneWithOnlyTheRootScriptSwapped()
        {
            var gd = Parse(GdScene);
            var cs = Parse(CsScene);
            var gdNodes = gd.Where(s => s.Kind == "node").ToList();
            Assert.True(gdNodes.Count > 100, "menu.tscn parsed to only " + gdNodes.Count + " nodes");
            Assert.Equal(gdNodes.Count, cs.Count(s => s.Kind == "node"));

            // every node: type, name, parent, instance and every property (the unique-name flag is one of them), in order
            var gdNode = gdNodes.Select(n => Describe(WithoutScript(n))).ToList();
            var csNode = cs.Where(s => s.Kind == "node").Select(n => Describe(WithoutScript(n))).ToList();
            for (var i = 0; i < gdNode.Count; i++) Assert.Equal(gdNode[i], csNode[i]);
            // everything else (sub resources, connections, the file header) is the same
            Assert.Equal(gd.Where(s => s.Kind != "node" && s.Kind != "ext_resource").Select(Describe), cs.Where(s => s.Kind != "node" && s.Kind != "ext_resource").Select(Describe));

            // only the root's script differs, and the C# one points at a file that exists
            var csRoot = cs.First(s => s.Kind == "node");
            var script = Regex.Match(csRoot.Props["script"], @"ExtResource\(""([^""]+)""\)").Groups[1].Value;
            var res = cs.Single(s => s.Kind == "ext_resource" && s.Attrs["id"] == "\"" + script + "\"");
            Assert.Equal("\"res://addons/onelobby_menu/OneLobbyMenu.cs\"", res.Attrs["path"]);
            Assert.True(File.Exists(Path.Combine(CsDir, "OneLobbyMenu.cs")));
            Assert.Equal(gd.Count(s => s.Kind == "ext_resource"), cs.Count(s => s.Kind == "ext_resource"));
        }

        private static Section WithoutScript(Section n)
        {
            var props = new SortedDictionary<string, string>(n.Props);
            props.Remove("script");
            return n with { Props = props };
        }

        [Fact]
        public void EveryNodeTheControllerNamesIsAUniqueNodeOfTheScene()
        {
            var unique = Parse(CsScene).Where(s => s.Kind == "node" && s.Props.TryGetValue("unique_name_in_owner", out var v) && v == "true")
                .Select(s => s.Attrs["name"].Trim('"')).ToHashSet();
            Assert.True(unique.Count > 70, "only " + unique.Count + " unique-named nodes");
            var source = File.ReadAllText(Path.Combine(CsDir, "OneLobbyMenu.cs"));
            var used = Regex.Matches(source, @"U<\w+>\(""(\w+)""\)").Select(m => m.Groups[1].Value).ToHashSet();
            Assert.True(used.Count > 60, "the controller uses only " + used.Count + " nodes");
            Assert.Empty(used.Except(unique));
            // the names its header lists are the GDScript menu's header names
            var gdHeader = HeaderNames(File.ReadAllText(Path.Combine(Root, "clients", "gdscript", "addons", "onelobby", "menu", "menu.gd")), "##");
            var csHeader = HeaderNames(source, "///");
            Assert.Equal(gdHeader.OrderBy(x => x), csHeader.OrderBy(x => x));
            Assert.Empty(csHeader.Except(unique));
        }

        private static List<string> HeaderNames(string text, string marker)
        {
            var names = new List<string>();
            var on = false;
            foreach (var raw in text.Replace("\r\n", "\n").Split('\n'))
            {
                var line = raw.TrimStart();
                if (line.StartsWith(marker + " Nodes a controller")) { on = true; continue; }
                if (on && line.StartsWith(marker + " (The roster")) break;
                if (!on || !line.StartsWith(marker)) continue;
                var body = line.Substring(marker.Length).Trim();
                var colon = body.IndexOf(':');
                if (colon > 0 && colon < 12) body = body.Substring(colon + 1);
                names.AddRange(body.Split(' ', StringSplitOptions.RemoveEmptyEntries));
            }
            return names;
        }
    }
}
