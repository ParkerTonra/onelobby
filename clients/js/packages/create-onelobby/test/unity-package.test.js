// The Unity package's package.json must list every built-in Unity module its runtime code uses. No Unity, no network:
// a text scan of Runtime/*.cs for the types each module owns, compared with the "dependencies" of package.json.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "../../../../unity/com.onelobby.unity");

// the built-in module that owns each UnityEngine type or namespace the runtime may use (types in the core module need no entry)
export const MODULE_OF = {
  "com.unity.modules.animation": ["Animator", "AnimationClip", "RuntimeAnimatorController"],
  "com.unity.modules.audio": ["AudioSource", "AudioClip", "AudioListener", "AudioSettings", "AudioMixerGroup", "Microphone"],
  "com.unity.modules.jsonserialize": ["JsonUtility"],
  "com.unity.modules.physics": ["Rigidbody", "CharacterController", "Collider", "Physics", "RaycastHit"],
  "com.unity.modules.uielements": ["UIDocument", "PanelSettings", "VisualElement", "UnityEngine.UIElements"],
  "com.unity.modules.unitywebrequest": ["UnityWebRequest"],
  "com.unity.modules.imgui": ["GUILayout", "OnGUI"],
  "com.unity.modules.ui": ["UnityEngine.UI"],
};

/** The modules a set of C# sources needs: { module -> the first names found }. Comments and string literals are not stripped (a false alarm is a one-line fix). */
export function modulesUsed(sources) {
  const used = {};
  for (const [mod, names] of Object.entries(MODULE_OF)) {
    const hits = names.filter((n) => new RegExp(`(^|[^A-Za-z0-9_])${n.replace(/\./g, "\\.")}($|[^A-Za-z0-9_])`).test(sources));
    if (hits.length) used[mod] = hits;
  }
  return used;
}

/** The modules used but not declared. */
export function missingModules(sources, dependencies) {
  return Object.keys(modulesUsed(sources)).filter((m) => !(m in dependencies));
}

const runtimeSource = () =>
  readdirSync(join(PKG, "Runtime"))
    .filter((f) => f.endsWith(".cs"))
    .map((f) => readFileSync(join(PKG, "Runtime", f), "utf8"))
    .join("\n");
const declared = () => JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")).dependencies;

describe("com.onelobby.unity package.json", () => {
  it("lists every built-in module the runtime code uses (UI Toolkit for OneLobbyMenu among them)", () => {
    const used = modulesUsed(runtimeSource());
    expect(Object.keys(used)).toContain("com.unity.modules.uielements");
    expect(missingModules(runtimeSource(), declared())).toEqual([]);
  });

  it("declares no module the runtime does not use", () => {
    const used = Object.keys(modulesUsed(runtimeSource()));
    expect(Object.keys(declared()).filter((m) => !used.includes(m))).toEqual([]);
  });

  it("negative control: the old dependency list (animation and physics only) is reported as missing UI Toolkit, audio and JSON", () => {
    const old = { "com.unity.modules.animation": "1.0.0", "com.unity.modules.physics": "1.0.0" };
    expect(missingModules(runtimeSource(), old)).toEqual(expect.arrayContaining(["com.unity.modules.uielements", "com.unity.modules.audio", "com.unity.modules.jsonserialize"]));
  });

  it("negative control: a source that touches no module needs none, and a new use is caught", () => {
    expect(missingModules("class A { void F() { UnityEngine.Debug.Log(1); } }", {})).toEqual([]);
    expect(missingModules("using UnityEngine.UIElements;", {})).toEqual(["com.unity.modules.uielements"]);
    expect(missingModules("var w = UnityWebRequest.Get(u);", {})).toEqual(["com.unity.modules.unitywebrequest"]);
  });
});
