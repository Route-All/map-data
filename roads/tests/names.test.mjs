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
    // A lettered business route is no US route: "US 67B;AR 367" with old_ref US 67 ties neither.
    way(10, { highway: 'primary', ref: 'US 67B;AR 367', old_ref: 'US 67' }, line(-91.90, -91.85, 35.005)),
    // Real cases, Fable review PR #24 (live OSM tags). AR: primary US 412B with old_ref US 412, beside trunk US 412.
    way(20, { highway: 'trunk', ref: 'US 412' }, line(-90.55, -90.45, 36.050)),
    way(21, { highway: 'primary', ref: 'US 412B', old_ref: 'US 412', name: 'Kingshighway' }, line(-90.55, -90.45, 36.053)),
    // NC: motorway I 795 with old_ref US 117; live US 117 runs alongside its first half only (x -77.95..-77.90).
    way(22, { highway: 'primary', ref: 'US 117', name: 'Old Goldsboro Road' }, line(-77.95, -77.90, 35.503)),
    way(23, { highway: 'motorway', ref: 'I 795', old_ref: 'US 117', name: 'Future Freeway' }, line(-77.95, -77.80, 35.500, 30)),
    // AR: "Hwy 14" names no network the app reads (it would read it as AR 14, which runs beside); junk shapes likewise.
    way(24, { highway: 'primary', ref: 'AR 14', name: 'Fourteen Road' }, line(-91.30, -91.25, 35.703)),
    way(25, { highway: 'primary', ref: 'AR 17', old_ref: 'Hwy 14', fut_ref: 'Exit 1A', official_ref: 'NASA 1', name: 'Seventeen Road' }, line(-91.30, -91.25, 35.700)),
    // One spelling per ref: "US-59" / "I-69" are "US 59" / "I 69".
    way(26, { highway: 'motorway', ref: 'US-59', fut_ref: 'I-69' }, line(-95.20, -95.15, 30.345)),
    // A hidden state number on a way (TN's US 41 is SR 2): an alias.
    way(9, { highway: 'primary', ref: 'US 41', unsigned_ref: '2' }, line(-86.80, -86.75, 36.105)),
  ].join('\n') + '\n';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', work], { input: opl });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'TX.json.gz'))));
  assert.equal(idx.aliases['US 67'], undefined); // neither AR 367 (lower) nor US 67B (a business route)
  assert.equal(idx.aliases['US 412'], undefined); // US 412B is not US 412, which runs beside it
  assert.deepEqual(Object.keys(idx.names.KINGSHIGHWAY), ['US 412B']);
  // I 795 is old US 117 only away from today's US 117: none of the squares beside it, the far half kept (names too).
  const i795 = decode(idx.aliases['US 117']['I 795']), us117 = decode(idx.names['OLD GOLDSBORO ROAD']['US 117']);
  const near = (c) => { const [la, lo] = c.split(':').map(Number); return us117.some((u) => { const [a, b] = u.split(':').map(Number); return Math.abs(a - la) <= 1 && Math.abs(b - lo) <= 1; }); };
  assert.ok(i795.length > 0 && !i795.some(near), 'no I 795 square within one of US 117');
  assert.ok(i795.includes('3550:-7782'), 'the far half keeps the old number');
  assert.deepEqual(decode(idx.names['FUTURE FREEWAY']['US 117']), i795);
  for (const k of ['Hwy 14', 'Exit 1A', 'NASA 1', 'US-59', 'I-69']) assert.equal(idx.aliases[k], undefined, k);
  assert.deepEqual(Object.keys(idx.names['SEVENTEEN ROAD']), ['AR 17']);
  assert.ok(decode(idx.aliases['I 69']['US 59']).includes('3034:-9520'));
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
  assert.deepEqual(Object.keys(idx.aliases).sort(), ['I 69', 'I 75 Business', 'SR 2', 'US 117', 'US 666', 'US 70']);
});

