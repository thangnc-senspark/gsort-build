// Build-time server environment (test/prod), applied to the workspace checkout before Unity starts.
const fs = require('fs');
const path = require('path');

function environments(project) {
  return project.environments || {};
}

// Rewrites source files so the build targets the chosen server. Every patch must match, otherwise the
// project changed shape and we refuse to build rather than silently ship the wrong server.
function applyEnvironment(project, envName, dir, onLine) {
  const env = environments(project)[envName];
  if (!env) throw new Error(`Unknown environment ${envName}`);
  for (const p of env.patches || []) {
    const file = path.join(dir, p.file);
    const text = fs.readFileSync(file, 'utf8');
    const re = new RegExp(p.find, 'm');
    if (!re.test(text)) throw new Error(`Environment patch did not match in ${p.file}: /${p.find}/`);
    const out = text.replace(re, p.replace);
    fs.writeFileSync(file, out);
    onLine(`Server ${env.label || envName}: ${p.file} -> ${out.match(re)[0]}`);
  }
}

module.exports = { environments, applyEnvironment };
