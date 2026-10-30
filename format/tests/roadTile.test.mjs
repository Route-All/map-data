import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeTile, decodeTile, waysNear, TileFormatError, TileBudgetError, tilesForBox, tileKey } from '../roadTile.mjs';

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
