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
  // v2: a relation's own names over every member way, whatever the way's own ref; TIGER name_1 / short_name; designations left out.
  way(8, { highway: 'trunk', ref: 'US 59', name: 'Saunders Street' }, line(-99.50, -99.45, 27.55)),
  way(9, { highway: 'primary', ref: 'I 35;US 77', name: 'North Interregional Highway', name_1: 'State Highway 9', short_name: 'IH Access' }, line(-97.70, -97.69, 30.30)),
  way(10, { highway: 'motorway', ref: 'I 76', name: 'Mainline' }, line(-77.00, -76.95, 40.20)),
  // v3: renumbered roads and a concurrency kept only on the relation.
  way(11, { highway: 'motorway', ref: 'I 42', old_ref: 'US 70', name: 'Clayton Bypass' }, line(-78.45, -78.40, 35.625)),
  way(12, { highway: 'motorway', ref: 'US 59', fut_ref: 'I 69' }, line(-95.10, -95.05, 30.345)),
  way(13, { highway: 'motorway', ref: 'US 59' }, line(-95.05, -95.00, 30.345)),
  way(14, { highway: 'motorway', ref: 'I 69;US 59' }, line(-95.00, -94.95, 30.345)),
  way(15, { highway: 'motorway', ref: 'US 70', old_ref: '70' }, line(-78.40, -78.35, 35.625)),
  way(16, { highway: 'primary', old_ref: 'US 80', name: 'Old Alignment Road' }, line(-97.30, -97.25, 31.505)),
  way(17, { highway: 'primary', ref: 'FM 157', old_ref: 'Loop 496 (old US 287)', name: 'Cooper Street' }, line(-97.20, -97.15, 31.505)),
  rel(5, { type: 'route', route: 'road', network: 'US:I', ref: '69' }, [12, 13, 14]),
  rel(3, { type: 'route', route: 'road', network: 'US:TX:Loop', ref: '20', name: 'Bob Bullock Loop', alt_name: 'Loop 1 (MoPac)', official_name: 'US 59 (TX)' }, [8]),
  rel(4, { type: 'route', route: 'road', network: 'US:I', ref: 'I 76', name: 'Pennsylvania Turnpike' }, [10]),
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
  assert.deepEqual(Object.keys(idx.names['BOB BULLOCK LOOP']), ['Loop 20']); // the relation's name, on a way that carries US 59 itself
  assert.ok(decode(idx.names['BOB BULLOCK LOOP']['Loop 20']).includes('2755:-9950'));
  assert.deepEqual(Object.keys(idx.names['SAUNDERS STREET']), ['Loop 20', 'US 59']);
  assert.deepEqual(Object.keys(idx.names['LOOP 1 (MOPAC)']), ['Loop 20']); // a designation with a name in it is kept
  assert.equal(idx.names['US 59 (TX)'], undefined); // a bare designation is not
  assert.deepEqual(Object.keys(idx.names['PENNSYLVANIA TURNPIKE']), ['I 76']);
  assert.deepEqual(Object.keys(idx.names['NORTH INTERREGIONAL HIGHWAY']), ['I 35', 'US 77']); // "I 35;US 77": both
  assert.deepEqual(Object.keys(idx.names['IH ACCESS']), ['I 35', 'US 77']);
  assert.equal(idx.names['STATE HIGHWAY 9'], undefined); // TIGER's name_1 naming a number is left to the app's parser
  // v3: a renumbered road's old number with its names and its current ref; a future number; a relation's ref on member ways that lack it.
  assert.deepEqual(Object.keys(idx.names['CLAYTON BYPASS']), ['I 42', 'US 70']);
  assert.deepEqual(Object.keys(idx.aliases['US 70']), ['I 42']);
  assert.ok(decode(idx.aliases['US 70']['I 42']).includes('3562:-7845'));
  assert.deepEqual(Object.keys(idx.aliases['I 69']), ['US 59']); // way 12's fut_ref and way 13 in the I 69 relation (unnamed both)
  assert.ok(decode(idx.aliases['I 69']['US 59']).includes('3034:-9510')); // way 12
  assert.ok(decode(idx.aliases['I 69']['US 59']).includes('3034:-9502')); // way 13
  assert.ok(!decode(idx.aliases['I 69']['US 59']).includes('3034:-9497')); // way 14 carries I 69 itself
  assert.equal(idx.aliases['70'], undefined); // a bare old number names no network
  assert.deepEqual(Object.keys(idx.aliases['Loop 20']), ['US 59']); // Bob Bullock Loop's member way is signed US 59 only
  assert.equal(idx.names['OLD ALIGNMENT ROAD'], undefined); // an old_ref with no current ref is the old road, no longer US 80
  assert.deepEqual(Object.keys(idx.names['COOPER STREET']), ['FM 157']); // a history in old_ref is not a ref
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

