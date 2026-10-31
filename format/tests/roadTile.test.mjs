import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeTile, decodeTile, waysNear, TileFormatError, TileBudgetError, tilesForBox, tileKey,
  encodeTile3, headLength, decodeHead, decodeIndex, chunksMatching, decodeChunks, blockOf, sha256, bytesToHex } from '../roadTile.mjs';

const I35 = { id: '100', ref: 'I 35', name: 'Interstate 35', coords: [30.25, -97.74, 30.26, -97.74, 30.27, -97.735], tags: { highway: 'motorway', oneway: 'yes', maxheight: '4.9' } };
const FRONTAGE = { id: '101', ref: '', name: 'North Interstate 35 Frontage Road', coords: [30.25, -97.7397, 30.27, -97.7392], tags: { highway: 'secondary', oneway: 'yes' } };
const UNNAMED = { id: '102', coords: [30.255, -97.75, 30.255, -97.745], tags: { highway: 'service', service: 'alley' } };
const I35_SB = { id: '103', ref: 'I 35', name: 'Interstate 35', coords: [30.27, -97.7352, 30.25, -97.7402], tags: { highway: 'motorway', oneway: 'yes' } };

test('round trip: groups, refs, names, [lon, lat] order and tags come back as written', () => {
  const t = decodeTile(encodeTile([I35, FRONTAGE, UNNAMED, I35_SB]));
  assert.equal(t.groupCount(), 3); // I 35 (two ways), the frontage road, the unnamed alley
  const [g] = t.groupsMatching('ref', /^I 35$/);
  const grp = t.group(g);
  assert.deepEqual([grp.ref, grp.name], ['I 35', 'Interstate 35']);
  assert.deepEqual(grp.ways.map((w) => w.id), ['100', '103']);
  assert.deepEqual(grp.ways[0].coords[0], [-97.74, 30.25]);
  assert.deepEqual(t.tags('100'), { highway: 'motorway', oneway: 'yes', maxheight: '4.9' });
  assert.deepEqual(t.tags('102'), { highway: 'service', service: 'alley' });
  assert.deepEqual(t.groupsMatching('name', /frontage/i).map((g) => t.group(g).name), ['North Interstate 35 Frontage Road']);
});

test('unnamed roads are kept but never indexed by ref or name', () => {
  const t = decodeTile(encodeTile([UNNAMED]));
  assert.equal(t.groupCount(), 1);
  assert.deepEqual(t.groupsMatching('ref', /.*/), []);
  assert.deepEqual(t.groupsMatching('name', /.*/), []);
});

test('the same way twice (two state extracts) is kept once; output is deterministic', () => {
  const a = encodeTile([I35, FRONTAGE, I35]), b = encodeTile([FRONTAGE, I35]);
  assert.deepEqual(a, b);
  assert.equal(decodeTile(a).group(decodeTile(a).groupsMatching('ref', /I 35/)[0]).ways.length, 1);
});

test('a missing tag is unknown: no maxheight means no key, never a limit of 0', () => {
  assert.equal('maxheight' in decodeTile(encodeTile([FRONTAGE])).tags('101'), false);
  assert.deepEqual(decodeTile(encodeTile([FRONTAGE])).tags('999'), {});
});

test('refuses other formats, other versions, unknown flags and a truncated tile', () => {
  const ok = encodeTile([I35]);
  assert.throws(() => decodeTile(new Uint8Array(ok.length)), TileFormatError);
  const v = ok.slice(); v[4] = 3; assert.throws(() => decodeTile(v), /version 3/);
  const f = ok.slice(); f[6] = 1; assert.throws(() => decodeTile(f), /flags 1/);
  assert.throws(() => decodeTile(ok.subarray(0, ok.length - 1)), /length/);
});

test('the decode budget stops a caller that asks for too much', () => {
  const t = decodeTile(encodeTile([I35, FRONTAGE]), { left: 10 });
  assert.throws(() => t.spatial(), TileBudgetError);
});

test('waysNear returns every road in reach, nearest first, one candidate per way, across tile edges', () => {
  const p = [-97.7398, 30.26];
  const t = decodeTile(encodeTile([I35, FRONTAGE, UNNAMED, I35_SB]));
  const near = waysNear([t, t], p, 200); // the same tile twice: a way seen in two tiles is one candidate
  // The frontage road is a candidate beside the interstate, not dropped for being second.
  assert.deepEqual(near.map((c) => c.wayId), ['100', '101', '103']);
  assert.ok(near[0].distanceMeters < near[1].distanceMeters);
  assert.equal(near[0].tags.highway, 'motorway');
  assert.ok(Math.abs(near[0].coordinate[0] - -97.74) < 1e-4);
  assert.deepEqual(waysNear([t], [-97.6, 30.26], 200), []);
});

test('tile keys and box cover match the v1 grid', () => {
  assert.equal(tileKey(30.26, -97.74), '121_-391');
  assert.deepEqual(tilesForBox(-97.76, 30.24, -97.74, 30.26), ['120_-392', '120_-391', '121_-392', '121_-391']);
});

