const fs = require('fs');
const path = require('path');
const express = require('express');
const { ROOT, readVersions, listBranches } = require('./sync');
const { JobManager, OUTPUT_DIR } = require('./jobs');
const unity = require('./unity');

// Minimal .env loader (KEY=VALUE, # comments). Existing env vars win.
function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function loadProjects() {
  const dir = path.join(ROOT, 'projects');
  const projects = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    projects[p.id] = p;
  }
  return projects;
}

loadEnv();
const projects = loadProjects();
const jobs = new JobManager(projects);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/output', express.static(OUTPUT_DIR));

app.get('/api/projects', (req, res) => {
  res.json(Object.values(projects).map((p) => ({
    id: p.id, name: p.name, unityVersion: p.unityVersion, versions: readVersions(p),
    repo: p.source.url, defaultBranch: p.source.defaultBranch,
    environments: Object.entries(p.environments || {}).map(([id, e]) => ({ id, label: e.label || id, url: e.url })),
    defaultEnvironment: p.defaultEnvironment,
    problems: { android: unity.problems(p, 'android'), ios: unity.problems(p, 'ios') },
  })));
});

app.get('/api/projects/:id/branches', async (req, res) => {
  const p = projects[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  try {
    res.json(await listBranches(p, { refresh: req.query.refresh === '1' }));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/jobs', (req, res) => res.json(jobs.list()));

app.post('/api/jobs', (req, res) => {
  const { projectId, platform, ...opts } = req.body || {};
  try {
    const platforms = platform === 'both' ? ['android', 'ios'] : [platform];
    res.json(platforms.map((p) => jobs.create({ projectId, platform: p, ...opts })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  return job ? res.json(job) : res.status(404).json({ error: 'not found' });
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  res.json({ ok: await jobs.cancel(req.params.id) });
});

app.get('/api/jobs/:id/log', (req, res) => {
  const file = jobs.logPath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type('text/plain').sendFile(file);
});

// Server-sent events: job list updates for everyone, log lines for the job given in ?job=
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const watch = req.query.job;
  if (watch) send('tail', { id: watch, lines: jobs.tail(watch) });
  const onUpdate = (job) => send('update', job);
  const onLog = (id, line) => id === watch && send('log', { id, line });
  jobs.on('update', onUpdate);
  jobs.on('log', onLog);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    jobs.off('update', onUpdate);
    jobs.off('log', onLog);
  });
});

const port = Number(process.env.PORT || 4567);
app.listen(port, '127.0.0.1', () => console.log(`Unity build dashboard: http://localhost:${port}`))
  .on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    console.error(`Port ${port} is already in use - probably another unity-build server is running.`);
    console.error(`  See what holds it:  lsof -nP -iTCP:${port} -sTCP:LISTEN`);
    console.error(`  Stop it:            kill $(lsof -ti tcp:${port})`);
    console.error('  Or use another port: PORT=4568 npm start  (or PORT=... in .env)');
    process.exit(1);
  });
