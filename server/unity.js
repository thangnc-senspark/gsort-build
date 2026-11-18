// Runs the Unity editor installed on this machine against workspace/<project>/src.
// The workspace has its own Library, so the Editor's copy of the project is never touched.
const fs = require('fs');
const path = require('path');
const { ROOT, workspaceDir } = require('./sync');

function unityPath(project) {
  const tpl = project.unityPath || '/Applications/Unity/Hub/Editor/{version}/Unity.app/Contents/MacOS/Unity';
  return tpl.replace('{version}', project.unityVersion);
}

const licenseTestDir = () => path.join(ROOT, 'workspace', '_license-test');

// Reasons a job cannot start; shown on the dashboard and returned when creating a job.
function problems(project, platform) {
  const out = [];
  if (!fs.existsSync(unityPath(project))) out.push(`Unity not found: ${unityPath(project)}`);
  if (platform === 'android') {
    const keystore = project.android.keystore && project.source.extraFiles && project.source.extraFiles[project.android.keystore];
    if (keystore && !fs.existsSync(path.resolve(ROOT, keystore))) out.push(`Missing ${keystore}`);
    if (!process.env.ANDROID_KEYSTORE_PASS) out.push('ANDROID_KEYSTORE_PASS is not set in .env');
  }
  return out;
}

function command(job, project, outDir) {
  const args = ['-batchmode', '-nographics', '-logFile', '-'];
  if (job.platform === 'license') {
    args.push('-createProject', path.join(licenseTestDir(), job.id), '-quit');
  } else {
    args.push('-projectPath', workspaceDir(project), '-quit', '-ubsOutput', outDir);
    if (job.versionName) args.push('-ubsVersionName', job.versionName);
    if (job.versionCode) args.push('-ubsVersionCode', String(job.versionCode));
    if (project.scenes && project.scenes.length) args.push('-ubsScenes', project.scenes.join(';'));
    if (job.platform === 'android') {
      args.push('-buildTarget', 'Android', '-executeMethod', 'UnityBuildSystem.BatchBuild.BuildAndroid',
        '-ubsAndroidFormat', job.androidFormat || 'apk', '-ubsOutputName', project.android.outputName);
      if (project.android.keystore) args.push('-ubsKeystore', project.android.keystore);
    } else {
      args.push('-buildTarget', 'iOS', '-executeMethod', 'UnityBuildSystem.BatchBuild.BuildIOS');
    }
  }
  // detached: own process group, so cancel also stops Bee/IL2CPP/Gradle children.
  return { cmd: unityPath(project), args, detached: true };
}

function cancel(child) {
  if (!child) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 15000);
}

function cleanLibrary(project, onLine) {
  const lib = path.join(workspaceDir(project), 'Library');
  onLine(`Removing ${path.relative(ROOT, lib)}`);
  fs.rmSync(lib, { recursive: true, force: true });
}

module.exports = { problems, command, cancel, cleanLibrary, licenseTestDir };