test('names: frontage only by its own name (not frontage_road=yes, not an Access Road name_1), and state DOT numbers (nysdot_ref, ref:penndot) (map-gaps)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-gaps-'));
  const opl = [
    // Amarillo: US 87 main lanes, a frontage road named "Dumas Drive" marked frontage_road=yes, and I 40's "East Interstate Drive" whose
    // name_1 says access road; a side street beside them that says neither stays out.
    way(1, { highway: 'motorway', ref: 'US 87;US 287', name: 'Dumas Freeway' }, line(-101.84, -101.80, 35.25)),
    way(2, { highway: 'secondary', name: 'Dumas Drive', frontage_road: 'yes' }, line(-101.84, -101.80, 35.2505)),
    way(3, { highway: 'motorway', ref: 'I 40' }, line(-101.84, -101.80, 35.20)),
    way(4, { highway: 'secondary', name: 'East Interstate Drive', name_1: 'Interstate Highway 40 Access Road' }, line(-101.84, -101.80, 35.2005)),
    way(5, { highway: 'secondary', name: 'Elm Street' }, line(-101.84, -101.80, 35.1995)),
    // Jamestown, NY: Strunk Road carries reference route 953B only in nysdot_ref; Lancaster County, PA: Snyder Road is SR 4017 in ref:penndot,
    // PA 283 is PennDOT's SR 0300, and a township's T number is no route.
    way(6, { highway: 'primary', name: 'Strunk Road', nysdot_ref: '953B' }, line(-79.28, -79.27, 42.12)),
    way(7, { highway: 'tertiary', name: 'Snyder Road', 'ref:penndot': 'SR4017' }, line(-76.55, -76.54, 40.15)),
    way(8, { highway: 'motorway', ref: 'PA 283', 'ref:penndot': 'SR 0300' }, line(-76.60, -76.55, 40.20)),
    way(9, { highway: 'unclassified', name: 'Hill Road', 'ref:penndot': 'T522' }, line(-76.50, -76.49, 40.10)),
    way(10, { highway: 'primary', ref: 'PA 230', name: 'Harrisburg Pike', 'ref:penndot': 'SR0230' }, line(-76.65, -76.60, 40.10)),
  ].join('\n') + '\n';
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', work], { input: opl });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'TX.json.gz'))));
  assert.equal(idx.frontage['US 87']?.['DUMAS DRIVE'], undefined); // frontage_road=yes alone is not enough (7 of 84 worse on AWS)
  assert.equal(idx.frontage['I 40']?.['EAST INTERSTATE DRIVE'], undefined); // an Access Road name_1 alone: 2 of 84 worse on AWS
  assert.equal(idx.frontage['I 40']?.['ELM STREET'], undefined);
  assert.deepEqual(Object.keys(idx.names['STRUNK ROAD']), ['NY 953B']);
  assert.deepEqual(Object.keys(idx.names['SNYDER ROAD']), ['SR 4017']);
  assert.deepEqual(idx.unsigned['NY 953B'], ['STRUNK ROAD']);
  assert.deepEqual(Object.keys(idx.aliases['SR 300']), ['PA 283']);
  assert.equal(idx.names['HILL ROAD'], undefined);
  assert.equal(idx.aliases['SR 230'], undefined); // the same number as the way's own PA 230
});

