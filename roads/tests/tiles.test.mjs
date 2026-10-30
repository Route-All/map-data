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