test('a box across 180° is split there, never empty (review finding 5)', () => {
  assert.deepEqual(tilesForBox(179.9, 51.9, -179.9, 51.99), ['207_719', '207_-720']);
  assert.deepEqual(tilesForBox(-180.1, 51.9, -179.9, 51.99), ['207_719', '207_-720']); // a side past -180
});

// ---- v3: read by byte ranges ----
const KEY = tileKey(30.26, -97.74); // '121_-391'
// What a reader does: the head, then only the chunks it needs, each checked against the SHA-256 the head lists.
const hex = (b) => createHash('sha256').update(b).digest('hex');
function read3(tile, pick) {
  const head = decodeHead(tile.subarray(0, headLength(tile)));
  const chunks = pick(head).map((i) => {
    const c = head.chunks[i], bytes = tile.subarray(c.offset, c.offset + c.length);
    assert.equal(hex(bytes), c.sha256);
    return bytes;
  });
  return decodeChunks(chunks);
}
const box = (p, m) => { const d = m / 111320; return [p[0] - d / Math.cos((p[1] * Math.PI) / 180), p[1] - d, p[0] + d / Math.cos((p[1] * Math.PI) / 180), p[1] + d]; };

test('v3 answers exactly as v2: the ways near a point (with tags) and the ways carrying a ref or a name', () => {
  // Many small chunks (chunkText 60), so the answer has to be assembled from the right ones.
  const ways = [I35, FRONTAGE, UNNAMED, I35_SB];
  const v2 = decodeTile(encodeTile(ways)), v3 = encodeTile3(ways, KEY, { chunkText: 60 });
  assert.ok(decodeHead(v3.subarray(0, headLength(v3))).chunks.length > 2);
  for (const [p, m] of [[[-97.7398, 30.26], 200], [[-97.748, 30.255], 100], [[-97.6, 30.26], 200]]) {
    const near = read3(v3, (h) => h.chunksIn(...box(p, m)));
    assert.deepEqual(waysNear([near], p, m), waysNear([v2], p, m));
  }
  // A road split over chunks comes back as several groups: the same ways, so compare them in id order.
  const ids = (t, field, re) => t.groupsMatching(field, re).flatMap((g) => t.group(g).ways.map((w) => [w.id, t.tags(w.id)])).sort();
  const byRef = read3(v3, (h) => chunksMatching(h.refIndex, /^I 35$/));
  assert.deepEqual(ids(byRef, 'ref', /^I 35$/), ids(v2, 'ref', /^I 35$/));
  const head = decodeHead(v3.subarray(0, headLength(v3)));
  const nameBytes = v3.subarray(head.nameIndex.offset, head.nameIndex.offset + head.nameIndex.length);
  assert.equal(hex(nameBytes), head.nameIndex.sha256);
  const byName = read3(v3, () => chunksMatching(decodeIndex(nameBytes), /frontage/i));
  assert.deepEqual(ids(byName, 'name', /frontage/i), ids(v2, 'name', /frontage/i));
});

test('v3: a ref query never reads chunks of roads without a ref; output is deterministic', () => {
  const v3 = encodeTile3([I35, FRONTAGE, UNNAMED, I35_SB], KEY, { chunkText: 60 });
  const head = decodeHead(v3.subarray(0, headLength(v3)));
  const refChunks = chunksMatching(head.refIndex, /^I 35$/);
  const t = decodeChunks(refChunks.map((i) => v3.subarray(head.chunks[i].offset, head.chunks[i].offset + head.chunks[i].length)));
  assert.deepEqual([...new Set(t.spatial().map((_, g) => t.group(g).ref))], ['I 35']);
  assert.deepEqual(encodeTile3([I35_SB, UNNAMED, I35, FRONTAGE, I35], KEY, { chunkText: 60 }), v3);
});

test('v3 refuses other formats, versions, flags and a head of the wrong length; the decode budget holds', () => {
  const ok = encodeTile3([I35], KEY), n = headLength(ok);
  assert.throws(() => decodeHead(new Uint8Array(n)), TileFormatError);
  const v = ok.slice(); v[4] = 4; assert.throws(() => headLength(v), /version 4/);
  const f = ok.slice(); f[6] = 1; assert.throws(() => headLength(f), /flags 1/);
  assert.throws(() => decodeHead(ok.subarray(0, n - 1)), /length/);
  assert.throws(() => decodeTile(ok), TileFormatError); // a v2 reader never misreads a v3 tile
  const head = decodeHead(ok.subarray(0, n)), c = head.chunks[0];
  assert.throws(() => decodeChunks([ok.subarray(c.offset, c.offset + c.length)], { left: 10 }), TileBudgetError);
  assert.throws(() => encodeTile3([I35], 'nowhere'), TileFormatError);
});

test('block of a tile key, and the bundled SHA-256 matches Node', () => {
  assert.equal(blockOf('121_-391'), '15_-49');
  assert.equal(blockOf('-1_0'), '-1_0');
  for (const n of [0, 1, 55, 56, 64, 1000]) {
    const b = new Uint8Array(n).map((_, i) => (i * 31) & 255);
    assert.equal(bytesToHex(sha256(b)), hex(b));
  }
});
