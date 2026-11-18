// Injected by unity-build into the workspace checkout (never into the original project).
// Entry points: UnityBuildSystem.BatchBuild.BuildAndroid / BuildIOS
// Lines starting with "##UBS" are progress markers parsed by the dashboard.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace UnityBuildSystem
{
    public static class BatchBuild
    {
        public static void BuildAndroid()
        {
            Run(() =>
            {
                Marker("stage=configure");
                var output = Arg("ubsOutput", "Build");
                var format = Arg("ubsAndroidFormat", "apk").ToLowerInvariant();
                var outputName = Arg("ubsOutputName", PlayerSettings.productName);

                ApplyVersion();
                if (int.TryParse(Arg("ubsVersionCode", ""), out var code))
                    PlayerSettings.Android.bundleVersionCode = code;

                var keystore = Arg("ubsKeystore", "");
                if (!string.IsNullOrEmpty(keystore))
                {
                    if (!File.Exists(keystore))
                        throw new Exception($"Keystore not found: {keystore}");
                    PlayerSettings.Android.useCustomKeystore = true;
                    PlayerSettings.Android.keystoreName = keystore;
                    PlayerSettings.Android.keystorePass = Environment.GetEnvironmentVariable("ANDROID_KEYSTORE_PASS");
                    PlayerSettings.Android.keyaliasPass = Environment.GetEnvironmentVariable("ANDROID_KEYALIAS_PASS");
                    if (string.IsNullOrEmpty(PlayerSettings.Android.keystorePass))
                        throw new Exception("ANDROID_KEYSTORE_PASS is empty (set it in .env)");
                }

                ResolveAndroidDependencies();

                var formats = format == "both" ? new[] { "apk", "aab" } : new[] { format };
                foreach (var f in formats)
                {
                    EditorUserBuildSettings.buildAppBundle = f == "aab";
                    Build(BuildTarget.Android, Path.Combine(output, $"{outputName}.{f}"), f);
                }
            });
        }

        public static void BuildIOS()
        {
            Run(() =>
            {
                Marker("stage=configure");
                var output = Arg("ubsOutput", "Build");
                ApplyVersion();
                var code = Arg("ubsVersionCode", "");
                if (!string.IsNullOrEmpty(code))
                    PlayerSettings.iOS.buildNumber = code;
                Build(BuildTarget.iOS, Path.Combine(output, "ios-xcode"), "xcode");
            });
        }

        // A git checkout lacks gitignored resolver output (e.g. Assets/GeneratedLocalRepo) that Gradle needs,
        // so run the External Dependency Manager's Android resolver if the project has it.
        private static void ResolveAndroidDependencies()
        {
            var resolver = AppDomain.CurrentDomain.GetAssemblies()
                .Select(a => a.GetType("GooglePlayServices.PlayServicesResolver", false))
                .FirstOrDefault(t => t != null);
            var resolve = resolver?.GetMethod("ResolveSync", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(bool) }, null);
            if (resolve == null)
            {
                Debug.Log("[UBS-INFO] External Dependency Manager not found, skipping Android resolve");
                return;
            }
            Marker("stage=resolve");
            if (!(bool)resolve.Invoke(null, new object[] { true }))
                throw new Exception("Android dependency resolution (EDM) failed");
        }

        private static void Build(BuildTarget target, string location, string label)
        {
            Marker($"stage=build label={label}");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = Scenes(),
                locationPathName = location,
                target = target,
                options = BuildOptions.None,
            });
            var s = report.summary;
            Marker($"artifact label={label} result={s.result} size={s.totalSize} seconds={(int)s.totalTime.TotalSeconds} errors={s.totalErrors} path={location}");
            if (s.result != BuildResult.Succeeded)
                throw new Exception($"Build {label} finished with result {s.result} ({s.totalErrors} errors)");
        }

        private static void Run(Action action)
        {
            Application.SetStackTraceLogType(LogType.Log, StackTraceLogType.None);
            try
            {
                action();
                Marker("result=Succeeded");
                EditorApplication.Exit(0);
            }
            catch (Exception e)
            {
                Debug.LogError($"[UBS] {e}");
                Marker("result=Failed");
                EditorApplication.Exit(1);
            }
        }

        private static void ApplyVersion()
        {
            var versionName = Arg("ubsVersionName", "");
            if (!string.IsNullOrEmpty(versionName))
                PlayerSettings.bundleVersion = versionName;
        }

        private static string[] Scenes()
        {
            var arg = Arg("ubsScenes", "");
            var scenes = string.IsNullOrEmpty(arg)
                ? EditorBuildSettings.scenes.Where(s => s.enabled).Select(s => s.path).ToArray()
                : arg.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
            var missing = scenes.Where(s => !File.Exists(s)).ToList();
            if (missing.Count > 0)
                throw new Exception("Scenes not found: " + string.Join(", ", missing));
            return scenes;
        }

        private static string Arg(string name, string fallback)
        {
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, "-" + name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : fallback;
        }

        internal static void Marker(string text)
        {
            Console.WriteLine($"##UBS {text}");
            Console.Out.Flush();
        }
    }

    internal class ProgressHooks : IPreprocessBuildWithReport, IPostprocessBuildWithReport
    {
        public int callbackOrder => int.MinValue;
        public void OnPreprocessBuild(BuildReport report) => BatchBuild.Marker("stage=player");
        public void OnPostprocessBuild(BuildReport report) => BatchBuild.Marker("stage=postprocess");
    }
}
