// The query contract and tile format shared by worker.mjs (reads tiles), tile.mjs (writes them)
// and the tests. Kept apart from worker.mjs because a Worker's entry module may only export
// its handler.
import { gunzipSync } from 'node:zlib'; // native and synchronous in Workers (nodejs_compat)

// Tiles are 0.25° cells. The build and the reader both use these, so they cannot disagree.
export const PER_DEGREE = 4;
export const tileKey = (lat, lon) => `${Math.floor(lat * PER_DEGREE)}_${Math.floor(lon * PER_DEGREE)}`;

// The app asks 0.9° boxes on a 0.5° grid, which touch exactly 4x4 = 16 tiles (5x5 for an
// unaligned box). Anything bigger is not the app, so it goes to the public servers instead.
// With the per-tile cap this bounds what one request can read: 25 x 4 MB. The densest tile
// built so far (Baltimore) is 1.4 MB.
export const MAX_TILES = 25;
export const MAX_TILE_BYTES = 4 * 1024 * 1024;

const NUM = String.raw`-?\d{1,3}(?:\.\d+)?`;
const REF = String.raw`\d{1,5}[A-Za-z]?(?: Spur)?`; // "270 Spur": Maryland's I-270Y, see permitRoute roadClassKey
const WORD = '[A-Za-z0-9]{1,40}';
// Exactly osmQuery(refFilter(...) | nameFilter(...), box). The captured numbers and words are
// limited to characters that are plain literals in a regular expression, so turning them into
// a JS RegExp below cannot produce anything but the pattern the app meant.
const QUERY = new RegExp(String.raw`^\[out:json\]\[timeout:\d{1,4}\];way\["highway"\]\[(?:"ref"~"\(\^\|;\)\[A-Za-z\]\{0,8\} \?(${REF}|\(${REF}(?:\|${REF}){1,49}\))\(\$\|;\)"|"name"~"(${WORD}|\(${WORD}(?:\|${WORD}){1,49}\))",i)\]\((${NUM}),(${NUM}),(${NUM}),(${NUM})\);out geom;$`);

export function parseQuery(ql) {
  const m = QUERY.exec(ql ?? '');
  if (!m) return null;
  const [s, w, n, e] = m.slice(3).map(Number);
  if (!(s < n && w < e && s >= -90 && n <= 90 && w >= -180 && e <= 180)) return null;
  const box = { s, w, n, e };
  // Overpass regexes are case-sensitive unless the filter ends in ",i"; refFilter has no ",i".
  return m[1] ? { field: 'ref', test: new RegExp(`(^|;)[A-Za-z]{0,8} ?${m[1]}($|;)`), box }
    : { field: 'name', test: new RegExp(m[2], 'i'), box };
}

export function tilesFor({ s, w, n, e }) {
  const keys = [];
  for (let r = Math.floor(s * PER_DEGREE); r <= Math.floor(n * PER_DEGREE); r++) {
    for (let c = Math.floor(w * PER_DEGREE); c <= Math.floor(e * PER_DEGREE); c++) keys.push(`${r}_${c}`);
    if (keys.length > MAX_TILES) break;
  }
  return keys;
}

// Overpass returns a way when any part of it lies in the box, including a segment that
// crosses the box with both ends outside. Liang-Barsky clip of each segment against the box.
// `flat` is [lat, lon, lat, lon, ...]; a one-node way is a zero-length segment.
export function touchesBox(flat, { s, w, n, e }) {
  const last = flat.length - 2;
  for (let i = 0; i <= Math.max(0, last - 2); i += 2) {
    const y0 = flat[i], x0 = flat[i + 1], y1 = flat[Math.min(i + 2, last)], x1 = flat[Math.min(i + 3, last + 1)];
    const dx = x1 - x0, dy = y1 - y0;
    let t0 = 0, t1 = 1, hit = true;
    for (const [p, q] of [[-dx, x0 - w], [dx, e - x0], [-dy, y0 - s], [dy, n - y0]]) {
      if (p === 0) { if (q < 0) { hit = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { hit = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { hit = false; break; } if (r < t1) t1 = r; }
    }
    if (hit) return true;
  }
  return false;
}

// One tile, as tile.mjs packTile writes it:
//   [uint32 LE a][uint32 LE b][gzip, a bytes: ref index][gzip, b bytes: name index][groups...]
// A group is one gzip member holding every way in the tile with the same ref and name:
// a first line `ref \t name`, then one `id \t lat,lon,lat,lon,...` line per way.
// An index is the tile's distinct refs (or names), one per line, then a NUL, then for each of
// those lines the groups carrying it, as space-separated `offset:length` (offsets counted from
// the end of the name index).
// A query decompresses only the one index it needs, runs its regex over that text in a single
// pass, and decompresses only the matching groups. Decoding whole tiles cost 60-120 ms of CPU
// per query; this keeps the work proportional to the roads asked for.
export const MAX_DECODED_BYTES = 24 * 1024 * 1024; // per request; beyond it the app goes to the public servers
export class TooMuchData extends Error {}

function spend(budget, text) {
  if ((budget.left -= text.length) < 0) throw new TooMuchData();
  return text;
}

export function readTile(buffer, query, ways, budget = { left: MAX_DECODED_BYTES }) {
  if (!buffer.byteLength) return;
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const a = view.getUint32(0, true), b = view.getUint32(4, true), base = 8 + a + b;
  const index = spend(budget, gunzipSync(query.field === 'ref' ? bytes.subarray(8, 8 + a) : bytes.subarray(8 + a, base)).toString());
  const nul = index.indexOf('\0'), keys = index.slice(0, nul);
  // One native regex pass over all the distinct values; each line matches at most once.
  const scan = new RegExp(query.test.source, query.test.flags + 'gm'), groups = new Set();
  let lists, line = 0, lineStart = 0;
  for (let m; (m = scan.exec(keys));) {
    for (let nl; (nl = keys.indexOf('\n', lineStart)) !== -1 && nl < m.index;) { line++; lineStart = nl + 1; }
    lists ??= index.slice(nul + 1).split('\n');
    for (const at of lists[line].split(' ')) groups.add(at);
    const next = keys.indexOf('\n', m.index);
    if (next < 0) break;
    scan.lastIndex = next + 1;
  }
  for (const at of groups) {
    const [offset, length] = at.split(':').map(Number);
    const text = spend(budget, gunzipSync(bytes.subarray(base + offset, base + offset + length)).toString());
    const head = text.indexOf('\n');
    const [ref, name] = text.slice(0, head).split('\t');
    for (const way of text.slice(head + 1).split('\n')) {
      const tab = way.indexOf('\t'), id = way.slice(0, tab);
      if (ways.has(id)) continue;
      const flat = way.slice(tab + 1).split(',').map(Number);
      if (!touchesBox(flat, query.box)) continue;
      const geometry = [];
      for (let i = 0; i < flat.length; i += 2) geometry.push({ lat: flat[i], lon: flat[i + 1] });
      const tags = {};
      if (ref) tags.ref = ref;
      if (name) tags.name = name;
      ways.set(id, { type: 'way', id: Number(id), tags, geometry });
    }
  }
}