test('names: an old number two squares from where it runs today is the old alignment (alias-walk)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-alias-'));
  const opl = [
    // Hurst/Euless, TX (9c37e1c8): today's SH-183 is the Airport Freeway (row 3283); Hurst Blvd, TX 10 with old_ref SH 183, runs two squares
    // south (row 3281) and three (row 3280) further east. Two squares off is the old road; three is left to the app's own rule.
    way(1, { highway: 'motorway', ref: 'TX 121;TX 183', name: 'Airport Freeway' }, line(-97.20, -97.15, 32.835)),
    way(2, { highway: 'primary', ref: 'TX 10', old_ref: 'SH 183', name: 'West Hurst Boulevard' }, line(-97.20, -97.15, 32.815)),
    way(3, { highway: 'primary', ref: 'TX 10', old_ref: 'SH 183', name: 'East Euless Boulevard' }, line(-97.20, -97.15, 32.805)),
    // Fort Worth: I-20 pieces that were I-820 before
    // the renumbering (old_ref I 820), away from today's I-820, keep the old number: a renumbering, which the app reads only where I-820 stops.
    way(4, { highway: 'motorway', ref: 'I 820', name: 'Southwest Loop' }, line(-97.45, -97.43, 32.75)),
    way(5, { highway: 'motorway', ref: 'I 20', name: 'Ronald Reagan Memorial Highway' }, line(-97.43, -97.40, 32.70)),
    rel(1, { type: 'route', route: 'road', network: 'US:I', ref: '820' }, [4, 5]),
    way(6, { highway: 'motorway', ref: 'I 20', old_ref: 'I 820', name: 'Ronald Reagan Memorial Highway' }, line(-97.30, -97.25, 32.65)),
  ].join('\n') + '\n';
  execFileSync('python3', [path.join(DIR, 'names.py'), 'texas', work], { input: opl });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'TX.json.gz'))));
  const hurst = decode(idx.aliases['SH 183']['TX 10']);
  assert.ok(!hurst.some((c) => c.startsWith('3281:')), 'no Hurst Blvd square two rows from the Airport Freeway');
  assert.ok(hurst.some((c) => c.startsWith('3280:')), 'three rows off is kept');
  assert.equal(idx.names['WEST HURST BOULEVARD']?.['SH 183'], undefined);
  const i820 = decode(idx.aliases['I 820']['I 20']);
  assert.ok(i820.includes('3265:-9728'), 'the renumbered piece keeps its old number');
});

test('exits: finish and KIND=exits publish mirror the road names, under exits/ only', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'exits-')), store = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  fs.mkdirSync(path.join(work, 'exits'));
  for (const st of ['NC', 'TX']) fs.writeFileSync(path.join(work, 'exits', `${st}.json.gz`), zlib.gzipSync(JSON.stringify({ exits: [[35.6, -78.4, '97', 90, 'US 70', [1], 'I 95', [2]]] })));
  assert.throws(() => execFileSync('node', [path.join(DIR, 'exits.mjs'), 'finish', work, '3'], { stdio: 'pipe' }), /2 exit files for 3 states/);
  execFileSync('node', [path.join(DIR, 'exits.mjs'), 'finish', work, '2']);
  const build = JSON.parse(fs.readFileSync(path.join(work, 'exits.json'), 'utf8'));
  assert.deepEqual(Object.keys(build.states), ['NC', 'TX']);
  execFileSync('node', [path.join(DIR, 'publish.mjs')], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'exits' } });
  const pointer = JSON.parse(fs.readFileSync(path.join(store, 'exits/current.json'), 'utf8'));
  assert.deepEqual(pointer, { version: build.buildId, path: `exits/v1/${build.buildId}`, states: build.states });
  const nc = fs.readFileSync(path.join(store, pointer.path, 'NC.json.gz'));
  assert.equal(crypto.createHash('sha256').update(nc).digest('hex'), pointer.states.NC.sha256);
  assert.deepEqual(fs.readdirSync(store).sort(), ['exits', 'locks']); // names/, roads/ … untouched
});

