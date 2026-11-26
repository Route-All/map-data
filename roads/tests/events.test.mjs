import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGrid, encodeJson } from '../../format/stateBoundary.mjs';
import { usOnly, usRows, usLocator, wzdxSources, refreshEvents, OUTSIDE_US } from '../events.mjs';
import { memoryStore } from '../store.mjs';

const TILES = 'https://tiles.routeall.app';
// Rows as USDOT's registry has them (2026-11-26).
const reg = (feedname, state, url = `https://${feedname}.example/wzdx`) => ({ feedname, issuingorganization: feedname, state, url, active: true, needapikey: false });
const registry = [
  reg('wsdot', 'washington'), reg('necdot', 'New Hampshire, Vermont, Maine'),
  reg('quebec', 'n/a', 'https://quebec.gewi.com/wzdx/pull'), reg('pbs', 'n/a'), reg('CivicLink_CrewCast', 'n/a'),
];
const ids = (list) => list.map((s) => s.id);
// Stand-in for the state lines: the US is south of 45° N here (Quebec City 46.8° N, Ames 42° N).
const locate = async ([, lat]) => (Number.isFinite(lat) ? lat < 45 : null);
const QUEBEC = [-71.43886, 46.74985, -71.16176, 46.91896];
const row = (lon, lat) => ({ id: `${lon},${lat}`, lon, lat });

test('only a KNOWN_OUTSIDE feed is skipped: every other feed is fetched, with or without a previous manifest', () => {
  const { kept, skipped } = usOnly(wzdxSources(registry));
  assert.deepEqual(ids(kept), ['wsdot', 'necdot', 'pbs', 'CivicLink_CrewCast']);
  assert.deepEqual(skipped, { quebec: { name: 'Quebec City', state: 'n/a', bbox: QUEBEC, reason: OUTSIDE_US } });
});

test('a feed the registry places in US states is never skipped, even under a known non-US id', () => {
  const { kept, skipped } = usOnly(wzdxSources([reg('quebec', 'vermont')]));
  assert.deepEqual(ids(kept), ['quebec']);
  assert.deepEqual(skipped, {});
});

test('usRows drops events outside the US and keeps those it cannot place', async () => {
  assert.deepEqual(await usRows([row(-93.6, 42), row(-71.3, 46.8), row(NaN, NaN)], locate), { rows: [row(-93.6, 42), row(NaN, NaN)], dropped: 1 });
  assert.deepEqual(await usRows([], locate), { rows: [], dropped: 0 });
});

// A one-state US whose lines do not sit on the 0.25° grid, so a point beside them is read from the rings.
const US = [-100.1, 30.1, -90.1, 45.1];
function boundaryFiles() {
  const [w, s, e, n] = US;
  // A kink on the east line at 40.1° N, so its cell holds a real line (a straight cut would read as a whole cell).
  const { index, blocks } = buildGrid([{ code: 'XX', polygons: [[[[w, s], [e, s], [-90.12, 40.1], [e, n], [w, n]]]] }]);
  const files = new Map();
  const put = (v) => { const bytes = encodeJson(v), key = `boundaries/v1/objects/${files.size}.json.gz`; files.set(key, bytes); return { key }; };
  const manifest = { schema: 1, index: put(index), blocks: Object.fromEntries(Object.entries(blocks).map(([k, b]) => [k, put(b)])) };
  files.set('boundaries/v1/m.json', JSON.stringify(manifest));
  files.set('boundaries/v1/current.json', JSON.stringify({ manifest: 'boundaries/v1/m.json' }));
  return files;
}
const fakeFetch = (files, log = []) => async (url) => {
  const key = String(url).replace(`${TILES}/`, '').replace(/\?t=\d+$/, '');
  log.push(String(url));
  const body = files.get(key) ?? files.get(String(url));
  return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
};

test('usLocator reads the published state lines: inside, outside, across a border river, territories', async () => {
  const at = await usLocator(fakeFetch(boundaryFiles()));
  assert.equal(await at([-95, 40]), true); // a whole cell
  assert.equal(await at([-90.15, 40.1]), true); // inside, in a cell the line crosses
  assert.equal(await at([-90.09, 40.1]), false); // 2.5 km across the line (Windsor across the Detroit River)
  assert.equal(await at([-75, 50]), false); // no US cell at all
  assert.equal(await at([-66.1, 18.45]), true); // San Juan, Puerto Rico
  assert.equal(await usLocator(async () => new Response('', { status: 503 })), null);
});

const feed = (...points) => JSON.stringify({ features: points.map((coordinates, i) => ({ id: `e${i}`, type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { core_details: { event_type: 'work-zone', road_names: ['X'] } } })) });

const REGISTRY_URL = 'https://data.transportation.gov/resource/69qe-yiui.json?$limit=500';
const run = async (store, files, now, log = []) => store.getJson((await refreshEvents(store, { fetchImpl: fakeFetch(files, log), now })).manifest);
const NOW = Date.parse('2026-11-26T18:17:00Z'), HOUR = 3_600_000;

