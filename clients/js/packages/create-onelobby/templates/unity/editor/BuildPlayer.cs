#nullable enable
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

/// <summary>
/// Builds the Windows player with no manual step (Mono, 64-bit, into Builds/Windows/Game.exe). Written by create-onelobby; yours to edit.
///   Unity.exe -batchmode -nographics -quit -projectPath . -logFile build.log -executeMethod OneLobbyBuild.Windows
/// The game's own scenes (File > Build Profiles, or EditorBuildSettings) are used when it has any; a project with none gets an empty scene
/// that exists only while the build runs, because GameBoot (the menu) needs no scene object.
/// </summary>
public static class OneLobbyBuild
{
    public const string Output = "Builds/Windows/Game.exe";

    public static void Windows()
    {
        var code = 1;
        try
        {
            var scenes = EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray();
            string? temp = null;
            if (scenes.Length == 0)
            {
                temp = "Assets/OneLobbyBuildEmpty.unity";
                var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                EditorSceneManager.SaveScene(scene, temp);
                scenes = new[] { temp };
            }
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(Output)!);
                var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
                {
                    scenes = scenes,
                    locationPathName = Output,
                    target = BuildTarget.StandaloneWindows64,
                    options = BuildOptions.None,
                });
                Debug.Log("OneLobbyBuild: " + report.summary.result + " " + Output + " (" + report.summary.totalErrors + " errors)");
                code = report.summary.result == UnityEditor.Build.Reporting.BuildResult.Succeeded ? 0 : 1;
            }
            finally
            {
                if (temp != null) AssetDatabase.DeleteAsset(temp);
            }
        }
        catch (Exception e)
        {
            Debug.LogError("OneLobbyBuild failed: " + e);
        }
        if (Application.isBatchMode) EditorApplication.Exit(code);
    }
}
