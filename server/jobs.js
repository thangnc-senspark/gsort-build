const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { run } = require('./util');
const { ProgressTracker } = require('./progress');
const { syncProject, ROOT } = require('./sync');
const { environments, applyEnvironment } = require('./environment');
const unity = require('./unity');
const { postprocessIOS } = require('./postprocess');

const JOBS_DIR = path.join(ROOT, 'jobs');
const OUTPUT_DIR = path.join(ROOT, 'output');
const LOG_TAIL = 400; // lines kept in memory for new SSE subscribers

class JobManager extends EventEmitter {
  constructor(projects) {
    super();
    this.setMaxListeners(0);
    this.projects = projects;
    this.jobs = new Map(); // id -> { meta, tracker, tail, logStream, child }
    this.queue = [];
    this.running = null;
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    this.loadHistory();
    setInterval(() => this.running && this.emitUpdate(this.running), 1000);
  }

  loadHistory() {
    for (const id of fs.readdirSync(JOBS_DIR)) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, id, 'meta.json'), 'utf8'));
        if (meta.status === 'running' || meta.status === 'queued') {
          meta.status = 'interrupted';
          this.save(meta);
        }
        this.jobs.set(id, { meta, tracker: null, tail: [] });
      } catch {
        // ignore unreadable job folders
      }
    }
  }

  list() {
    return [...this.jobs.values()].map((j) => this.view(j)).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? this.view(j) : null;
  }

  view(j) {
    return { ...j.meta, progress: j.tracker ? j.tracker.snapshot() : j.meta.progress || null };
  }

  tail(id) {
    const j = this.jobs.get(id);
    if (!j) return [];
    if (j.tail.length) return j.tail;
    const file = path.join(JOBS_DIR, id, 'build.log');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').slice(-LOG_TAIL);
  }

  logPath(id) {
    return path.join(JOBS_DIR, id, 'build.log');
  }

  create({ projectId, platform, androidFormat, versionName, versionCode, cleanLibrary, branch, environment }) {
    const project = this.projects[projectId];
    if (!project) throw new Error(`Unknown project ${projectId}`);
    if (!['android', 'ios', 'license'].includes(platform)) throw new Error(`Unknown platform ${platform}`);
    if (versionCode && !/^\d+$/.test(String(versionCode))) throw new Error('versionCode must be a number');
    if (branch && !/^[\w./-]+$/.test(branch)) throw new Error('Invalid branch name');
    const isBuild = platform !== 'license';
    const envs = environments(project);
    const hasEnvs = isBuild && Object.keys(envs).length > 0;
    const envName = hasEnvs ? environment || project.defaultEnvironment : undefined;
    if (hasEnvs && !envs[envName]) throw new Error(`Unknown environment ${envName}`);
    const problems = unity.problems(project, platform);
    if (problems.length) throw new Error(problems.join('; '));
    const ts = new Date();
    const id = `${ts.toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${platform}-${Math.random().toString(36).slice(2, 6)}`;
    const meta = {
      id, projectId, platform,
      androidFormat: platform === 'android' ? androidFormat || 'apk' : undefined,
      versionName: versionName || undefined,
      versionCode: versionCode || undefined,
      branch: isBuild ? branch || project.source.defaultBranch : undefined,
      commit: undefined,
      environment: envName,
      cleanLibrary: !!cleanLibrary,
      unityVersion: project.unityVersion,
      status: 'queued',
      createdAt: ts.getTime(),
      startedAt: null, endedAt: null, exitCode: null, artifacts: [],
    };
    fs.mkdirSync(path.join(JOBS_DIR, id), { recursive: true });
    this.save(meta);
    this.jobs.set(id, { meta, tracker: null, tail: [] });
    this.queue.push(id);
    this.emitUpdate(id);
    this.next();
    return this.get(id);
  }

  async cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return false;
    if (j.meta.status === 'queued') {
      this.queue = this.queue.filter((q) => q !== id);
      j.meta.status = 'cancelled';
      j.meta.endedAt = Date.now();
      this.save(j.meta);
      this.emitUpdate(id);
      return true;
    }
    if (j.meta.status === 'running') {
      j.cancelled = true;
      this.log(id, '>>> Cancel requested, stopping build...');
      unity.cancel(j.child);
      return true;
    }
    return false;
  }

  save(meta) {
    fs.writeFileSync(path.join(JOBS_DIR, meta.id, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  log(id, line) {
    const j = this.jobs.get(id);
    // Unity repeats some lines (e.g. licensing heartbeats) hundreds of times; keep only the first of a run.
    if (line === j.lastLine) return;
    j.lastLine = line;
    j.logStream.write(line + '\n');
    j.tail.push(line);
    if (j.tail.length > LOG_TAIL) j.tail.shift();
    if (j.tracker) j.tracker.line(line);
    this.emit('log', id, line);
  }

  emitUpdate(id) {
    this.emit('update', this.get(id));
  }

  // Stage durations of the last successful run with the same project/platform, for ETA.
  lastDurations(meta) {
    const prev = this.list().find((m) => m.status === 'succeeded' && m.projectId === meta.projectId &&
      m.platform === meta.platform && m.id !== meta.id && m.durations && !m.cleanLibrary === !meta.cleanLibrary);
    return prev ? prev.durations : null;
  }

  async next() {
    if (this.running || !this.queue.length) return;
    const id = this.queue.shift();
    this.running = id;
    try {
      await this.execute(id);
    } finally {
      this.running = null;
      this.next();
    }
  }

  async execute(id) {
    const j = this.jobs.get(id);
    const { meta } = j;
    const project = this.projects[meta.projectId];
    const onLine = (l) => this.log(id, l);
    j.logStream = fs.createWriteStream(this.logPath(id), { flags: 'a' });
    j.tracker = new ProgressTracker(meta.platform, this.lastDurations(meta));
    meta.status = 'running';
    meta.startedAt = Date.now();
    this.save(meta);
    this.emitUpdate(id);

    let ok = false;
    try {
      const outDir = path.join(OUTPUT_DIR, id);
      if (meta.platform !== 'license') {
        fs.mkdirSync(outDir, { recursive: true });
        j.tracker.start('sync');
        const synced = await syncProject(project, meta.branch, onLine);
        meta.commit = synced.commit;
        if (meta.environment) applyEnvironment(project, meta.environment, synced.dir, onLine);
        this.save(meta);
        this.emitUpdate(id);
        if (j.cancelled) throw new Error('cancelled');
        if (meta.cleanLibrary) unity.cleanLibrary(project, onLine);
      }

      j.tracker.start('start');
      const { cmd, args, detached } = unity.command(meta, project, outDir);
      onLine(`$ ${cmd} ${args.join(' ')}`);
      const code = await run(cmd, args, { onLine, detached, onSpawn: (c) => { j.child = c; } });
      meta.exitCode = code;
      if (j.cancelled) throw new Error('cancelled');
      if (code !== 0) throw new Error(`Unity exited with code ${code}`);

      if (meta.platform === 'ios') {
        j.tracker.start('finish');
        await postprocessIOS(project, outDir, onLine);
      }
      meta.artifacts = !fs.existsSync(outDir) ? [] : fs.readdirSync(outDir)
        .filter((f) => /\.(apk|aab|zip)$/.test(f))
        .map((f) => ({ name: f, size: fs.statSync(path.join(outDir, f)).size, url: `/output/${id}/${encodeURIComponent(f)}` }));
      if (meta.platform !== 'license' && !meta.artifacts.length) throw new Error('Build finished but produced no artifacts');
      ok = true;
    } catch (e) {
      onLine(`>>> ${e.message}`);
    } finally {
      j.tracker.finish(ok);
      meta.status = ok ? 'succeeded' : j.cancelled ? 'cancelled' : 'failed';
      meta.endedAt = Date.now();
      meta.durations = j.tracker.durations();
      meta.progress = j.tracker.snapshot();
      onLine(`>>> Job ${meta.status} in ${Math.round((meta.endedAt - meta.startedAt) / 1000)}s`);
      this.save(meta);
      if (meta.platform === 'license') fs.rmSync(unity.licenseTestDir(), { recursive: true, force: true });
      j.logStream.end();
      j.tracker = null;
      j.child = null;
      this.emitUpdate(id);
    }
  }
}

module.exports = { JobManager, OUTPUT_DIR };
