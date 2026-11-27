import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const DIR = path.join(import.meta.dirname, '..');
// Real features of the DOTs' layers, as their query answers them (outSR 4326), unchanged: SD DOT Mileage Reference Markers (US-85 by Belle
// Fourche, US-212 at the Minnesota line, US-14A), MnDOT Reference Posts (MN-65 posts 97-98 both directions, I-35E post 100), KYTC State Road
// Milepoints (KY-90 post 3 in counties 85 and 27), ODOT State Mileposts (a multipoint), MDOT Mile Markers (M-59).
const SAMPLE = path.join(import.meta.dirname, 'mileposts-sample.json');
const py = (code) => JSON.parse(execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(DIR)}); import mileposts as M
S = json.load(open(${JSON.stringify(SAMPLE)}))\n${code}`], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }));
const rows = py(`print(json.dumps({st: M.rows(st, f) for st, f in S.items()}))`);

test('mileposts: each DOT layer read as our refs, the posted value, county and direction', () => {
  // SD 3336a14e ends "US-85 AT MP BUTTE 53.29": the markers 53.24 and 53.69 either side, on both carriageways and the undivided centre line.
  assert.deepEqual(rows.SD.filter((r) => r[2] === 'US 85').map((r) => [r[2], r[3], r[4], r[5]]).sort((a, b) => a[1] - b[1] || String(a[3]).localeCompare(String(b[3]))),
    [['US 85', 53.24, 'BUTTE', 'N'], ['US 85', 53.24, 'BUTTE', 'S'], ['US 85', 53.69, 'BUTTE', 'N'], ['US 85', 53.69, 'BUTTE', null], ['US 85', 53.69, 'BUTTE', 'S']]);
  // SD 2860a6b0 ends "US-212 AT MP DEUEL 412.45": SD DOT's own marker 412.45, at the line; highway "014A" is US-14A.
  assert.deepEqual(rows.SD.find((r) => r[2] === 'US 212'), [44.936051, -96.451921, 'US 212', 412.45, 'DEUEL', null, 'dot']);
  assert.deepEqual(rows.SD.find((r) => r[2] === 'US 14A').slice(2, 5), ['US 14A', 41.95, 'LAWRENCE']);
  // MN 0d5ddd02 ends "MN-65 AT MP 97.28": MnDOT's posts 97 and 98, one per direction (I increasing, D decreasing); I-35E keeps its letter.
  assert.deepEqual(rows.MN.filter((r) => r[2] === 'MN 65').map((r) => [r[3], r[5]]).sort(), [[97, 'D'], [97, 'I'], [98, 'D'], [98, 'I']]);
  assert.deepEqual([...new Set(rows.MN.filter((r) => r[3] === 100).map((r) => r[2]))], ['I 35E']);
  // Kentucky's milepoints restart in each county: the county number is kept with the marker.
  assert.deepEqual(rows.KY.map((r) => [r[2], r[3], r[4]]).sort(), [['KY 90', 3, '027'], ['KY 90', 3, '085']]);
  assert.deepEqual(rows.OH, [[40.178836, -83.248004, 'US 33', 100, 'UNI', null, 'dot']]); // the first point of Ohio's multipoint
  assert.deepEqual(rows.MI.map((r) => r[2]), ['MI 59', 'MI 59']);
});

test('mileposts: route names and OSM milestone values', () => {
  assert.deepEqual(py(`print(json.dumps([M.named(x, 'NV') for x in ['I-84', 'US-93', 'SR443', 'IS 255 N', 'I190 NB', 'SH-55', 'IR80', 'Denali Highway', None]]))`),
    ['I 84', 'US 93', 'NV 443', 'I 255', 'I 190', 'NV 55', 'I 80', null, null]);
  assert.deepEqual(py(`print(json.dumps([M.ref('US', '014A', 'SD'), M.ref('I ', '029 ', 'SD'), M.ref('SD', '1804', 'SD'), M.ref('US', '', 'SD')]))`), ['US 14A', 'I 29', 'SD 1804', null]);
  // Real SD milestones (OSM nodes 9622940798, 12036658249): "72 mi" and "77"; a km marker and a node with no value are no milepost.
  assert.deepEqual(py(`print(json.dumps([M.milestone_value(t) for t in [{'distance': '72 mi'}, {'distance': '77'}, {'distance': '12 km'}, {}, {'pk': '3.5'}]]))`), [72, 77, null, null, 3.5]);
});

test('mileposts: OSM milestones from build.sh, the DOT rows, one row per marker, byte-identical files', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mileposts-'));
  fs.mkdirSync(path.join(work, 'milestones'));
  // osmium export geojsonseq of SD's highway=milestone nodes, as build.sh writes it (two real nodes; one with no value is dropped).
  fs.writeFileSync(path.join(work, 'milestones', 'south-dakota.geojsonseq'),
    '{"type":"Feature","geometry":{"type":"Point","coordinates":[-103.545714,43.8420781]},"properties":{"@id":9622940798,"distance":"72 mi","highway":"milestone"}}\n'
    + '{"type":"Feature","geometry":{"type":"Point","coordinates":[-103.6546395,44.1075684]},"properties":{"@id":12036594608,"highway":"milestone"}}\n');
  const got = py(`M.stamp = lambda u, w: ({'url': u, 'edited': 1, 'count': len(S['SD'])}, {})
