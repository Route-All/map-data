import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, tilesFor, touchesBox, readTile, tileKey, MAX_TILES, TooMuchData } from '../query.mjs';
import { toLine, packTile } from '../tile.mjs';

// Exactly what services/permitRoute.ts sends (osmQuery + refFilter / nameFilter + bbox).
const refQ = (nums, box) => `[out:json][timeout:40];way["highway"]["ref"~"(^|;)[A-Za-z]{0,8} ?${nums}($|;)"](${box});out geom;`;
const nameQ = (words, box) => `[out:json][timeout:40];way["highway"]["name"~"${words}",i](${box});out geom;`;
const BOX = '39.05,-75.95,39.95,-75.05';

const feature = (id, tags, coords) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { '@id': id, highway: 'motorway', ...tags } });
// A tile exactly as build.sh makes it: toLine for each way, then packTile.
const tile = (...features) => packTile(features.map((f) => toLine(f).v1).join('').split('\n'));
const bytes = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
const I95 = feature(11, { ref: 'I 95' }, [[-75.6, 39.5], [-75.5, 39.6]]);
const I295 = feature(12, { ref: 'I 295;US 40', name: 'Delaware Memorial Bridge' }, [[-75.52, 39.68], [-75.5, 39.69]]);
const US95 = feature(9, { ref: 'US 395' }, [[-75.6, 39.5], [-75.5, 39.6]]);

function env(objects = {}, pointer = { buildId: '20261018T000000Z', builtAt: new Date().toISOString(), tileCount: 1, sourceDates: {} }) {
  const store = { 'roads/current.json': pointer && JSON.stringify(pointer), ...objects };
  const reads = [];
  return { reads, ROADS: { async get(key) {
    reads.push(key);
    const v = store[key];
    if (v == null) return null;
    return { size: v.length, async json() { return JSON.parse(v); }, async arrayBuffer() { return bytes(Buffer.from(v)); } };
  } } };
}

test('parses the two query shapes the app sends, single and alternation', () => {
  const ref = parseQuery(refQ('(95|295)', BOX));
  assert.equal(ref.field, 'ref');
  assert.deepEqual(ref.box, { s: 39.05, w: -75.95, n: 39.95, e: -75.05 });
  assert.ok(ref.test.test('I 95') && ref.test.test('US 40;I 295') && ref.test.test('95') && ref.test.test('I95'));
  assert.ok(!ref.test.test('I 395') && !ref.test.test('I 950') && !ref.test.test('i 9'));
  const name = parseQuery(nameQ('(Durst|Milford)', BOX));
  assert.equal(name.field, 'name');
  assert.ok(name.test.test('East DURST Avenue') && name.test.test('Milford Springs Road') && !name.test.test('Main Street'));
  assert.ok(parseQuery(refQ('81A', '38.550000000000004,-77.45,39.45,-76.55')));
});

test('rejects every other QL, so the app falls back to the public servers', () => {
  for (const q of [
    '', 'way["highway"](39,-76,40,-75);out geom;',
    refQ('95', BOX).replace('out geom', 'out body'),
    refQ('95', BOX).replace('way["highway"]', 'node["highway"]'),
    refQ('.*', BOX), refQ('(95|.*)', BOX), nameQ('Dur.st', BOX), nameQ('(a|b', BOX),
    nameQ('Durst', BOX).replace(',i]', ']'),
    refQ('95', '39.95,-75.95,39.05,-75.05'), // south above north
    refQ('95', BOX) + 'out;',
  ]) assert.equal(parseQuery(q), null, q);
});

test('tile math: keys, the app box covers 16 tiles, and a way crossing tiles is in each', () => {
  assert.equal(tileKey(39.05, -75.95), '156_-304');
  assert.equal(tileKey(-0.1, 0.1), '-1_0');
  assert.equal(tilesFor(parseQuery(refQ('95', BOX)).box).length, 16);
  assert.ok(tilesFor({ s: 39, w: -80, n: 41, e: -78 }).length > MAX_TILES);
  assert.deepEqual([...toLine(feature(1, { ref: 'I 95' }, [[-75.9, 39.1], [-75.6, 39.1]])).keys], ['156_-304', '156_-303']);
});

