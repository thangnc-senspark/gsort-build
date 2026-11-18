const { spawn } = require('child_process');

// Runs a command, streaming each output line to onLine. Resolves with the exit code.
function run(cmd, args, { onLine, env, cwd, onSpawn, detached } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: env || process.env, cwd, detached: !!detached });
    if (onSpawn) onSpawn(child);
    const pipe = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (onLine) onLine(line);
        }
      });
      stream.on('end', () => {
        if (buf && onLine) onLine(buf);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve(code === null ? 128 : code));
  });
}

module.exports = { run };
