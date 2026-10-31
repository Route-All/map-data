import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, stateAt, clipRing, encodeJson, decodeJson } from '../stateBoundary.mjs';

// Two states side by side, the line at lon 1.1 (inside a cell, not on the grid), and DC-style hole: C sits inside A.
const sq = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n]];
const A = { code: 'AA', polygons: [[sq(0, 0, 1.1, 1), sq(0.3, 0.3, 0.35, 0.35)]] };
const B = { code: 'BB', polygons: [[sq(1.1, 0, 2, 1)]] };
const C = { code: 'CC', polygons: [[sq(0.3, 0.3, 0.35, 0.35)]] };
const D = { code: 'DD', polygons: [[sq(3, 0, 3.1, 1)]] }; // its east edge, lon 3.1, is a coast inside a cell
const grid = buildGrid([A, B, C, D]);
const blocks = JSON.parse(JSON.stringify(grid.blocks)); // as it comes back from storage
const get = async (k) => blocks[k] ?? null;

test('a cell wholly inside one state is answered by the index alone', async () => {
  assert.equal(grid.index.cells['0_0'], 'AA');
  assert.deepEqual(await stateAt(grid.index, async () => { throw new Error('should not fetch'); }, [0.1, 0.1]), { kind: 'inside', state: 'AA' });
});

test('cells a line crosses read their block, at full resolution', async () => {
  assert.equal(grid.index.cells['0_4'], 0); // lon 1.0–1.25 holds the line
  assert.deepEqual(await stateAt(grid.index, get, [1.05, 0.5]), { kind: 'inside', state: 'AA' });
  assert.deepEqual(await stateAt(grid.index, get, [1.15, 0.5]), { kind: 'inside', state: 'BB' });
});

test('a point metres from the line says boundary with both states and the distance', async () => {
  const r = await stateAt(grid.index, get, [1.1001, 0.5]);
  assert.equal(r.kind, 'boundary');
  assert.deepEqual(r.states, ['AA', 'BB']);
  assert.ok(r.distanceMeters > 5 && r.distanceMeters < 15);
});

test('a hole is its own state (DC inside Maryland), not the surrounding one', async () => {
  assert.deepEqual(await stateAt(grid.index, get, [0.325, 0.325]), { kind: 'inside', state: 'CC' });
  assert.deepEqual(await stateAt(grid.index, get, [0.4, 0.4]), { kind: 'inside', state: 'AA' });
});

test('outside every state is outside_us; a missing block is unavailable, never a guess', async () => {
  assert.deepEqual(await stateAt(grid.index, get, [5, 5]), { kind: 'outside_us' });
  // In a cell a coast crosses, beside a state but in none: not a certain answer.
  assert.deepEqual(await stateAt(grid.index, get, [3.11, 0.5]).then((r) => [r.kind, r.states]), ['boundary', ['DD']]);
  assert.deepEqual(await stateAt(grid.index, get, [3.2, 0.5]), { kind: 'outside_us' }); // 11 km out: certain
  assert.equal((await stateAt(grid.index, async () => null, [1.15, 0.5])).kind, 'unavailable');
  assert.equal((await stateAt(null, get, [0.1, 0.1])).kind, 'unavailable');
});

test('clipRing keeps the part inside the box; gzip JSON round trips', () => {
  assert.deepEqual(clipRing(sq(0, 0, 2, 2), { west: 1, south: 1, east: 3, north: 3 }).length, 4);
  assert.deepEqual(clipRing(sq(0, 0, 1, 1), { west: 2, south: 2, east: 3, north: 3 }), []);
  assert.deepEqual(decodeJson(encodeJson(grid.index)), grid.index);
});

test('a line on a cell edge, or just past it, is a boundary from either side (review finding 3)', async () => {
  // EE|FF meet exactly on lon 5.0, a cell edge; GG|HH meet at lon 10.2501, 11 m into the next cell.
  const g = buildGrid([{ code: 'EE', polygons: [[sq(4, 0, 5, 1)]] }, { code: 'FF', polygons: [[sq(5, 0, 6, 1)]] },
    { code: 'GG', polygons: [[sq(9, 0, 10.2501, 1)]] }, { code: 'HH', polygons: [[sq(10.2501, 0, 11, 1)]] }]);
  const at = (p) => stateAt(g.index, async (k) => g.blocks[k] ?? null, p);
  assert.equal(g.index.cells['2_19'], 'EE'); // both cells beside lon 5.0 are whole
  for (const p of [[4.9999, 0.5], [5.0001, 0.5], [4.9999, 0.0001]]) {
    const r = await at(p);
    assert.deepEqual([r.kind, r.states], ['boundary', ['EE', 'FF']], String(p));
    assert.ok(r.distanceMeters < 15);
  }
  assert.deepEqual(await at([4.99, 0.5]), { kind: 'inside', state: 'EE' }); // 1.1 km away
  assert.deepEqual(await at([10.2499, 0.5]).then((r) => [r.kind, r.states]), ['boundary', ['GG', 'HH']]);
  assert.deepEqual(await at([10.249, 0.5]), { kind: 'inside', state: 'GG' });
});