test('build lines keep 5 decimals and drop roads a truck cannot use or the app cannot match', () => {
  assert.equal(toLine(feature(5, { ref: 'I 95' }, [[-75.1234567, 39.7654321]])).v1, '5\tI 95\t\t39.76543,-75.12346\n');
  assert.equal(toLine({ ...feature(6, { name: 'Main St' }, [[0, 0]]), properties: { '@id': 6, highway: 'footway', name: 'Main St' } }), null);
  assert.equal(toLine(feature(7, {}, [[0, 0]])).v1, null); // no ref, no name: v2 only
  assert.equal(toLine({ ...feature(9, {}, [[0, 0]]), properties: { '@id': 9, highway: 'service', service: 'driveway' } }), null); // a driveway: neither
  assert.equal(toLine(feature(8, { name: 'Tab\tName' }, [[0, 0]])).v1, '8\t\tTab Name\t0,0\n');
});

test('a way counts when any segment crosses the box, even with no node inside', () => {
  const box = { s: 0, w: 0, n: 1, e: 1 };
  assert.ok(touchesBox([0.5, 0.5], box)); // one node inside
  assert.ok(touchesBox([-1, 0.5, 2, 0.5], box)); // straight through, both ends outside
  assert.ok(touchesBox([5, 5, 6, 6, 0.5, -1, 0.5, 0.2], box)); // last segment only
  assert.ok(touchesBox([1, 1, 2, 2], box)); // on the corner counts, as in Overpass
  assert.ok(!touchesBox([-1, 0.5, -0.5, 2], box));
  assert.ok(!touchesBox([0.5, -1, -1, 0.5], box)); // diagonal passing just outside the corner
});

test('the reference decoder filters by ref or name and dedupes ways that sit in several tiles', () => {
  const shared = tile(I295, I95, US95);
  const query = parseQuery(refQ('(95|295)', BOX)), ways = new Map();
  for (const t of [shared, shared]) readTile(bytes(t), query, ways);
  assert.deepEqual([...ways.values()], [
    { type: 'way', id: 12, tags: { ref: 'I 295;US 40', name: 'Delaware Memorial Bridge' }, geometry: [{ lat: 39.68, lon: -75.52 }, { lat: 39.69, lon: -75.5 }] },
    { type: 'way', id: 11, tags: { ref: 'I 95' }, geometry: [{ lat: 39.5, lon: -75.6 }, { lat: 39.6, lon: -75.5 }] },
  ]);
  const named = new Map();
  readTile(bytes(tile(feature(13, { name: 'East Durst Ave' }, [[-75.3, 39.4]]))), parseQuery(nameQ('durst', BOX)), named);
  assert.deepEqual([...named.keys()], ['13']);
});

test('a way that matches but lies outside the box is left out', async () => {
  const outside = feature(20, { ref: 'I 95' }, [[-76.2, 38.8], [-76.1, 38.9]]);
  const ways = new Map();
  readTile(bytes(tile(outside, I95)), parseQuery(refQ('95', BOX)), ways);
  assert.deepEqual([...ways.keys()], ['11']);
});

test('the reference decoder refuses to decode more than its budget', () => {
  const many = Array.from({ length: 50 }, (_, i) => feature(100 + i, { name: `Road ${i}` }, [[-75.6, 39.5], [-75.5, 39.6]]));
  assert.throws(() => readTile(bytes(tile(...many)), parseQuery(nameQ('Road', BOX)), new Map(), { left: 1000 }), TooMuchData);
});

test('a tile holds each distinct ref/name once and drops a way seen twice', () => {
  assert.deepEqual(packTile([toLine(I95).v1, toLine(I95).v1, toLine(I295).v1].join('').split('\n')), tile(I95, I295));
});

test('road route relations become each member way\'s routes tag; other relations and non-way members do not', async () => {
  const { relationEntries } = await import('../routes.mjs');
  assert.deepEqual(relationEntries('r100 v1 Ttype=route,route=road,network=US:I,ref=35E,direction=north Mw10@forward,n1@stop,w12@'),
    [['10', 'US:I|35E||forward|north'], ['12', 'US:I|35E|||north']]);
  assert.deepEqual(relationEntries('r101 v1 Ttype=route,route=road,network=US:US:Business,ref=69;77,modifier=Business Mw10@'), [['10', 'US:US:Business|69/77|Business||']]);
  assert.deepEqual(relationEntries('r102 v1 Ttype=route,route=bus,ref=9 Mw11@'), []);
  assert.deepEqual(relationEntries('w10 v1 Thighway=motorway Nn1,n2'), []);
  const line = toLine(feature(10, { ref: 'I 35E', routes: 'US:I|35E||forward' }, [[-96.8, 32.7], [-96.8, 32.71]]));
  assert.equal(JSON.parse(line.v2.trim().split('\t')[4]).routes, 'US:I|35E||forward');
});

