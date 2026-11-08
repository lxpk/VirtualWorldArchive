// One-time project setup: makes a Main scene, adds it to the build, and keeps
// the glTFast shaders in builds (they are loaded at runtime, so Unity would
// otherwise strip them). Runs on load and from the "Virtual World Archive" menu.
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace Vwa.EditorTools
{
    [InitializeOnLoad]
    public static class VwaProjectSetup
    {
        const string ScenePath = "Assets/Scenes/Main.unity";

        static VwaProjectSetup() { EditorApplication.delayCall += () => Setup(false); }

        [MenuItem("Virtual World Archive/Run Project Setup")]
        static void SetupMenu() => Setup(true);

        static void Setup(bool verbose)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) return;
            if (!File.Exists(ScenePath))
            {
                Directory.CreateDirectory("Assets/Scenes");
                var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
                EditorSceneManager.SaveScene(scene, ScenePath);
                Debug.Log("[VWA] Created " + ScenePath + ". Press Play to join the world.");
            }
            if (!EditorBuildSettings.scenes.Any(s => s.path == ScenePath))
                EditorBuildSettings.scenes = EditorBuildSettings.scenes.Append(new EditorBuildSettingsScene(ScenePath, true)).ToArray();

            var gs = AssetDatabase.LoadAssetAtPath<GraphicsSettings>("ProjectSettings/GraphicsSettings.asset");
            if (gs != null)
            {
                var so = new SerializedObject(gs);
                var arr = so.FindProperty("m_AlwaysIncludedShaders");
                bool changed = false;
                foreach (var name in new[] { "glTF/PbrMetallicRoughness", "glTF/PbrSpecularGlossiness", "glTF/Unlit" })
                {
                    var sh = Shader.Find(name);
                    if (sh == null) continue;
                    bool present = false;
                    for (int i = 0; i < arr.arraySize; i++) if (arr.GetArrayElementAtIndex(i).objectReferenceValue == sh) present = true;
                    if (present) continue;
                    arr.InsertArrayElementAtIndex(arr.arraySize);
                    arr.GetArrayElementAtIndex(arr.arraySize - 1).objectReferenceValue = sh;
                    changed = true;
                }
                if (changed) { so.ApplyModifiedProperties(); AssetDatabase.SaveAssets(); Debug.Log("[VWA] Added glTFast shaders to Always Included Shaders."); }
            }
            if (verbose) Debug.Log("[VWA] Project setup done.");
        }

        [MenuItem("Virtual World Archive/Build WebGL client")]
        static void BuildWebGL()
        {
            Setup(false);
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;
            var opts = new BuildPlayerOptions
            {
                scenes = new[] { ScenePath }, locationPathName = "Builds/WebGL", target = BuildTarget.WebGL,
            };
            var report = BuildPipeline.BuildPlayer(opts);
            Debug.Log("[VWA] WebGL build: " + report.summary.result + ". Zip Builds/WebGL and upload it on the archive as a web client.");
        }
    }
}