test('refreshEvents drops events outside the US before storing them; only Quebec is skipped, never fetched', async () => {
  const files = boundaryFiles();
  files.set(REGISTRY_URL, JSON.stringify([reg('usfeed', 'n/a'), reg('cafeed', 'n/a'), reg('mixfeed', 'n/a'),
    reg('quebec', 'n/a', 'https://quebec.gewi.com/wzdx/pull'), reg('empty', 'n/a')]));
  files.set('https://usfeed.example/wzdx', feed([-95, 40]));
  files.set('https://cafeed.example/wzdx', feed([-75, 50], [-75.1, 50.1]));
  files.set('https://mixfeed.example/wzdx', feed([-96, 41], [-76, 51]));
  files.set('https://empty.example/wzdx', JSON.stringify({ features: [] }));
  const store = memoryStore(), log = [];
  const m = await run(store, files, NOW, log);
  assert.deepEqual(Object.keys(m.skipped), ['quebec']);
  assert.ok(!log.some((u) => u.includes('quebec')), 'Quebec is never fetched');
  assert.equal(m.count, 2); // usfeed's event and mixfeed's US one
  // No Canadian event, total or bbox is stored: the snapshot, total and bbox are of the US events only.
  assert.deepEqual(await store.getJson(m.feeds.cafeed.normalizedObjectKey), []);
  assert.equal(m.feeds.cafeed.total, 0);
  assert.equal(m.feeds.cafeed.bbox, null);
  assert.deepEqual((await store.getJson(m.feeds.mixfeed.normalizedObjectKey)).map((r) => [r.lon, r.lat]), [[-96, 41]]);
  assert.deepEqual(m.feeds.mixfeed.bbox, [-96, 41, -96, 41]);
  // Next hour every feed but Quebec is fetched again, cafeed included.
  log.length = 0;
  const m2 = await run(store, files, NOW + HOUR, log);
  assert.ok(log.some((u) => u.includes('cafeed')) && !log.some((u) => u.includes('quebec')));
  assert.deepEqual(Object.keys(m2.skipped), ['quebec']);
  assert.ok(m2.feeds.cafeed && m2.feeds.empty);
});

test('a US feed whose only event is one bad [0,0] reading is kept and comes back the next hour', async () => {
  const files = boundaryFiles();
  files.set(REGISTRY_URL, JSON.stringify([reg('pbs', 'n/a')]));
  files.set('https://pbs.example/wzdx', feed([0, 0]));
  const store = memoryStore();
  const m1 = await run(store, files, NOW);
  assert.ok(m1.feeds.pbs, 'still a feed');
  assert.equal(m1.feeds.pbs.count, 0);
  assert.equal(m1.skipped.pbs, undefined);
  files.set('https://pbs.example/wzdx', feed([-93.6, 42.0]));
  const m2 = await run(store, files, NOW + HOUR);
  assert.equal(m2.feeds.pbs.count, 1);
});

test('with the state lines unreadable, a changed "n/a" feed keeps its last checked snapshot (Retained)', async () => {
  const files = boundaryFiles();
  files.set(REGISTRY_URL, JSON.stringify([reg('mixfeed', 'n/a')]));
  files.set('https://mixfeed.example/wzdx', feed([-96, 41]));
  const store = memoryStore();
  await run(store, files, NOW);
  for (const k of [...files.keys()]) if (k.startsWith('boundaries/')) files.delete(k);
  files.set('https://mixfeed.example/wzdx', feed([-96, 41], [-76, 51]));
  const m = await run(store, files, NOW + HOUR);
  assert.equal(m.feeds.mixfeed.status, 'retained');
  assert.deepEqual((await store.getJson(m.feeds.mixfeed.normalizedObjectKey)).map((r) => [r.lon, r.lat]), [[-96, 41]]);
});

function freshness(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
  for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), JSON.stringify(v)); }
  let out = '';
  try { out = execFileSync(process.execPath, [fileURLToPath(new URL('../freshness.mjs', import.meta.url)), dir]).toString(); } catch (e) { out = e.stdout.toString(); }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

test('freshness alerts on an active registry feed that is neither fetched nor skipped, and on an odd skip', () => {
  const at = new Date().toISOString();
  const out = freshness({
    'events/v2/objects/reg.json': [reg('kept', 'texas'), reg('lost', 'texas'), reg('quebec', 'n/a'),
      { ...reg('retired', 'ohio'), active: false }, { ...reg('keyed', 'ohio'), needapikey: true }],
    'events/v2/manifests/b.json': { builtAt: at, registry: { objectKey: 'events/v2/objects/reg.json' },
      feeds: { kept: { lastValidatedAt: at, total: 1 } }, skipped: { quebec: { reason: OUTSIDE_US }, odd: { reason: 'something else' } } },
    'events/v2/current.json': { manifest: 'events/v2/manifests/b.json' },
  });
  assert.match(out, /ALERT events\/lost: active in the registry, neither fetched nor skipped/);
  assert.match(out, /ALERT events\/odd: skipped \(something else\)/);
  assert.doesNotMatch(out, /events\/(quebec|retired|keyed|kept)/);
});
