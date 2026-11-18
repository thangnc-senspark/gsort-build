const fs = require('fs');
const path = require('path');
const { run } = require('./util');

// iOS: strip pods that must not ship (README: Yandex) and zip the Xcode project for download.
async function postprocessIOS(project, outDir, onLine) {
  const xcodeDir = path.join(outDir, 'ios-xcode');
  if (!fs.existsSync(xcodeDir)) throw new Error('Xcode project was not produced');

  const podfile = path.join(xcodeDir, 'Podfile');
  const patterns = (project.ios && project.ios.podfileStripPatterns) || [];
  if (fs.existsSync(podfile) && patterns.length) {
    const lines = fs.readFileSync(podfile, 'utf8').split('\n');
    const kept = lines.filter((l) => !patterns.some((p) => l.includes(p)));
    const removed = lines.filter((l) => patterns.some((p) => l.includes(p)));
    fs.writeFileSync(podfile, kept.join('\n'));
    onLine(`Podfile: removed ${removed.length} line(s)${removed.length ? ':' : ''}`);
    removed.forEach((l) => onLine(`  - ${l.trim()}`));
  } else {
    onLine('Podfile not found or nothing to strip');
  }

  onLine('Zipping Xcode project...');
  const code = await run('zip', ['-qry', 'ios-xcode.zip', 'ios-xcode'], { cwd: outDir, onLine });
  if (code !== 0) throw new Error(`zip exited with ${code}`);
}

module.exports = { postprocessIOS };
