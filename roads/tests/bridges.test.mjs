import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DIR = path.join(import.meta.dirname, '..');
// Twelve real rows of FHWA's 2025 NBI delimited files (2025hwybronefiledel.zip; AZ25.txt and AL25.txt for the last four), unchanged.
const SAMPLE = path.join(import.meta.dirname, 'nbi-2025-sample.txt');
const py = (code) => JSON.parse(execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); import bridges as B\n${code}`],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
const decoded = py(`s, d = B.build(open(${JSON.stringify(SAMPLE)}, encoding='latin-1', newline=''))\nprint(json.dumps({'states': s, 'dropped': d}))`);
const bridge = (st, id) => decoded.states[st].find((b) => b[2] === id);
const F = Object.fromEntries(py('print(json.dumps(B.FIELDS))').map((f, i) => [f, i]));
const field = (st, id, ...names) => names.map((n) => bridge(st, id)[F[n]]);

test('bridges: real NBI rows decoded, metres to feet, unrestricted codes, posting and status', () => {
  assert.deepEqual(decoded.dropped, { 'other territory': 1, 'no location': 1 }); // Puerto Rico; an Idaho forest bridge with no coordinates
  assert.deepEqual(Object.keys(decoded.states).sort(), ['AL', 'AZ', 'CT', 'DE', 'KS', 'MS']);
  // Rising Sun Lane over Brandywine Creek: a truss with 4.28 m over the deck, 6.1 m between rails, posted (P), item 70 = 2 (20-30 % below legal).
  assert.deepEqual(bridge('DE', '1001 279'), [39.7693, -75.5767, '1001 279', 'CR 279', 'RISING SUN LANE', 'BRANDYWINE CREEK', null, 14.04, null, 20.01, 25.6, 2, 'P', 14.04, '8']);
  // US 49 over US 11 in Hattiesburg: 3.98 m over the highway beneath = 13.06 ft, under a 13 ft 6 in load. 99.99 over the deck = unrestricted.
  assert.deepEqual(field('MS', '210004901806850', 'on', 'under', 'under_ref', 'over_ft', 'under_ft', 'min_ft'), ['US 49', 'US 11', 'H', null, 13.06, null]);
  assert.deepEqual(field('KS', '000000000010010', 'over_ft'), [null]); // Kansas codes "no restriction" as 100 ft (30.47 m), not 99.99
  // Closed (K) over a railroad (54A R, 6.71 m), a real 0 t rating by allowable stress (63 = 2), posting 0; a business route (5C 6).
  assert.deepEqual(field('AL', '000729', 'under_ref', 'under_ft', 'opr_t', 'opr_method', 'posting', 'status'), ['R', 22.01, 0, '2', 0, 'K']);
  assert.deepEqual(field('AL', '016389', 'on'), ['US 98 Bus']);
  // I-84 westbound (5E 4); an LRFR rating factor of 3.0 that FHWA publishes as 97.2 t (x 32.4).
  assert.deepEqual(field('CT', '04269', 'on', 'opr_t', 'opr_method'), ['I 84 W', 97.2, '8']);
});

test('bridges: under clearance kept when 54A is N, item 10 published, rating sentinels', () => {
  // I-65 South over I-65 North in Birmingham: Alabama codes 54A N, with 4.95 m under it.
  assert.deepEqual(field('AL', '018557', 'under', 'under_ref', 'under_ft'), ['I - 65 NORTH', null, 16.24]);
  // W Fairview Ave over CSX, Montgomery: item 53 unrestricted, item 10 4.37 m.
  assert.deepEqual(field('AL', '005001', 'over_ft', 'min_ft'), [null, 14.34]);
  assert.deepEqual(field('MS', '210004901806850', 'opr_t'), [null]); // 99.9, the field's ceiling
  assert.deepEqual(py(`print(json.dumps([B.rating('99.9', '1'), B.rating('0', '5'), B.rating('0', '2'), B.rating('4.5', '5'), B.rating('', '1'), B.rating('44.6', '1')]))`),
    [null, null, 0, 4.5, null, 44.6]);
  assert.deepEqual(py(`print(json.dumps([B.feet('99.99'), B.feet('0'), B.feet(''), B.feet('4.11'), B.feet('31.5', 99.0), B.feet('99.9', 99.0)]))`),
    [null, null, null, 13.48, 103.35, null]);
});

test('bridges: a row is read as DMS or as decimal degrees, both coordinates alike, and the state grid picks', () => {
  // Seconds of 60 or more carry: AZ 04191 is 34 43' 70", 114 20' 40" on I-40 west of exit 9 (the decimal reading, 34.437,-114.204, is 35 km off it);
  // AZ 02895 Prince Rd over I-10 in Tucson is 32 16' 30", 111 00' 60" (decimal would put it 12 km south).
  assert.deepEqual(field('AZ', '04191', 'lat', 'lng'), [34.73611, -114.34444]);
  assert.deepEqual(field('AZ', '02895', 'lat', 'lng'), [32.275, -111.01667]);
  // MD 51 on the West Virginia line (Maryland codes decimal): read as DMS it lands in Pennsylvania, so the grid takes the decimal reading.
  const md = { [py("print(json.dumps(B.cell_key(39.90901, -78.76516)))")]: 'PA', [py("print(json.dumps(B.cell_key(39.53924, -78.45546)))")]: 0 };
  assert.deepEqual(py(`c = ${JSON.stringify(md)}\nprint(json.dumps([B.location('39539243', '078455459', 'MD', c), B.location('39539243', '078455459', 'MD', None),
    B.location('39460947', '075343612', 'DE', {}), B.location('', '075343612', 'DE', None), B.location('99999999', '764650983', 'MD', None)]))`),
    [[39.53924, -78.45546], [39.90901, -78.76516], [39.7693, -75.5767], null, null]);
});

test('bridges: the daily check builds only when FHWA has a different file, never an older year', () => {
  const live = { url: 'u25', year: 2025, lastModified: 'Mon, 16 Jun 2025 16:57:04 GMT', bytes: 53277475 };
  assert.deepEqual(py(`L = ${JSON.stringify(live)}