test('names: a retired state number far from any road carrying it today names its old street; hand-kept ties are read inside their box (keyed regression)', () => {
  const run = (state, opl) => { const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
    execFileSync('python3', [path.join(DIR, 'names.py'), state, path.join(work, 'names')], { input: opl.join('\n') + '\n' });
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', fs.readdirSync(path.join(work, 'names'))[0])))); };
  // Clovis, NM: Brady Avenue is old NM 270 and carries no number now; Forest Road 270 is 200 mi away. A road beside today's NM 18 stays out.
  const nm = run('new-mexico', [
    way(1, { highway: 'tertiary', name: 'West Brady Avenue', old_ref: 'NM 270' }, line(-103.2669, -103.2317, 34.3903)),
    way(2, { highway: 'unclassified', ref: 'FR 270', name: 'Cerro Pelado Road' }, line(-106.61, -106.56, 35.77)),
    way(3, { highway: 'primary', ref: 'NM 18' }, line(-103.20, -103.15, 32.70)),
    way(4, { highway: 'tertiary', name: 'Old Lovington Highway', old_ref: 'NM 18' }, line(-103.20, -103.15, 32.80)),
    way(5, { highway: 'tertiary', name: 'Old Mother Road', old_ref: 'US 66' }, line(-108.20, -108.15, 35.50)),
  ]);
  assert.deepEqual(nm.unsigned['NM 270'], ['WEST BRADY AVENUE']);
  assert.ok(decode(nm.names['WEST BRADY AVENUE']['NM 270']).includes('3439:-10325'));
  assert.equal(nm.unsigned['NM 18'], undefined);
  assert.equal(nm.unsigned['US 66'], undefined);
  // South Dakota prints Rapid City's truck bypass "US-16B"; OSM refs it US 16 Truck. Only in the entry's box.
  const sd = run('south-dakota', [
    way(1, { highway: 'trunk', ref: 'US 16 Truck;SD 79', name: 'Elk Vale Road' }, line(-103.1512, -103.1512, 44.05)),
    way(2, { highway: 'trunk', ref: 'US 16 Truck', name: 'Far Away Road' }, line(-98.00, -97.95, 44.05)),
  ]);
  assert.deepEqual(Object.keys(sd.aliases['US 16B']), ['US 16 Truck']);
  assert.deepEqual(decode(sd.aliases['US 16B']['US 16 Truck']), ['4405:-10316']);
  assert.ok(sd.names['ELK VALE ROAD']['US 16B']);
  assert.equal(sd.names['FAR AWAY ROAD']['US 16B'], undefined);
  // NM 9 east of the Luna county line is OSM's "A003 County Road" with no ref (app trip 416a9284: 36.8 mi read as off the permit). Only in its box.
  const nm9 = run('new-mexico', [
    way(1, { highway: 'secondary', name: 'A003 County Road' }, line(-107.297, -106.685, 31.79)),
    way(2, { highway: 'secondary', name: 'A003 County Road' }, line(-108.20, -108.15, 32.50)),
  ]);
  assert.deepEqual(nm9.unsigned['NM 9'], ['A003 COUNTY ROAD']);
  const squares = decode(nm9.names['A003 COUNTY ROAD']['NM 9']);
  assert.ok(squares.includes('3179:-10700') && !squares.some((c) => c.startsWith('3250:')));
});

test('names: a numbered street named in alt_name on part of a road names the whole joined road of that name and ref (app trip 32591c0f)', () => {
  // Nodes shared end to end: Hassert Boulevard (CH 66) from IL-59 east; only the east way says alt_name 111th Street. A Hassert way that
  // does not join them, and a memorial alt_name, are left alone.
  const w = (id, tags, nodes) => `w${id} v1 dV c0 t2026-01-01T00:00:00Z i0 u T${Object.entries(tags).map(([k, v]) => `${k}=${String(v).replace(/ /g, '%20%')}`).join(',')} N${nodes.map(([n, x, y]) => `n${n}x${x}y${y}`).join(',')}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'illinois', path.join(work, 'names')], { input: [
    w(1, { highway: 'secondary', name: 'Hassert Boulevard', ref: 'CH 66' }, [[1, -88.2047, 41.6807], [2, -88.195, 41.6808]]),
    w(2, { highway: 'secondary', name: 'Hassert Boulevard', ref: 'CH 66', alt_name: 'Veterans Memorial Bridge' }, [[2, -88.195, 41.6808], [3, -88.185, 41.6809]]),
    w(3, { highway: 'secondary', name: 'Hassert Boulevard', ref: 'CH 66', alt_name: '111th Street' }, [[3, -88.185, 41.6809], [4, -88.1675, 41.6814]]),
    w(4, { highway: 'secondary', name: 'Hassert Boulevard', ref: 'CH 66' }, [[9, -87.50, 41.6807], [10, -87.49, 41.6807]]),
  ].join('\n') + '\n' });
  const idx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', 'IL.json.gz'))));
  const cells = decode(idx.names['111TH STREET']['CH 66']);
  assert.ok(cells.includes('4168:-8821') && cells.includes('4168:-8817')); // from IL-59 to the east end
  assert.ok(!cells.includes('4168:-8750'));
  assert.deepEqual(decode(idx.names['VETERANS MEMORIAL BRIDGE']['CH 66']), ['4168:-8820', '4168:-8819']); // its own way only
});

test('names: a county number kept as another name, a bypass only TIGER remembers, and a hand-kept printed name (map-fixes-1122)', () => {
  const run = (state, opl) => { const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
    execFileSync('python3', [path.join(DIR, 'names.py'), state, path.join(work, 'names')], { input: opl.join('\n') + '\n' });
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', fs.readdirSync(path.join(work, 'names'))[0])))); };
  // Montgomery County, AL (app trip 93a7830d): Wallahatchie Road is name_1 "County Road 83", no ref, residential. A way that has a ref keeps
  // TIGER's other county number out, and a way already named for its county number is the app's to read.
  const al = run('alabama', [
    way(1, { highway: 'residential', name: 'Wallahatchie Road', name_1: 'County Road 83' }, line(-86.1025, -86.0468, 32.305)),
    way(2, { highway: 'primary', ref: 'AL 110', name: 'Vaughn Road', name_1: 'County Road 12' }, line(-86.20, -86.15, 32.34)),
    way(3, { highway: 'tertiary', name: 'County Road 40', name_1: 'County Road 44' }, line(-86.20, -86.15, 32.10)),
  ]);
  assert.deepEqual(al.unsigned, { 'CR 83': ['WALLAHATCHIE ROAD'] });
  assert.ok(decode(al.names['WALLAHATCHIE ROAD']['CR 83']).includes('3230:-8611'));
  assert.equal(al.names['VAUGHN ROAD']['CR 12'], undefined);
  // Douglas, WY (app trip d40b2cbf): the west bypass is ref "WY 59", TIGER "State Highway 59 (Bypass)". WY 59 elsewhere is not a bypass, and
  // TIGER's bypass of another number, or on a route that is already a lesser one, ties nothing.
  const wy = run('wyoming', [
    way(1, { highway: 'trunk', ref: 'WY 59', name: 'State Highway 59', 'tiger:name_base': 'State Highway 59 (Bypass):State Highway 93' }, line(-105.4066, -105.3750, 42.775)),
    way(2, { highway: 'trunk', ref: 'WY 59', name: 'State Highway 59' }, line(-105.37, -105.30, 42.85)),
    way(3, { highway: 'primary', ref: 'WY 93', 'tiger:name_base': 'State Highway 59 (Bypass)' }, line(-105.50, -105.45, 42.70)),
    way(4, { highway: 'primary', ref: 'US 20 Business', 'tiger:name_base': 'US Hwy 20 (Bypass)' }, line(-106.40, -106.35, 42.86)),
  ]);
  assert.deepEqual(Object.keys(wy.aliases), ['WY 59 Bypass']);
  assert.deepEqual(decode(wy.aliases['WY 59 Bypass']['WY 59']), ['4277:-10541', '4277:-10540', '4277:-10539', '4277:-10538']);
  // Lansing, IL (app trips 1ea1ed18, bfc2bf20): IDOT's "I-80 OVERFLOW LANE" is the US 6 ramp chain off Torrence Avenue. Only that class, in the box.
  const il = run('illinois', [
    way(1, { highway: 'motorway_link', ref: 'US 6' }, line(-87.5588, -87.5476, 41.5777)),
    way(2, { highway: 'primary', ref: 'US 6;IL 83', name: 'Torrence Avenue' }, line(-87.5590, -87.5590, 41.5785)),
    way(3, { highway: 'motorway_link', ref: 'US 6' }, line(-87.70, -87.69, 41.60)),
  ]);
  assert.deepEqual(il.names['I-80 OVERFLOW LANE'], { 'US 6': '4157,-8756 1' });
});

test('names: hand-kept DOT numbers on named streets with no ref, only in their box (map-gaps-1127)', () => {
  const run = (state, opl) => { const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
    execFileSync('python3', [path.join(DIR, 'names.py'), state, path.join(work, 'names')], { input: opl.join('\n') + '\n' });
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', fs.readdirSync(path.join(work, 'names'))[0])))); };
  // PA trip 41f03819: PennDOT's SR 3093 is OSM's "Old 119" and SR 3095 "Technology Drive" near Scottdale; an "Old 119" elsewhere is not.
  const pa = run('pennsylvania', [
    way(1, { highway: 'secondary', name: 'Old 119' }, line(-79.5818, -79.5677, 40.1830)),
    way(2, { highway: 'secondary', name: 'Technology Drive' }, line(-79.5818, -79.5790, 40.1950)),
    way(3, { highway: 'secondary', name: 'Old 119' }, line(-79.70, -79.65, 40.40)),
    way(4, { highway: 'secondary', name: 'Technology Drive' }, line(-79.95, -79.90, 40.45)),
  ]);
  assert.deepEqual(pa.unsigned['SR 3093'], ['OLD 119']);
  assert.deepEqual(pa.unsigned['SR 3095'], ['TECHNOLOGY DRIVE']);
  assert.ok(decode(pa.names['OLD 119']['SR 3093']).includes('4018:-7957'));
  assert.ok(!decode(pa.names['OLD 119']['SR 3093']).some((c) => c.startsWith('4040:')));
  assert.ok(!decode(pa.names['TECHNOLOGY DRIVE']['SR 3095']).some((c) => c.startsWith('4045:')));
  // TX trip 3f0684fe: TxDOT prints US0059 for North Temple Drive (BU 59-H) at FM 2497, Diboll; only that 0.6 mi, never the rest of Temple Drive.
  const tx = run('texas', [
    way(1, { highway: 'primary', name: 'North Temple Drive' }, line(-94.7787, -94.7768, 31.2010)),
    way(2, { highway: 'primary', name: 'North Temple Drive' }, line(-94.7820, -94.7810, 31.1870)),
  ]);
  assert.deepEqual(tx.unsigned['US 59'], ['NORTH TEMPLE DRIVE']);
  assert.ok(decode(tx.names['NORTH TEMPLE DRIVE']['US 59']).includes('3120:-9478'));
  assert.ok(!decode(tx.names['NORTH TEMPLE DRIVE']['US 59']).some((c) => c.startsWith('3118:')));
});

test('names: a DOT name kept by way id (ways-extra) names an unsigned number on an unnamed way (NC SR-1544, map-gaps-1127)', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  execFileSync('python3', [path.join(DIR, 'names.py'), 'north-carolina', path.join(work, 'names')], { input: [
    way(1314788859, { highway: 'trunk', unsigned_ref: 'SR 1544' }, [[-77.82219, 36.06367], [-77.82292, 36.06395]]),
    way(1314788860, { highway: 'trunk', unsigned_ref: 'SR 1544' }, [[-77.82292, 36.06395], [-77.82301, 36.06398]]),
    way(99, { highway: 'trunk', unsigned_ref: 'SR 1544' }, [[-78.50, 35.50], [-78.49, 35.50]]),
  ].join('\n') + '\n' });
  const nc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(work, 'names', 'NC.json.gz'))));
  assert.deepEqual(nc.unsigned['SR 1544'], ['NORTH HALIFAX ROAD']);
  const cells = decode(nc.names['NORTH HALIFAX ROAD']['SR 1544']);
  assert.ok(cells.includes('3606:-7783') && !cells.some((c) => c.startsWith('3550:')));
});
