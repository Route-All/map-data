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
live['states'] = {'SD': {'sha256': hashlib.sha256(f['SD']).hexdigest(), 'count': 1}}
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

test('mileposts: every published source names a public-domain or open licence; unverified ones are not built', () => {
  const lic = py(`print(json.dumps({st: s['licence'] for st, s in M.SOURCES.items()}))`);
  assert.deepEqual(Object.keys(lic).sort(), ['IA', 'ID', 'IN', 'KY', 'MA', 'MI', 'MN', 'MO', 'NC', 'ND', 'NV', 'OH', 'SD']);
  assert.deepEqual(Object.keys(lic).filter((st) => lic[st] === 'unverified').sort(), ['MO', 'NC', 'ND', 'NV']);
  for (const [st, l] of Object.entries(lic)) if (l !== 'unverified') assert.match(l, /public domain|CC0|CC BY 4\.0|open data|public information|no restrictions|Distribution Liability/, st);
  // An unverified layer is never fetched, and its state gets no DOT file.
  const got = py(`M.stamp = lambda *a: (_ for _ in ()).throw(AssertionError('fetched'))
files, stamps, notes = M.build('/nonexistent', ['NC'], None)
print(json.dumps([sorted(files), notes]))`);
  assert.deepEqual(got, [[], ['NC: licence unverified, not published']]);
});

test('mileposts: route variants keep their own ref, never the mainline (review: SD, MN, ID spurs, IA foreign posts, NC, ND, NV, OSM CR)', () => {
  const got = py(`S_ = M.SOURCES
print(json.dumps([
  S_['SD']['row']({'highway': '016 ', 'suffix_hwy_type': 'B', 'highway_category': 'US', 'mrm': '040.54', 'county': 'PENNINGTON', 'direction': ''})[0],
  S_['SD']['row']({'highway': '090', 'suffix_hwy_type': 'L', 'highway_category': 'I', 'mrm': '010.00', 'county': 'LAWRENCE', 'direction': ''})[0],
  S_['SD']['row']({'highway': '014A', 'suffix_hwy_type': '', 'highway_category': 'US', 'mrm': '041.95', 'county': 'LAWRENCE', 'direction': ''})[0],
  S_['MN']['row']({'ROUTE_ID': '5200000000000010-D', 'REFERENCE_POST': '001'}),           # not a trunk highway: no "MN 10"
  S_['MN']['row']({'ROUTE_ID': '0200000000000002BD', 'REFERENCE_POST': '012'})[0],        # US 2 business
  S_['ID']['row']({'RouteName': 'I-15', 'MilePostSigns': '93', 'TravelDirection': '', 'MilePostType': 'Mile Marker', 'LoopSpur': 'Blackfoot', 'RouteType': 'Business Loop'}),
  S_['ID']['row']({'RouteName': 'I-84', 'MilePostSigns': '50', 'TravelDirection': '', 'MilePostType': 'Equation', 'LoopSpur': 'None', 'RouteType': 'Main Route'}),
  S_['ID']['row']({'RouteName': 'I-84', 'MilePostSigns': '50', 'TravelDirection': 'I', 'MilePostType': 'Mile Marker/Equation', 'LoopSpur': 'None', 'RouteType': 'Main Route'})[0],
  S_['ID']['row']({'RouteName': 'US-93', 'MilePostSigns': '0', 'TravelDirection': '', 'MilePostType': 'Mile Marker', 'LoopSpur': 'None', 'RouteType': 'Spur'}),
  S_['IA']['row']({'OFFICIAL_ROUTE_PREFIX': 'I', 'OFFICIAL_ROUTE_NUMBER': 29, 'OFFICIAL_ROUTE_DIRECTION': 'S', 'REFERENCE_POST_VALUE': '12', 'REFERENCE_POST_NAME': '680E-12'}),
  S_['IA']['row']({'OFFICIAL_ROUTE_PREFIX': 'I', 'OFFICIAL_ROUTE_NUMBER': 29, 'OFFICIAL_ROUTE_DIRECTION': 'S', 'REFERENCE_POST_VALUE': '12', 'REFERENCE_POST_NAME': '29S-12'})[0],
  S_['NC']['row']({'RouteName': 'US-70 Bypass', 'SignMP': '5', 'County': 'Johnston', 'RouteDirection': 'E'})[0],
  S_['ND']['row']({'RTE_SIN': 'S', 'HWY': 200, 'RTE_SUFFIX': 'A', 'REF_PT_NUM': 955.0, 'DIRECTION': 'E'})[0],
  M.nv_route('IR580N'), M.nv_route('US095AN'), M.nv_route('SR028'),
  M.named('CR 12', 'SD'), M.named('AU-9005', 'KY'), M.named('M-59', 'MI'), M.named('M-59', 'NC'), M.num('nan'), M.num('inf'),
]))`);
  assert.deepEqual(got, ['US 16B', 'I 90L', 'US 14A', null, 'US 2B', null, null, 'I 84', null, null, 'I 29', 'US 70 Bypass', 'ND 200A',
    ['I 580', 'N'], ['US 95A', 'N'], ['NV 28', null], null, null, 'MI 59', null, null, null]);
});

