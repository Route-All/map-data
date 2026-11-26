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

test('a feed the registry places in US states is never skipped, whatever was recorded', () => {
  const { kept } = usOnly(wzdxSources(registry), { skipped: { wsdot: { reason: OUTSIDE_US } } });
  assert.deepEqual(ids(kept).slice(0, 2), ['wsdot', 'necdot']);
});

test('with no previous manifest every "n/a" feed is fetched except Quebec City', () => {
  const { kept, skipped } = usOnly(wzdxSources(registry), {});
  assert.deepEqual(ids(kept), ['wsdot', 'necdot', 'pbs', 'CivicLink_CrewCast']);
  assert.deepEqual(skipped.quebec, { name: 'Quebec City', state: 'n/a', bbox: QUEBEC, reason: OUTSIDE_US });
});

test('a feed recorded as outside the US last run is not fetched; one with zero events last run is', () => {
  const { kept, skipped } = usOnly(wzdxSources(registry), { feeds: { pbs: { bbox: null, total: 0 } }, skipped: { CivicLink_CrewCast: { reason: OUTSIDE_US } } });
  assert.deepEqual(ids(kept), ['wsdot', 'necdot', 'pbs']);
  assert.deepEqual(Object.keys(skipped).sort(), ['CivicLink_CrewCast', 'quebec']);
});

test('usRows drops events outside the US, keeps those it cannot place, and flags a feed with every event outside', async () => {
  assert.deepEqual(await usRows([row(-93.6, 42), row(-71.3, 46.8), row(NaN, NaN)], locate), { rows: [row(-93.6, 42), row(NaN, NaN)], dropped: 1, outside: false });
  assert.equal((await usRows([row(-71.3, 46.8), row(-71.2, 46.9)], locate)).outside, true);
  assert.equal((await usRows([], locate)).outside, false); // zero events is not "outside"
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

test('refreshEvents drops a feed whose events lie outside the US, writes `skipped`, and re-reads it next run', async () => {
  const files = boundaryFiles();
  files.set('https://data.transportation.gov/resource/69qe-yiui.json?$limit=500', JSON.stringify([
    reg('usfeed', 'n/a'), reg('cafeed', 'n/a'), reg('mixfeed', 'n/a'), reg('quebec', 'n/a', 'https://quebec.gewi.com/wzdx/pull'), reg('empty', 'n/a'),
  ]));
  files.set('https://usfeed.example/wzdx', feed([-95, 40]));
  files.set('https://cafeed.example/wzdx', feed([-75, 50], [-75.1, 50.1]));
  files.set('https://mixfeed.example/wzdx', feed([-96, 41], [-76, 51]));
  files.set('https://empty.example/wzdx', JSON.stringify({ features: [] }));
  const store = memoryStore();
  const log = [];
  const now = Date.parse('2026-11-26T18:17:00Z');
  const first = await refreshEvents(store, { fetchImpl: fakeFetch(files, log), now });
  const m1 = await store.getJson(first.manifest);
  assert.deepEqual(Object.keys(m1.skipped).sort(), ['cafeed', 'quebec']);
  assert.ok(m1.feeds.usfeed && m1.feeds.mixfeed && m1.feeds.empty && !m1.feeds.cafeed && !m1.feeds.quebec);
  assert.equal(m1.count, 2); // usfeed's event and mixfeed's US one; no Canadian event is published
  assert.equal(m1.feeds.mixfeed.count, 1);
  assert.ok(!log.some((u) => u.includes('quebec')), 'Quebec is never fetched');

  log.length = 0;
  const second = await refreshEvents(store, { fetchImpl: fakeFetch(files, log), now: now + 3_600_000 });
  const m2 = await store.getJson(second.manifest);
  assert.deepEqual(Object.keys(m2.skipped).sort(), ['cafeed', 'quebec']);
  assert.ok(m2.feeds.empty, 'a feed with zero events stays a feed');
  assert.ok(!log.some((u) => u.includes('cafeed') || u.includes('quebec')), 'skipped feeds are not fetched again');
});

test('freshness alerts on a feed lost from the manifest and on a skip that is not "outside the US"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'));
  const write = (k, v) => { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), JSON.stringify(v)); };
  const at = new Date().toISOString();
  write('events/v2/manifests/a.json', { builtAt: at, feeds: { lost: { lastValidatedAt: at, total: 1 }, kept: { lastValidatedAt: at, total: 1 } } });
  write('events/v2/manifests/b.json', { builtAt: at, feeds: { kept: { lastValidatedAt: at, total: 1 } },
    skipped: { quebec: { reason: OUTSIDE_US }, odd: { reason: 'something else' } } });
  write('events/v2/current.json', { manifest: 'events/v2/manifests/b.json', previous: 'events/v2/manifests/a.json' });
  let out = '';
  try { execFileSync(process.execPath, [fileURLToPath(new URL('../freshness.mjs', import.meta.url)), dir]); } catch (e) { out = e.stdout.toString(); }
  assert.match(out, /ALERT events\/lost: in the previous manifest, now neither fetched nor skipped/);
  assert.match(out, /ALERT events\/odd: skipped \(something else\)/);
  assert.doesNotMatch(out, /events\/quebec/);
  fs.rmSync(dir, { recursive: true, force: true });
});