test('a route crossing a state line is placed on the line, in each direction it can be driven', async () => {
  const { buildGrid } = await import('../../format/stateBoundary.mjs');
  const { wayCrossings, joins, table } = await import('../crossings.mjs');
  // Two square states meeting at lon -90.
  const sq = (w, e) => [[[w, 34], [e, 34], [e, 35], [w, 35]]];
  const grid = buildGrid([{ code: 'MS', polygons: [sq(-91, -90)] }, { code: 'AL', polygons: [sq(-90, -89)] }]);
  const line = [[-90.3, 34.5], [-90.1, 34.5], [-89.8, 34.5]];
  const two = (await wayCrossings(grid, { id: 7, routes: 'US:US|72|||', oneway: null, coords: line })).crossings;
  assert.deepEqual(two.map((c) => [c.from, c.to, c.bearing]), [['MS', 'AL', 90], ['AL', 'MS', 270]]);
  assert.ok(Math.abs(two[0].at[0] + 90) < 1e-5 && two[0].at[1] === 34.5);
  const one = (await wayCrossings(grid, { id: 8, routes: 'US:I|22||forward|east', oneway: 'yes', coords: line })).crossings;
  assert.deepEqual(one.map((c) => [c.from, c.to, c.network, c.ref, c.direction]), [['MS', 'AL', 'US:I', '22', 'east']]);
  // A motorway is one-way unless tagged otherwise; a relation's "/" between refs is read back as ";".
  const motorway = (await wayCrossings(grid, { id: 10, routes: 'US:US|69/77|||', oneway: null, highway: 'motorway', coords: line })).crossings;
  assert.deepEqual(motorway.map((c) => [c.from, c.to, c.ref]), [['MS', 'AL', '69;77']]);
  assert.deepEqual((await wayCrossings(grid, { id: 9, routes: 'US:US|72|||', oneway: null, coords: [[-90.5, 34.5], [-90.2, 34.6]] })).crossings, []);

  // Split at the line (OSM keeps one relation per state): each half has no vertex across, so the join places it.
  const ms = await wayCrossings(grid, { id: 11, routes: 'US:US|72|||;US:I|22||forward|', oneway: null, coords: [[-90.3, 34.5], [-90.0001, 34.5]] });
  const al = await wayCrossings(grid, { id: 12, routes: 'US:US|72|||', oneway: null, coords: [[-90.0001, 34.5], [-89.8, 34.5]] });
  const far = await wayCrossings(grid, { id: 13, routes: 'US:US|72|||', oneway: null, coords: [[-90.6, 34.5], [-90.3, 34.5]] });
  assert.deepEqual([...ms.crossings, ...al.crossings, ...far.crossings], []);
  const joined = table(joins([...ms.ends, ...al.ends, ...far.ends]));
  assert.deepEqual(joined.map((c) => [c.from, c.to, c.ref, c.at[0], c.bearing]), [['AL', 'MS', '72', -90.0001, 270], ['MS', 'AL', '72', -90.0001, 90]]);
  // One-way halves: only the way they run.
  const fwdA = await wayCrossings(grid, { id: 14, routes: 'US:I|22||forward|', oneway: 'yes', coords: [[-90.3, 34.4], [-90.0001, 34.4]] });
  const fwdB = await wayCrossings(grid, { id: 15, routes: 'US:I|22||forward|', oneway: 'yes', coords: [[-90.0001, 34.4], [-89.8, 34.4]] });
  assert.deepEqual(joins([...fwdA.ends, ...fwdB.ends]).map((c) => [c.from, c.to]), [['MS', 'AL']]);
  // ...and a half too short to leave the line's 30 m margin (18 m here: Kansas City's I-435 eastbound at State Line Road) still has a state.
  const shortB = await wayCrossings(grid, { id: 16, routes: 'US:I|22||forward|', oneway: 'yes', coords: [[-90.0001, 34.4], [-89.9998, 34.4]] });
  assert.deepEqual(table([...shortB.crossings, ...joins([...fwdA.ends, ...shortB.ends])]).map((c) => [c.from, c.to, c.ref]), [['MS', 'AL', '22']]);
});
