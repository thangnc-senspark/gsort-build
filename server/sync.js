// Prepares workspace/<project>/src from git: shallow fetch of the branch, clean checkout, submodules.
// Library/ is kept between builds; everything else matches the commit exactly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function workspaceDir(project) {
  return path.join(ROOT, 'workspace', project.id, 'src');
}

async function git(dir, args, onLine) {
  onLine(`$ git ${args.join(' ')}`);
  const code = await run('git', args, { cwd: dir, onLine, env: GIT_ENV });
  if (code !== 0) throw new Error(`git ${args[0]} exited with ${code}`);
}

// True when dir holds a usable checkout: a .git folder, or a .git file whose gitdir exists.
function isWorkingRepo(dir) {
  const dotgit = path.join(dir, '.git');
  if (!fs.existsSync(dotgit)) return false;
  if (fs.statSync(dotgit).isDirectory()) return true;
  const m = fs.readFileSync(dotgit, 'utf8').match(/^gitdir:\s*(.+)$/m);
  return !!m && fs.existsSync(path.resolve(dir, m[1].trim()));
}

// Returns { dir, commit }.
async function syncProject(project, branch, onLine) {
  const { url, submodules = true, extraFiles = {} } = project.source;
  const dir = workspaceDir(project);
  fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(path.join(dir, '.git'))) {
    await git(dir, ['init', '-q'], onLine);
    await git(dir, ['remote', 'add', 'origin', url], onLine);
  } else {
    await git(dir, ['remote', 'set-url', 'origin', url], onLine);
  }
  // "+" because a shallow repo cannot prove a fast-forward; we always want the remote state.
  await git(dir, ['fetch', '--depth', '1', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], onLine);
  await git(dir, ['checkout', '-q', '-f', '-B', 'ubs-build', `origin/${branch}`], onLine);
  await git(dir, ['clean', '-ffdxq', '-e', '/Library/'], onLine);

  if (submodules) {
    // A submodule folder without a valid .git would make `submodule update` fail.
    const cfg = spawnSync('git', ['config', '-f', '.gitmodules', '--get-regexp', 'path'], { cwd: dir, encoding: 'utf8' }).stdout || '';
    for (const sub of cfg.split('\n').map((l) => l.split(' ')[1]).filter(Boolean)) {
      const subDir = path.join(dir, sub);
      if (fs.existsSync(subDir) && !isWorkingRepo(subDir)) {
        onLine(`Removing broken submodule folder ${sub}`);
        fs.rmSync(subDir, { recursive: true, force: true });
      }
    }
    await git(dir, ['submodule', 'sync', '-q', '--recursive'], onLine);
    await git(dir, ['submodule', 'update', '--init', '--recursive', '--depth', '1', '-f'], onLine);
    await git(dir, ['submodule', 'foreach', '-q', '--recursive', 'git clean -ffdxq'], onLine);
  }

  const out = spawnSync('git', ['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const [sha, short, subject, author, date] = out.split('\x1f');
  onLine(`Building ${branch} @ ${short} "${subject}" (${author}, ${date})`);

  // Gitignored files the build needs (e.g. the keystore), kept in secrets/.
  for (const [to, from] of Object.entries(extraFiles)) {
    const src = path.resolve(ROOT, from);
    if (!fs.existsSync(src)) throw new Error(`Missing ${from} (needed as ${to})`);
    fs.copyFileSync(src, path.join(dir, to));
    onLine(`Copied ${from} -> ${to}`);
  }

  const injectDir = path.join(dir, 'Assets', 'Editor', 'UnityBuildSystem');
  fs.mkdirSync(injectDir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'unity', 'BatchBuild.cs'), path.join(injectDir, 'BatchBuild.cs'));
  onLine('Injected BatchBuild.cs');

  return { dir, commit: { sha, short, subject, author, date } };
}

// Remote branches with their head commit, for the dashboard. Cached for a minute unless refresh is set.
const branchCache = new Map();
async function listBranches(project, { refresh = false } = {}) {
  const hit = branchCache.get(project.id);
  if (!refresh && hit && Date.now() - hit.fetchedAt < 60000) return hit;
  const lines = [];
  const code = await run('git', ['ls-remote', '--heads', project.source.url], { env: GIT_ENV, onLine: (l) => lines.push(l) });
  if (code !== 0) throw new Error(`git ls-remote failed: ${lines.slice(-3).join(' ')}`);
  const branches = lines
    .map((l) => l.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/))
    .filter(Boolean)
    .map(([, sha, name]) => ({ name, sha: sha.slice(0, 8) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const result = { fetchedAt: Date.now(), branches };
  branchCache.set(project.id, result);
  return result;
}

// Version placeholders for the dashboard, from the last checked-out commit.
function readVersions(project) {
  try {
    const text = fs.readFileSync(path.join(workspaceDir(project), 'ProjectSettings', 'ProjectSettings.asset'), 'utf8');
    const get = (re) => (text.match(re) || [])[1];
    return {
      versionName: get(/^\s*bundleVersion:\s*(.+)$/m),
      androidVersionCode: get(/^\s*AndroidBundleVersionCode:\s*(\d+)/m),
      iosBuildNumber: get(/buildNumber:[\s\S]*?iPhone:\s*(\S+)/),
    };
  } catch {
    return {};
  }
}

module.exports = { syncProject, readVersions, listBranches, workspaceDir, ROOT };