test('names: a lettered or single-digit designation in TIGER name_1 is not tied to the way ref (Fable review, PR #23)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-letter-'));
  const opl = [
    way(901, { highway: 'primary', ref: 'WI 21', name: 'Main Street', name_1: 'County Road F' }, line(-89.5, -89.4, 44.1)),
    way(902, { highway: 'primary', ref: 'US 395', name_1: 'U.S. Route 9', name_2: 'I-5 (BUS)' }, line(-117.5, -117.4, 47.6)),
  ].join('\n') + '\n';
  execFileSync('python3', [path.join(DIR, 'names.py'), 'wisconsin', path.join(work, 'names')], { input: opl });
  const out = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', 'WI.json.gz'))).toString());
  assert.ok(out.names['MAIN STREET']?.['WI 21'], 'the way name is still tied');
  for (const n of ['COUNTY ROAD F', 'U.S. ROUTE 9', 'I-5 (BUS)']) assert.equal(out.names[n], undefined, `${n} must not be indexed`);
});

test('names v3 aliases: old alignments, spelling, network shapes, business routes (Fable review, PR #24)', () => {
  const opl = [
    // An old alignment beside a lower network: AR 367 is old US 67, and US 67 still runs nearby. No tie either way.
    way(1, { highway: 'primary', ref: 'AR 367', old_ref: 'US 67', name: 'Old Highway Road' }, line(-92.00, -91.95, 35.005)),
    // A freeway that became a state route is not its old US route (WI 175, old US 41).
    way(11, { highway: 'motorway', ref: 'WI 175', old_ref: 'US 41', name: 'Stadium Freeway' }, line(-87.95, -87.90, 43.005)),
    // An Interstate keeps its old number (I 42 / US 70), as does a US route renumbered as a US route.
    way(2, { highway: 'motorway', ref: 'I 42', old_ref: 'US 70', name: 'Clayton Bypass' }, line(-78.45, -78.40, 35.625)),
    way(3, { highway: 'primary', ref: 'US 491', old_ref: 'US 666', name: 'Devils Highway' }, line(-108.80, -108.75, 36.505)),
    // The relation's ref spelled otherwise on the way (OH 121 / SR 121): carried, so no alias, and nothing dragged in (SR 49).
    way(4, { highway: 'primary', ref: 'SR 121;SR 49' }, line(-84.50, -84.45, 40.005)),
    rel(1, { type: 'route', route: 'road', network: 'US:OH', ref: '121' }, [4]),
    // A printed key with no network ("A" over "CTH A"; a county network id) is no ref.
    way(5, { highway: 'secondary', ref: 'CTH A' }, line(-89.40, -89.35, 43.005)),
    rel(2, { type: 'route', route: 'road', network: 'US:WI:Dane', ref: 'A' }, [5]),
    // An Interstate business loop is "I 75 Business", not "Loop 75"; a business route's bare unsigned_ref is no "SR 96E".
    way(6, { highway: 'primary', ref: 'US 224' }, line(-83.70, -83.65, 41.005)),
    rel(3, { type: 'route', route: 'road', network: 'US:I:Business:Loop', ref: '75', unsigned_ref: '96E' }, [6]),
    // A relation's old_ref goes the same way as a way's: kept on a freeway member, dropped beside a lower network.
    way(7, { highway: 'motorway', ref: 'I 42' }, line(-78.40, -78.35, 35.625)),
    rel(4, { type: 'route', route: 'road', network: 'US:I', ref: '42', old_ref: 'US 70' }, [7]),
    way(8, { highway: 'primary', ref: 'AR 367' }, line(-91.95, -91.90, 35.005)),
    rel(5, { type: 'route', route: 'road', network: 'US:AR', ref: '367', old_ref: 'US 67' }, [8]),
    // Of "US 67B;AR 367" with old_ref US 67, only US 67B takes it.
    way(10, { highway: 'primary', ref: 'US 67B;AR 367', old_ref: 'US 67' }, line(-91.90, -91.85, 35.005)),
    // A hidden state number on a way (TN's US 41 is SR 2): an alias.
    way(9, { highway: 'primary', ref: 'US 41', unsigned_ref: '2' }, line(-86.80, -86.75, 36.105)),
  ].join('\n') + '\n';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', work], { input: opl });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'TX.json.gz'))));
  assert.deepEqual(Object.keys(idx.aliases['US 67']), ['US 67B']);
  assert.deepEqual(Object.keys(idx.names['OLD HIGHWAY ROAD']), ['AR 367']);
  assert.deepEqual(Object.keys(idx.names['CLAYTON BYPASS']), ['I 42', 'US 70']);
  assert.deepEqual(Object.keys(idx.aliases['US 70']), ['I 42']);
  assert.ok(decode(idx.aliases['US 70']['I 42']).includes('3562:-7837')); // way 7, through relation 4's old_ref
  assert.deepEqual(Object.keys(idx.aliases['US 666']), ['US 491']);
  assert.deepEqual(Object.keys(idx.names['STADIUM FREEWAY']), ['WI 175']);
  assert.equal(idx.aliases['OH 121'], undefined);
  assert.equal(idx.aliases.A, undefined);
  assert.deepEqual(Object.keys(idx.aliases['I 75 Business']), ['US 224']);
  assert.equal(idx.aliases['Loop 75'], undefined);
  assert.equal(idx.aliases['SR 96E'], undefined);
  assert.deepEqual(Object.keys(idx.aliases['SR 2']), ['US 41']);
  assert.deepEqual(Object.keys(idx.aliases).sort(), ['I 75 Business', 'SR 2', 'US 666', 'US 67', 'US 70']);
});
