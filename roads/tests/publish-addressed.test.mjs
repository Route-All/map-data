import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

// Publishes v2 builds into a folder store exactly as the workflow does, and checks the mark-and-sweep: a manifest
// older than 35 days goes unless current or previous, and an object goes only when no kept manifest lists it.
const PUBLISH = new URL('../publish.mjs', import.meta.url).pathname;
const id = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

function build(work, buildId, tiles) {
  fs.mkdirSync(path.join(work, 'tiles2'), { recursive: true });
  const listed = {};
  for (const [key, text] of Object.entries(tiles)) {
    const bytes = Buffer.from(text), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(work, 'tiles2', `${sha256}.bin`), bytes);
    listed[key] = { key: `roads/v2/objects/${sha256}.bin`, sha256, bytes: bytes.length };
  }
  fs.writeFileSync(path.join(work, 'manifest2.json'), JSON.stringify({ schema: 2, buildId, coverage: { states: [], complete: false }, tiles: listed }));
  return listed;
}

test('v2 publish: pointer last, 35-day manifests, shared objects survive the sweep', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rat2-')), store = path.join(root, 'store');
  const run = (work) => execFileSync('node', [PUBLISH], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'roads2' } }).toString();
  const a = build(path.join(root, 'a'), id(40), { '1_1': 'shared', '1_2': 'only in a' });
  run(path.join(root, 'a'));
  const b = build(path.join(root, 'b'), id(39), { '1_1': 'shared', '1_2': 'only in b' });
  run(path.join(root, 'b'));
  const c = build(path.join(root, 'c'), id(0), { '1_1': 'shared', '1_2': 'only in c' });
  run(path.join(root, 'c'));
  const exists = (o) => fs.existsSync(path.join(store, o.key));
  const pointer = JSON.parse(fs.readFileSync(path.join(store, 'roads/v2/current.json'), 'utf8'));
  assert.equal(pointer.buildId, id(0));
  assert.equal(pointer.previous, id(39)); // b is previous: kept although 39 days old
  assert.equal(fs.existsSync(path.join(store, `roads/v2/${id(40)}/manifest.json`)), false);
  assert.equal(exists(a['1_2']), false); // listed only by the retired manifest
  assert.ok(exists(a['1_1']) && exists(b['1_2']) && exists(c['1_2']));
});