test('mileposts: KY and NV posts restart per county: a row with no county is dropped and the file says so', () => {
  const got = py(`feats = [{'attributes': {'RTNAME': 'I-75', 'MILEPOINT': 1, 'CO_NUMBER': c}, 'geometry': {'x': -84.5 + i / 10, 'y': 38.0}}
         for i, c in enumerate([8, 34, 118, None])]
r = M.rows('KY', feats)
ky = json.loads(__import__('gzip').decompress(M.body('KY', r, ['x'])))
sd = json.loads(__import__('gzip').decompress(M.body('SD', [[1.0, 2.0, 'US 85', 1, None, None, 'dot']], ['x'])))
print(json.dumps([[x[4] for x in r], ky.get('county_restarts'), len(ky['mileposts']), 'county_restarts' in sd]))`);
  assert.deepEqual(got, [['008', '034', '118'], true, 3, false]);
});

test('mileposts: a short fetch is refused, the parser version is in the stamp, a shrunken state keeps its live file, an unreadable live build stops the run', () => {
  const got = py(`import gzip, urllib.error
out = []
# A layer that returns fewer rows than its service counts is a failed layer: never pinned by an unchanged edit date.
M.stamp = lambda u, w: ({'url': u, 'edited': 5, 'count': len(S['SD']) + 1, 'parser': M.PARSER}, {})
M.fetch = lambda u, w, info: S['SD']
files, stamps, notes = M.build('/nonexistent', ['SD'], None)
out += [sorted(files), notes[0].split(': ', 1)[1]]
# A parser change re-reads a layer whose edit date did not move.
out += [M.same_layers([{'url': 'u', 'edited': 5, 'count': 7, 'parser': M.PARSER}], [{'url': 'u', 'edited': 5, 'count': 7, 'parser': M.PARSER - 1}])]
# Shrink guard: live SD holds 100 markers; this run's layer fails and no live rows come back, so the live file is kept as it is.
live = {'path': 'mileposts/v1/X', 'states': {'SD': {'sha256': 'x', 'count': 100}}, 'sources': {'SD': [{'url': 'u', 'edited': 5, 'count': 7, 'parser': M.PARSER}]}}
M.stamp = lambda u, w: (_ for _ in ()).throw(RuntimeError('503'))
M.live_rows = lambda live, st: None
M.live_gz = lambda live, st: b'LIVE FILE'
files, stamps, notes = M.build('/nonexistent', ['SD'], live)
out += [files['SD'].decode(), stamps['SD'] == live['sources']['SD'], notes]
# 404: no live build yet (None); any other failure raises, so main writes nothing.
def http(code):
    def g(url, timeout=60): raise urllib.error.HTTPError(url, code, 'x', {}, None)
    return g
M.get = http(404); out += [M.live_build()]
M.get = http(500)
try: M.live_build(); out += ['no raise']
except urllib.error.HTTPError as e: out += [e.code]
print(json.dumps(out))`);
  assert.deepEqual(got.slice(0, 2), [[], `https://sdgis.sd.gov/dot/rest/services/TIM/DOT_MileageReferenceMarkers/FeatureServer/0: fetched 7 of the 8 rows it counts; no DOT markers this run`]);
  assert.equal(got[2], false);
  assert.deepEqual(got.slice(3), ['LIVE FILE', true, ['SD: 503; no DOT markers this run', 'SD: 0 markers against 100 live; live file kept'], null, 500]);
});