M.fetch = lambda u, w, info: S['SD']
files, stamps, notes = M.build(${JSON.stringify(work)}, ['SD', 'WI'], None)
again, _, _ = M.build(${JSON.stringify(work)}, ['SD'], None)
d = json.loads(__import__('gzip').decompress(files['SD']))
print(json.dumps({'states': sorted(files), 'same': files['SD'] == again['SD'], 'fields': d['fields'], 'sources': d['sources'], 'n': len(d['mileposts']),
  'osm': [r for r in d['mileposts'] if r[6] == 'osm'], 'stamps': stamps}))`);
  fs.rmSync(work, { recursive: true });
  assert.deepEqual(got.states, ['SD']); // Wisconsin: no DOT source wired, no milestones: no file
  assert.equal(got.same, true);
  assert.deepEqual(got.fields, ['lat', 'lng', 'route', 'mp', 'county', 'dir', 'src']);
  assert.match(got.sources[0], /^South Dakota DOT Mileage Reference Markers; open data/);
  assert.match(got.sources[1], /OpenStreetMap.*ODbL/);
  assert.equal(got.n, 7 - 2 + 1); // 53.69's three rows at one point are one marker; plus one milestone
  assert.deepEqual(got.osm, [[43.842078, -103.545714, null, 72, null, null, 'osm']]);
});

test('mileposts: the daily skip and a failing layer', () => {
  const got = py(`import gzip, hashlib
live = {'path': 'mileposts/v1/X', 'states': {}, 'sources': {'SD': [{'url': 'u', 'edited': 5, 'count': 7}]}}
out = [M.same_layers([{'url': 'u', 'edited': 5, 'count': 7}], live['sources']['SD']),
       M.same_layers([{'url': 'u', 'edited': None, 'count': 7}], [{'url': 'u', 'edited': None, 'count': 7}]),  # a count alone proves nothing
       M.same_layers([{'url': 'u', 'edited': 6, 'count': 7}], live['sources']['SD'])]
f = {'SD': M.body('SD', [[1.0, 2.0, 'US 85', 53.29, 'BUTTE', None, 'dot']], ['x'])}
live['states'] = {'SD': {'sha256': hashlib.sha256(f['SD']).hexdigest()}}
out += [M.unchanged(f, live), M.unchanged({**f, 'MN': f['SD']}, live), M.unchanged(f, None)]
# An unchanged layer is not downloaded: its live rows are kept.
M.stamp = lambda u, w: ({'url': u, 'edited': 5, 'count': 7}, {})
M.fetch = lambda *a: (_ for _ in ()).throw(AssertionError('fetched'))
M.SOURCES['SD']['layers'] = ['u']
M.live_rows = lambda live, st: [[1.0, 2.0, 'US 85', 53.29, 'BUTTE', None, 'dot']]
files, stamps, notes = M.build('/nonexistent', ['SD'], live)
out += [files['SD'] == f['SD'] or json.loads(gzip.decompress(files['SD']))['mileposts'], notes]
# A layer that fails keeps the live rows; with no live build its state has none, and the run goes on.
M.stamp = lambda u, w: (_ for _ in ()).throw(RuntimeError('503'))
files, stamps, notes = M.build('/nonexistent', ['SD'], live)
out += [len(json.loads(gzip.decompress(files['SD']))['mileposts']), notes]
files, stamps, notes = M.build('/nonexistent', ['SD'], None)
out += [sorted(files), notes]
print(json.dumps(out))`);
  assert.deepEqual(got.slice(0, 6), [true, false, false, true, false, false]);
  assert.deepEqual(got[7], ['SD: unchanged, live rows kept']);
  assert.deepEqual(got.slice(8), [1, ['SD: 503; live rows kept'], [], ['SD: 503; no DOT markers this run']]);
});

test('mileposts: every source names a public-domain or open licence', () => {
  const lic = py(`print(json.dumps({st: s['licence'] for st, s in M.SOURCES.items()}))`);
  assert.deepEqual(Object.keys(lic).sort(), ['IA', 'ID', 'IN', 'KY', 'MA', 'MI', 'MN', 'MO', 'NC', 'ND', 'NV', 'OH', 'SD']);
  for (const [st, l] of Object.entries(lic)) assert.match(l, /public domain|CC0|CC BY 4\.0|open data|public information|no use constraints/, st);
});
