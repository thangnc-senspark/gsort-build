// Prepares workspace/<project>/src from git: shallow fetch of the branch, clean checkout, submodules.
// With source.path instead of source.url, the checkout is one cloned by hand and kept up to date
// by hand: nothing talks to the remote, branches are the ones already in the repo (git branch -a).
// Library/ is kept between builds; everything else matches the commit exactly.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { run } = require('./util');

const ROOT = path.resolve(__dirname, '..');
// Environment for every git process, including submodule clones:
// - never prompt (a missing credential fails the job instead of hanging it),
// - SSH in batch mode, accepting a host key the first time,
// - source.gitConfig entries, e.g. rewriting https://github.com/ submodule URLs to SSH.
function gitEnv(project) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new';
  const entries = Object.entries(project.source.gitConfig || {});
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

function workspaceDir(project) {
  if (project.source.path) return path.resolve(ROOT, project.source.path);
  return path.join(ROOT, 'workspace', project.id, 'src');
}

async function git(dir, args, onLine, env) {
  onLine(`$ git ${args.join(' ')}`);
  const code = await run('git', args, { cwd: dir, onLine, env });
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

function hasRef(dir, ref) {
  return spawnSync('git', ['show-ref', '--verify', '-q', ref], { cwd: dir }).status === 0;
}

// Returns { dir, commit }.
async function syncProject(project, branch, onLine) {
  const { url, submodules = true, extraFiles = {} } = project.source;
  const dir = workspaceDir(project);
  const env = gitEnv(project);
  const g = (args) => git(dir, args, onLine, env);
  if (!url) {
    if (!isWorkingRepo(dir)) throw new Error(`No git checkout at ${project.source.path} - clone the repo there first`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      await g(['init', '-q']);
      await g(['remote', 'add', 'origin', url]);
    } else {
      await g(['remote', 'set-url', 'origin', url]);
    }
  }
  let ref = `origin/${branch}`;
  if (url) {
    // "+" because a shallow repo cannot prove a fast-forward; we always want the remote state.
    await g(['fetch', '--depth', '1', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  } else if (!hasRef(dir, `refs/remotes/${ref}`)) {
    // Local-only branch; fall back to it when there is no remote-tracking copy.
    if (!hasRef(dir, `refs/heads/${branch}`)) throw new Error(`Branch ${branch} not found in ${project.source.path} (git branch -a)`);
    ref = branch;
  }
  await g(['checkout', '-q', '-f', '-B', 'ubs-build', ref]);
  await g(['clean', '-ffdxq', '-e', '/Library/']);

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
    await g(['submodule', 'sync', '-q', '--recursive']);
    await g(['submodule', 'update', '--init', '--recursive', '-f', ...(url ? ['--depth', '1'] : ['--no-fetch'])]);
    await g(['submodule', 'foreach', '-q', '--recursive', 'git clean -ffdxq']);
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

// Branches with their head commit, for the dashboard. Cached for a minute unless refresh is set.
// For a source.path checkout these are the branches already in the repo, remote-tracking and local.
const branchCache = new Map();
async function listBranches(project, { refresh = false } = {}) {
  const hit = branchCache.get(project.id);
  if (!refresh && hit && Date.now() - hit.fetchedAt < 60000) return hit;
  const lines = [];
  const { url } = project.source;
  const args = url
    ? ['ls-remote', '--heads', url]
    : ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin', 'refs/heads'];
  const code = await run('git', args, { cwd: url ? undefined : workspaceDir(project), env: gitEnv(project), onLine: (l) => lines.push(l) });
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${lines.slice(-3).join(' ')}`);
  const byName = new Map();
  for (const l of lines) {
    const m = l.match(/^([0-9a-f]{40})\s+refs\/(?:heads|remotes\/origin)\/(.+)$/);
    // ubs-build is our own build branch; remote-tracking refs come first and win over local ones.
    if (m && m[2] !== 'HEAD' && m[2] !== 'ubs-build' && !byName.has(m[2])) byName.set(m[2], { name: m[2], sha: m[1].slice(0, 8) });
  }
  const branches = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