print(json.dumps([B.should_build(L, L), B.should_build(L, None), B.should_build({**L, 'bytes': 1}, L),
  B.should_build({**L, 'year': 2026, 'url': 'u26'}, L), B.should_build({**L, 'year': 2024, 'url': 'u24'}, L)]))`),
    [false, true, true, true, false]);
  // The live build: none yet (404) builds; any other failure stops the run rather than risk an older year; a short build is refused.
  assert.deepEqual(py(`import urllib.error
def fail(e):
    def f(url): raise e
    return f
out = []
for e in (urllib.error.HTTPError('u', 404, 'Not Found', {}, None), urllib.error.HTTPError('u', 503, 'Busy', {}, None), urllib.error.URLError('dns')):
    B.get = fail(e)
    try: out.append(B.live_build())
    except SystemExit as x: out.append('stop: ' + str(x).split(' (')[0])
B.get = lambda url: json.dumps({'path': 'bridges/v1/X'} if url == B.LIVE else {'count': 100, 'source': {'year': 2025}}).encode()
out.append(B.live_build())
out += [B.short(89, {'count': 100}), B.short(90, {'count': 100}), B.short(5, None), B.short(5, {})]
print(json.dumps(out))`), [null, 'stop: live bridges pointer could not be read', 'stop: live bridges pointer could not be read',
    { count: 100, source: { year: 2025 } }, true, false, false, false]);
});

test('bridges: write() and KIND=bridges publish into STORE_DIR', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-')), store = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-store-'));
  const source = { url: 'https://www.fhwa.dot.gov/bridge/nbi/2025hwybronefiledel.zip', year: 2025, lastModified: 'Mon, 16 Jun 2025 16:57:04 GMT', bytes: 53277475 };
  // The fixture covers six states, so STATES is cut to them: write() refuses a set short of every state.
  py(`B.STATES = {k: v for k, v in B.STATES.items() if v in ('AL', 'AZ', 'CT', 'DE', 'KS', 'MS')}
s, _ = B.build(open(${JSON.stringify(SAMPLE)}, encoding='latin-1', newline=''))
B.write(${JSON.stringify(work)}, s, ${JSON.stringify(source)})
try: B.write(${JSON.stringify(work)}, {k: s[k] for k in ('DE',)}, ${JSON.stringify(source)}); print('null')
except SystemExit as e: print(json.dumps(str(e)))`);
  const index = JSON.parse(fs.readFileSync(path.join(work, 'bridges.json'), 'utf8'));
  assert.match(index.buildId, /^\d{8}T\d{6}Z$/);
  assert.equal(index.count, 10);
  assert.deepEqual(Object.keys(index.states), ['AL', 'AZ', 'CT', 'DE', 'KS', 'MS']); // the full write, not the refused short one
  const env = { ...process.env, STORE_DIR: store, WORK: work, KIND: 'bridges' };
  delete env.R2_ACCESS_KEY_ID;
  execFileSync('node', [path.join(DIR, 'publish.mjs')], { env, stdio: 'pipe' });
  const ptr = JSON.parse(fs.readFileSync(path.join(store, 'bridges', 'current.json'), 'utf8'));
  assert.equal(ptr.version, index.buildId);
  assert.equal(ptr.path, `bridges/v1/${index.buildId}`);
  assert.deepEqual(ptr.states, index.states);
  const gz = fs.readFileSync(path.join(store, ptr.path, 'DE.json.gz'));
  assert.equal(gz.length, ptr.states.DE.bytes);
  assert.equal(crypto.createHash('sha256').update(gz).digest('hex'), ptr.states.DE.sha256);
  const de = JSON.parse(zlib.gunzipSync(gz));
  assert.match(de.source, /FHWA National Bridge Inventory 2025.*public domain/);
  assert.equal(de.fields.length, de.bridges[0].length);
  // The next run's check reads this build.json: its source and count must be there.
  const built = JSON.parse(fs.readFileSync(path.join(store, ptr.path, 'build.json'), 'utf8'));
  assert.deepEqual(built.source, source);
  assert.equal(built.count, 10);
});

test('bridges: no state grid, no build; a boundaries build in the work folder is read first', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-grid-'));
  const run = (w) => py(`def fail(url): raise OSError('offline')
B.get = fail
try: B.main(['bridges.py', ${JSON.stringify(w)}, ${JSON.stringify(SAMPLE)}]); print('null')
except SystemExit as e: print(json.dumps(str(e)))`);
  assert.match(run(work), /state grid could not be read/);
  assert.equal(fs.existsSync(path.join(work, 'bridges.json')), false);
  // A boundaries build in the work folder (boundaries.mjs layout): the grid reads offline, so the run goes on to write(), which then refuses
  // the fixture's six states.
  const key = 'boundaries/v1/objects/abc.json.gz';
  fs.mkdirSync(path.join(work, 'boundaries', 'objects'), { recursive: true });
  fs.writeFileSync(path.join(work, 'boundaries', 'manifest.json'), JSON.stringify({ index: { key } }));
  fs.writeFileSync(path.join(work, 'boundaries', 'objects', 'abc.json.gz'), zlib.gzipSync(JSON.stringify({ schema: 1, cells: { '0_0': 'DE' } })));
  assert.match(run(work), /6 bridge files for 51 states/);
});
