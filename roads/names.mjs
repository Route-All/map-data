// Road names (names.py, format/names.md): after build.sh has written <work>/names/<ST>.json.gz for every state,
//   node names.mjs finish <work> <states>   writes <work>/names.json: { buildId, builtAt, states: { TX: { bytes, sha256 } } }
// publish.mjs (KIND=names) uploads the files and puts the same `states` in names/current.json, so the phone checks
// every file it downloads against the pointer's size and SHA-256 before using it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function finish(work, expected) {
  const dir = path.join(work, 'names');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^[A-Z]{2}\.json\.gz$/.test(f)).sort() : [];
  // Every state build.sh read must have its file: a missing state would silently drop a whole state's names.
  // build.sh passes how many states it built. Not sources.txt: extras.mjs adds non-state sources to it.
  if (!files.length || files.length !== expected) throw new Error(`${files.length} road-name files for ${expected} states`);
  const states = {};
  for (const f of files) {
    const bytes = fs.readFileSync(path.join(dir, f));
    states[f.slice(0, 2)] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }
  const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const build = { buildId: builtAt.replace(/[-:]/g, ''), builtAt, states };
  fs.writeFileSync(path.join(work, 'names.json'), JSON.stringify(build, null, 1) + '\n');
  console.log(`road names: ${files.length} states, ${(Object.values(states).reduce((t, s) => t + s.bytes, 0) / 1e6).toFixed(1)} MB gzip`);
  return build;
}

const [cmd, work, states] = process.argv[1]?.endsWith('names.mjs') ? process.argv.slice(2) : [];
if (cmd === 'finish' && Number(states) > 0) finish(work, Number(states));
else if (cmd) throw new Error('usage: node names.mjs finish <work dir> <number of states built>');
