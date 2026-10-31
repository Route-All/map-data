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
  const [d40, d39, d0] = [id(40), id(39), id(0)]; // once: a second passing must not change a build id
  const run = (work) => execFileSync('node', [PUBLISH], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'roads2' } }).toString();
  const a = build(path.join(root, 'a'), d40, { '1_1': 'shared', '1_2': 'only in a' });
  run(path.join(root, 'a'));
  const b = build(path.join(root, 'b'), d39, { '1_1': 'shared', '1_2': 'only in b' });
  run(path.join(root, 'b'));
  const c = build(path.join(root, 'c'), d0, { '1_1': 'shared', '1_2': 'only in c' });
  run(path.join(root, 'c'));
  const exists = (o) => fs.existsSync(path.join(store, o.key));
  const pointer = JSON.parse(fs.readFileSync(path.join(store, 'roads/v2/current.json'), 'utf8'));
  assert.equal(pointer.buildId, d0);
  assert.equal(pointer.previous, d39); // b is previous: kept although 39 days old
  assert.equal(fs.existsSync(path.join(store, `roads/v2/${d40}/manifest.json`)), false);
  assert.equal(exists(a['1_2']), false); // listed only by the retired manifest
  assert.ok(exists(a['1_1']) && exists(b['1_2']) && exists(c['1_2']));
});

// Schema 3: the top-level manifest lists block manifests, each listing its packs.
function build3(work, buildId, blocks) {
  const dir = path.join(work, 'tiles2');
  fs.mkdirSync(path.join(dir, 'packs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
  const listed = {}, packs = {};
  for (const [block, text] of Object.entries(blocks)) {
    const pack = Buffer.from(text), ps = crypto.createHash('sha256').update(pack).digest('hex');
    fs.writeFileSync(path.join(dir, 'packs', `${ps}.bin`), pack);
    packs[block] = { key: `roads/v2/packs/${ps}.bin`, sha256: ps, bytes: pack.length };
    const body = JSON.stringify({ schema: 3, block, packs: [packs[block]], tiles: { '1_1': { key: packs[block].key, offset: 0, bytes: pack.length } } });
    const bs = crypto.createHash('sha256').update(body).digest('hex');
    fs.writeFileSync(path.join(dir, 'blocks', `${bs}.json`), body);
    listed[block] = { key: `roads/v2/blocks/${bs}.json`, sha256: bs, bytes: body.length };
  }
  fs.writeFileSync(path.join(work, 'manifest2.json'), JSON.stringify({ schema: 3, buildId, coverage: { states: [], complete: false }, blocks: listed }));
  return { listed, packs };
}

test('v2 publish, schema 3: a schema-2 build stays readable as previous; blocks and packs are marked and swept', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rat3-')), store = path.join(root, 'store');
  const run = (work) => execFileSync('node', [PUBLISH], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'roads2' } }).toString();
  const exists = (o) => fs.existsSync(path.join(store, o.key));
  const [d40, d39, d0] = [id(40), id(39), id(0)]; // once: a second passing must not change a build id
  const old = build(path.join(root, 'a'), d40, { '1_1': 'schema 2 tile' });
  run(path.join(root, 'a'));
  const b = build3(path.join(root, 'b'), d39, { '0_0': 'shared pack', '0_1': 'only in b' });
  run(path.join(root, 'b'));
  const pointer = () => JSON.parse(fs.readFileSync(path.join(store, 'roads/v2/current.json'), 'utf8'));
  const text = fs.readFileSync(path.join(store, `roads/v2/${d39}/manifest.json`));
  assert.deepEqual({ ...pointer(), previous: undefined }, { buildId: d39, manifest: `roads/v2/${d39}/manifest.json`, schema: 3,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), bytes: text.length, previous: undefined });
  assert.equal(pointer().previous, d40);
  assert.ok(exists(old['1_1'])); // the schema-2 build is previous: its tile is kept
  const c = build3(path.join(root, 'c'), d0, { '0_0': 'shared pack', '0_1': 'only in c' });
  run(path.join(root, 'c'));
  assert.equal(pointer().previous, d39);
  assert.equal(exists(old['1_1']), false); // listed only by the retired schema-2 manifest
  assert.ok(exists(b.listed['0_0']) && exists(b.packs['0_0']) && exists(b.packs['0_1']) && exists(c.packs['0_1']));
  assert.equal(b.packs['0_0'].key, c.packs['0_0'].key); // the same bytes are one object
});
