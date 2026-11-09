import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DIR = path.join(import.meta.dirname, '..');
// OPL: one way per line with its node locations; spaces in tag values are %20%.
const way = (id, tags, pts) => `w${id} v1 dV c0 t2026-01-01T00:00:00Z i0 u T${Object.entries(tags).map(([k, v]) => `${k}=${String(v).replace(/ /g, '%20%')}`).join(',')} N${pts.map(([x, y], i) => `n${id * 100 + i}x${x}y${y}`).join(',')}`;
const rel = (id, tags, wayIds) => `r${id} v1 dV c0 t2026-01-01T00:00:00Z i0 u T${Object.entries(tags).map(([k, v]) => `${k}=${String(v).replace(/ /g, '%20%')}`).join(',')} M${wayIds.map((w) => `w${w}@`).join(',')}`;
const line = (x0, x1, y, n = 12) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y]);

const OPL = [
  way(1, { highway: 'motorway', ref: 'I 635', name: 'Lyndon B Johnson Freeway' }, line(-96.80, -96.75, 32.92)),
  way(2, { highway: 'motorway', name: 'North Sam Houston Parkway East' }, line(-95.40, -95.35, 29.94)),
  way(3, { highway: 'primary', ref: '12', name: 'Main Street' }, line(-97.10, -97.09, 33.00)),
  way(4, { highway: 'secondary', unsigned_ref: '1002', name: 'Center Hill Road' }, line(-79.00, -78.99, 35.50)),
  way(5, { highway: 'motorway', ref: 'I 20', name: 'Interstate 20' }, line(-97.00, -96.90, 32.50)),
  way(6, { highway: 'primary', name: 'I 20 Frontage Road' }, line(-97.00, -96.90, 32.5005)),
  way(7, { highway: 'primary', name: 'Mockingbird Lane' }, line(-97.00, -96.90, 32.60)),
  rel(1, { type: 'route', route: 'road', network: 'US:TX:Loop', ref: '8' }, [2]),
  rel(2, { type: 'route', route: 'road', network: 'XX:Unknown', ref: '44' }, [3]),
].join('\n') + '\n';

const decode = (enc) => { const out = []; let la = 0, lo = 0; enc.split(' ').forEach((t, i) => { const p = t.split(',').map(Number); if (i === 0) [la, lo] = p; else if (p.length === 1) lo += p[0]; else { la += p[0]; lo += p[1]; } out.push(`${la}:${lo}`); }); return out; };

test('names: refs by name, relation refs with their network word, unsigned SR numbers, frontage; bare numbers dropped', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', path.join(work, 'names')], { input: OPL });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', 'TX.json.gz'))));
  assert.equal(idx.grid, 100);
  assert.deepEqual(Object.keys(idx.names['LYNDON B JOHNSON FREEWAY']), ['I 635']);
  assert.ok(decode(idx.names['LYNDON B JOHNSON FREEWAY']['I 635']).includes('3292:-9680'));
  assert.deepEqual(Object.keys(idx.names['NORTH SAM HOUSTON PARKWAY EAST']), ['Loop 8']);
  assert.equal(idx.names['MAIN STREET'], undefined); // ref "12" and an unknown network's "44" are bare numbers
  assert.deepEqual(Object.keys(idx.names['CENTER HILL ROAD']), ['SR 1002']);
  assert.ok(idx.frontage['I 20']['I 20 FRONTAGE ROAD']);
  assert.equal(idx.frontage['I 20']['MOCKINGBIRD LANE'], undefined); // 11 km away
  // gzip with mtime 0: the same input builds byte-identical files, so publish copies an unchanged state.
  const again = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', again], { input: OPL });
  assert.deepEqual(fs.readFileSync(path.join(again, 'TX.json.gz')), fs.readFileSync(path.join(work, 'names', 'TX.json.gz')));
});

test('names: finish lists every state with size and SHA-256; publish puts them under the pointer, pointer last', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-')), store = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  for (const st of ['texas', 'oklahoma']) execFileSync('python3', [path.join(DIR, 'names.py'), st, path.join(work, 'names')], { input: OPL });
  // extras.mjs adds non-state sources to sources.txt (2026-11-09: "51 road-name files for 53 states"); they don't count.
  fs.writeFileSync(path.join(work, 'sources.txt'), 'texas 2026-11-08\noklahoma 2026-11-08\nalltheplaces 2026-10-31\nntad-truck-stop-parking 2026-11-09\n');
  execFileSync('node', [path.join(DIR, 'names.mjs'), 'finish', work, '2']);
  const build = JSON.parse(fs.readFileSync(path.join(work, 'names.json'), 'utf8'));
  assert.deepEqual(Object.keys(build.states), ['OK', 'TX']);
  execFileSync('node', [path.join(DIR, 'publish.mjs')], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'names' } });
  const pointer = JSON.parse(fs.readFileSync(path.join(store, 'names/current.json'), 'utf8'));
  assert.deepEqual(pointer, { version: build.buildId, path: `names/v1/${build.buildId}`, states: build.states });
  const tx = fs.readFileSync(path.join(store, pointer.path, 'TX.json.gz'));
  assert.equal(tx.length, pointer.states.TX.bytes);
  assert.equal(crypto.createHash('sha256').update(tx).digest('hex'), pointer.states.TX.sha256);
  assert.deepEqual(fs.readdirSync(store).sort(), ['locks', 'names']); // roads/, signals/ … untouched
});

test('names: finish refuses a build missing a state', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', path.join(work, 'names')], { input: OPL });
  assert.throws(() => execFileSync('node', [path.join(DIR, 'names.mjs'), 'finish', work, '2'], { stdio: 'pipe' }), /1 road-name files for 2 states/);
  assert.throws(() => execFileSync('node', [path.join(DIR, 'names.mjs'), 'finish', work], { stdio: 'pipe' }), /usage/);
});
