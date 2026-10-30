// US state boundaries on the road tiles' 0.25° grid: the one encoder and lookup for "which state is this point in"
// (plan 1.3). Pure ESM on fflate, like roadTile.mjs.
//
// Two kinds of object, both gzip JSON, coordinates [lon, lat]:
//   index   { schema: 1, perDegree: 4, source, cells: { "row_col": "TX" | 0 } }
//           a state code: the whole cell lies in that state; 0: a state line or the coast crosses it, read its block.
//           A cell not listed is outside the US (ocean, Canada, Mexico).
//   block   one per 1° (4×4 cells), only for cells holding a line: { "row_col": { "TX": [ring, ...], ... } }
//           each state's area inside that cell at full TIGER resolution, as rings clipped to the cell (even-odd).
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

export const SCHEMA = 1;
export const PER_DEGREE = 4;
export const cellKey = (lon, lat) => `${Math.floor(lat * PER_DEGREE)}_${Math.floor(lon * PER_DEGREE)}`;
/** The 1° block a cell's rings are stored in. */
export const blockKey = (cell) => cell.split('_').map((n) => Math.floor(Number(n) / PER_DEGREE)).join('_');
export const cellBounds = (cell) => {
  const [r, c] = cell.split('_').map(Number);
  return { west: c / PER_DEGREE, south: r / PER_DEGREE, east: (c + 1) / PER_DEGREE, north: (r + 1) / PER_DEGREE };
};

export const encodeJson = (value) => gzipSync(strToU8(JSON.stringify(value)), { level: 9, mtime: 0 });
export const decodeJson = (bytes) => JSON.parse(strFromU8(gunzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))));

/** Sutherland–Hodgman clip of one ring ([lon, lat][]) to a box; [] when nothing is left. */
export function clipRing(ring, { west, south, east, north }) {
  let pts = ring;
  const edges = [
    [(p) => p[0] >= west, (a, b) => [west, a[1] + ((b[1] - a[1]) * (west - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= east, (a, b) => [east, a[1] + ((b[1] - a[1]) * (east - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= south, (a, b) => [a[0] + ((b[0] - a[0]) * (south - a[1])) / (b[1] - a[1]), south]],
    [(p) => p[1] <= north, (a, b) => [a[0] + ((b[0] - a[0]) * (north - a[1])) / (b[1] - a[1]), north]],
  ];
  for (const [inside, cross] of edges) {
    if (!pts.length) break;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cross(prev, cur)); out.push(cur); } else if (pi) out.push(cross(prev, cur));
    }
    pts = out;
  }
  return pts.length >= 3 ? pts : [];
}

/** Even-odd point in rings. */
export function inRings(p, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
  }
  return inside;
}

const R = 6371008.8, RAD = Math.PI / 180;
const onCellEdge = (a, b, box) => (a[0] === b[0] && (a[0] === box.west || a[0] === box.east)) || (a[1] === b[1] && (a[1] === box.south || a[1] === box.north));
/** Metres from p to the nearest real boundary edge of `rings` (edges the clip laid along the cell border are not real). */
export function distanceToEdge(p, rings, box) {
  const k = Math.cos(p[1] * RAD);
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (box && onCellEdge(a, b, box)) continue;
    const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], dx = (b[0] - a[0]) * k, dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy) * RAD * R);
  }
  return best;
}

/**
 * The state a point ([lon, lat]) is in, as StateEvidence:
 *   { kind: 'inside', state } | { kind: 'boundary', states, distanceMeters } | { kind: 'outside_us' }
 *   | { kind: 'unavailable', reason }
 * `boundary` when the point is within `boundaryMeters` of a line between states (or the coast): the caller decides
 * with the permit's own crossing, or asks for review. `getBlock(blockKey)` resolves to the decoded block, or null.
 */
export async function stateAt(index, getBlock, point, { boundaryMeters = 30 } = {}) {
  if (!index || index.schema !== SCHEMA) return { kind: 'unavailable', reason: 'no boundary index' };
  const cell = cellKey(point[0], point[1]), entry = index.cells[cell];
  if (entry === undefined) return { kind: 'outside_us' };
  if (entry) return { kind: 'inside', state: entry };
  let block;
  try { block = await getBlock(blockKey(cell)); } catch (e) { return { kind: 'unavailable', reason: String(e?.message ?? e) }; }
  const pieces = block?.[cell];
  if (!pieces) return { kind: 'unavailable', reason: `missing boundary block for ${cell}` };
  const box = cellBounds(cell);
  const states = Object.keys(pieces).sort();
  const containing = states.filter((s) => inRings(point, pieces[s]));
  const near = states.map((s) => ({ s, d: distanceToEdge(point, pieces[s], box) })).filter((x) => x.d <= boundaryMeters);
  if (near.length) {
    const all = [...new Set([...containing, ...near.map((x) => x.s)])].sort();
    return { kind: 'boundary', states: all, distanceMeters: Math.min(...near.map((x) => x.d)) };
  }
  if (containing.length === 1) return { kind: 'inside', state: containing[0] };
  if (!containing.length) return { kind: 'outside_us' };
  return { kind: 'boundary', states: containing, distanceMeters: 0 }; // overlapping source polygons: never guess
}

/**
 * Builds the index and blocks from state polygons: `states` is [{ code, polygons: [[ring, ...], ...] }] in [lon, lat].
 * Clips hierarchically (4°, 1°, 0.25°) so a 100k-vertex state is not walked once per cell.
 */
export function buildGrid(states, { round = 6 } = {}) {
  const f = 10 ** round, rnd = (p) => [Math.round(p[0] * f) / f, Math.round(p[1] * f) / f];
  const cells = new Map(); // cell → Map(state → rings)
  const add = (cell, code, ring) => {
    if (!cells.has(cell)) cells.set(cell, new Map());
    const m = cells.get(cell);
    if (!m.has(code)) m.set(code, []);
    m.get(code).push(ring);
  };
  const bboxOf = (ring) => ring.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const split = (code, ring, size) => {
    const [w, s, e, n] = bboxOf(ring);
    for (let y = Math.floor(s / size) * size; y < n; y += size) for (let x = Math.floor(w / size) * size; x < e; x += size) {
      const box = { west: x, south: y, east: x + size, north: y + size };
      const piece = clipRing(ring, box);
      if (!piece.length) continue;
      if (size > 1 / PER_DEGREE) split(code, piece, size === 4 ? 1 : 1 / PER_DEGREE);
      else add(cellKey(x + size / 2, y + size / 2), code, piece.map(rnd));
    }
  };
  for (const { code, polygons } of states) for (const poly of polygons) for (const ring of poly) split(code, ring, 4);
  const index = {}, blocks = {};
  for (const [cell, byState] of [...cells].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const box = cellBounds(cell);
    const only = byState.size === 1 ? [...byState.keys()][0] : null;
    // Whole cell in one state: every ring vertex on the cell border (no line inside) and the centre inside it.
    const centre = [(box.west + box.east) / 2, (box.south + box.north) / 2];
    const whole = only && [...byState.values()][0].every((ring) => ring.every((p) => p[0] === box.west || p[0] === box.east || p[1] === box.south || p[1] === box.north))
      && inRings(centre, byState.get(only));
    if (whole) { index[cell] = only; continue; }
    index[cell] = 0;
    const b = blockKey(cell);
    blocks[b] ??= {};
    blocks[b][cell] = Object.fromEntries([...byState].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  }
  return { index: { schema: SCHEMA, perDegree: PER_DEGREE, cells: index }, blocks };
}
