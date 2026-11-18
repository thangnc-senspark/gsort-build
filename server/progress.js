// Turns Unity/Gradle log lines into stage + percentage.
// Stages only move forward; percentage within a stage is estimated from the
// previous successful run's stage durations (or a default time constant).

const STAGES = {
  android: [
    { id: 'sync', label: 'Sync source', weight: 3, tau: 30 },
    { id: 'start', label: 'Start Unity + license', weight: 4, tau: 60 },
    { id: 'packages', label: 'Resolve packages', weight: 8, tau: 120 },
    { id: 'import', label: 'Import assets + compile scripts', weight: 40, tau: 1200 },
    { id: 'player', label: 'Build player (scenes, IL2CPP)', weight: 25, tau: 900 },
    { id: 'native', label: 'Gradle', weight: 18, tau: 600 },
    { id: 'finish', label: 'Collect artifacts', weight: 2, tau: 20 },
  ],
  ios: [
    { id: 'sync', label: 'Sync source', weight: 3, tau: 30 },
    { id: 'start', label: 'Start Unity + license', weight: 4, tau: 60 },
    { id: 'packages', label: 'Resolve packages', weight: 8, tau: 120 },
    { id: 'import', label: 'Import assets + compile scripts', weight: 40, tau: 1200 },
    { id: 'player', label: 'Build player (scenes, IL2CPP)', weight: 30, tau: 900 },
    { id: 'native', label: 'Export Xcode project', weight: 10, tau: 300 },
    { id: 'finish', label: 'Patch Podfile + zip', weight: 5, tau: 60 },
  ],
  license: [
    { id: 'start', label: 'Start Unity', weight: 30, tau: 30 },
    { id: 'license', label: 'Activate license', weight: 60, tau: 60 },
    { id: 'finish', label: 'Finish', weight: 10, tau: 5 },
  ],
};

// First matching rule wins; a rule can only advance the stage.
const RULES = [
  { re: /\[Package Manager\] (Connected|Resolv|Registered)|Resolving packages/, stage: 'packages' },
  // Unity 6 imports assets and compiles scripts interleaved inside the initial refresh.
  { re: /AssetDatabase Initial Refresh Start|Start importing|Asset Pipeline Refresh|Starting script compilation|DisplayProgressbar: Importing/, stage: 'import' },
  { re: /^##UBS stage=(configure|build|player)/, stage: 'player' },
  { re: /DisplayProgressbar: .*(Gradle|gradle)|Starting a Gradle Daemon|> Task :/, stage: 'native', only: 'android' },
  { re: /DisplayProgressbar: .*(Xcode|Generating Xcode|Copying)|Exporting Xcode|^##UBS stage=postprocess/, stage: 'native', only: 'ios' },
  { re: /^##UBS stage=postprocess/, stage: 'native', only: 'android' },
];

const ERROR_RE = /error CS\d+|BuildFailedException|FAILURE: Build failed|Build Failed|No valid Unity Editor license|\[UBS\] |Scripts have compiler errors|Aborting batchmode/;

class ProgressTracker {
  constructor(kind, history) {
    this.kind = kind; // 'android' | 'ios' | 'license'
    this.stages = STAGES[kind].map((s) => ({ ...s, status: 'pending', startedAt: null, endedAt: null }));
    this.index = -1;
    this.detail = '';
    this.errors = [];
    this.artifacts = [];
    this.history = history || null; // { stageId: seconds } from the last successful run
  }

  start(stageId) {
    const i = this.stages.findIndex((s) => s.id === stageId);
    if (i <= this.index || i < 0) return;
    const now = Date.now();
    for (let k = Math.max(this.index, 0); k < i; k++) {
      const s = this.stages[k];
      if (s.status !== 'done') {
        s.status = 'done';
        s.startedAt = s.startedAt || now;
        s.endedAt = now;
      }
    }
    this.index = i;
    this.stages[i].status = 'running';
    this.stages[i].startedAt = now;
    if (stageId !== 'sync') this.detail = '';
  }

  line(text) {
    const pb = text.match(/DisplayProgressbar: (.+)/);
    if (pb) this.detail = pb[1].trim();
    const art = text.match(/^##UBS artifact (.+)$/);
    if (art) this.artifacts.push(Object.fromEntries([...art[1].matchAll(/(\w+)=(.*?)(?= \w+=|$)/g)].map((m) => [m[1], m[2]])));

    if (ERROR_RE.test(text) && this.errors.length < 200) this.errors.push(text.slice(0, 500));

    if (this.kind === 'license') {
      if (/\[Licensing::/.test(text)) this.start('license');
      return;
    }
    for (const r of RULES) {
      if (r.only && r.only !== this.kind) continue;
      if (r.re.test(text)) {
        this.start(r.stage);
        break;
      }
    }
  }

  finish(ok) {
    const now = Date.now();
    for (const s of this.stages) {
      if (s.status === 'running' || (ok && s.status === 'pending')) {
        s.status = ok ? 'done' : 'failed';
        s.startedAt = s.startedAt || now;
        s.endedAt = now;
      }
    }
    if (!ok) {
      const running = this.stages.find((s) => s.status === 'failed');
      if (!running && this.index >= 0) this.stages[this.index].status = 'failed';
    }
  }

  expected(s) {
    const h = this.history && this.history[s.id];
    return h && h > 0 ? h : null;
  }

  snapshot() {
    const now = Date.now();
    const total = this.stages.reduce((a, s) => a + s.weight, 0);
    let done = 0;
    let eta = 0;
    let etaKnown = !!this.history;
    for (const s of this.stages) {
      const exp = this.expected(s);
      if (s.status === 'done') {
        done += s.weight;
      } else if (s.status === 'running') {
        const elapsed = (now - s.startedAt) / 1000;
        const frac = exp ? Math.min(elapsed / exp, 0.97) : 1 - Math.exp(-elapsed / s.tau);
        done += s.weight * Math.min(frac, 0.97);
        if (exp) eta += Math.max(exp - elapsed, 5);
      } else if (s.status === 'pending') {
        if (exp) eta += exp;
        else etaKnown = false;
      }
    }
    return {
      percent: Math.round((done / total) * 1000) / 10,
      stage: this.index >= 0 ? this.stages[this.index].id : null,
      detail: this.detail,
      etaSeconds: etaKnown ? Math.round(eta) : null,
      stages: this.stages.map(({ id, label, status, startedAt, endedAt }) => ({ id, label, status, startedAt, endedAt })),
      errors: this.errors.slice(-30),
      artifacts: this.artifacts,
    };
  }

  durations() {
    const out = {};
    for (const s of this.stages) {
      if (s.startedAt && s.endedAt) out[s.id] = Math.round((s.endedAt - s.startedAt) / 1000);
    }
    return out;
  }
}

module.exports = { ProgressTracker, STAGES };
