using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using Godot;

namespace OneLobbyDemo;

/// <summary>
/// Which members of GodotSharp an assembly refers to that the GodotSharp running now does not have. The packages and the demo are built
/// against GodotSharp 4.5.1 (the oldest supported Godot) and run on whatever engine the game has: a member that was in 4.5 and is not (or has a
/// different signature) in a newer engine compiles fine and throws MissingMethodException only when that line first runs.
/// </summary>
public static class GodotApiGaps
{
    /// <summary>The assembly's file: its location, or (Godot loads a game's assemblies from memory) the project's build folder.</summary>
    private static string FileOf(Assembly asm)
    {
        if (!string.IsNullOrEmpty(asm.Location)) return asm.Location;
        var project = ProjectSettings.GlobalizePath("res://");
        foreach (var config in new[] { "Debug", "Release", "ExportDebug", "ExportRelease" })
        {
            var path = Path.Combine(project, ".godot", "mono", "temp", "bin", config, asm.GetName().Name + ".dll");
            if (File.Exists(path)) return path;
        }
        throw new FileNotFoundException("no file for assembly " + asm.GetName().Name);
    }

    /// <summary>The number of member and type references into GodotSharp, and the ones the loaded GodotSharp cannot resolve (by name).</summary>
    public static (int Checked, List<string> Missing) Scan(Assembly asm)
    {
        var missing = new List<string>();
        var count = 0;
        using var stream = File.OpenRead(FileOf(asm));
        using var pe = new PEReader(stream);
        var md = pe.GetMetadataReader();
        var module = asm.ManifestModule;
        bool IsGodot(EntityHandle scope)
        {
            if (scope.Kind != HandleKind.TypeReference) return false;
            var tr = md.GetTypeReference((TypeReferenceHandle)scope);
            return tr.ResolutionScope.Kind == HandleKind.AssemblyReference
                && md.GetString(md.GetAssemblyReference((AssemblyReferenceHandle)tr.ResolutionScope).Name) == "GodotSharp";
        }
        foreach (var h in md.MemberReferences)
        {
            var mr = md.GetMemberReference(h);
            if (!IsGodot(mr.Parent)) continue;
            count++;
            var tr = md.GetTypeReference((TypeReferenceHandle)mr.Parent);
            var name = md.GetString(tr.Namespace) + "." + md.GetString(tr.Name) + "." + md.GetString(mr.Name);
            try { module.ResolveMember(MetadataTokens.GetToken(h)); }
            catch (Exception e) when (e is MissingMemberException or TypeLoadException or ArgumentException or BadImageFormatException) { missing.Add(name); }
        }
        foreach (var h in md.TypeReferences)
        {
            if (!IsGodot(h)) continue;
            count++;
            try { module.ResolveType(MetadataTokens.GetToken(h)); }
            catch (Exception e) when (e is TypeLoadException or ArgumentException or BadImageFormatException)
            {
                var tr = md.GetTypeReference(h);
                missing.Add(md.GetString(tr.Namespace) + "." + md.GetString(tr.Name));
            }
        }
        return (count, missing);
    }
}
