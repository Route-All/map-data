// Road tile v2: the one encoder and decoder for RouteAll's road tiles. Pure ESM on fflate, so the same file runs in
// the build (Node), the web console and the phone (through the app bundle). Never write a second reader.
//
// A tile is one 0.25° cell. Layout, all integers little-endian:
//   header, 28 bytes
//     0  "RAT2"                       format discriminator
//     4  uint16 version (2)           a reader rejects any other
//     6  uint16 flags                 required flags; a reader rejects any it does not know (none defined)
//     8  uint32 ref index length      gzip text
//    12  uint32 name index length     gzip text
//    16  uint32 attribute length      gzip text
//    20  uint32 spatial length        gzip text
//    24  uint32 group data length     concatenated gzip members
//   then the five sections in that order.
//
// Group: every way in the tile with the same ref and name, as v1 had them: a first line `ref \t name`, then one
//   `wayId \t lat,lon,lat,lon,...` line per way. Unnamed roads (v2 keeps the classes a truck uses) have both empty.
// Ref / name index: the tile's distinct refs (names), one per line, a NUL, then per line the group numbers carrying
//   it, space-separated. Empty refs and names are not indexed.
// Spatial: one line per group, in group order: `offset length west south east north`, offset from the start of the
//   group data, the box rounded outwards so it always contains the group.
// Attributes: the distinct tag sets, one per line as `k=v` pairs joined by \x1f, a NUL, then one `wayId \t setNumber`
//   line per way. Tags are raw OSM evidence (TAGS below); a tag that is absent is unknown, never "no limit".
//
// Coordinates are stored latitude first, as OSM exports them. The decoder hands out [lon, lat] (the app's Coord):
// the order is converted here and nowhere else.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';

export const MAGIC = 'RAT2';
export const VERSION = 2;
export const HEADER_BYTES = 28;
export const PER_DEGREE = 4;
/** The OSM tags kept per way, as raw evidence for routing and clearance. */
export const TAGS = ['highway', 'oneway', 'junction', 'service', 'layer', 'bridge', 'tunnel', 'access', 'hgv',
  'maxheight', 'maxwidth', 'maxweight'];

export const tileKey = (lat, lon) => `${Math.floor(lat * PER_DEGREE)}_${Math.floor(lon * PER_DEGREE)}`;

const wrapLon = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
/** Every tile key a box touches, as `row_col`. A box across 180° (west > east, or a side past ±180) is split there. */
export function tilesForBox(west, south, east, north) {
  if (west < -180 || east >= 180) { west = wrapLon(west); east = wrapLon(east); }
  if (west > east) return [...tilesForBox(west, south, 180 - 1e-9, north), ...tilesForBox(-180, south, east, north)];
  const keys = [];
  for (let r = Math.floor(south * PER_DEGREE); r <= Math.floor(north * PER_DEGREE); r++)
    for (let c = Math.floor(west * PER_DEGREE); c <= Math.floor(east * PER_DEGREE); c++) keys.push(`${r}_${c}`);
  return keys;
}

const clean = (s) => String(s ?? '').replace(/[\t\r\n\x1f\0]/g, ' ');
const down = (x) => Math.floor(x * 1e5) / 1e5, up = (x) => Math.ceil(x * 1e5) / 1e5;
const gz = (text) => gzipSync(strToU8(text), { level: 9, mtime: 0 });

export class TileFormatError extends Error {}

/**
 * Packs one tile. `ways`: [{ id, ref, name, coords, tags }], `coords` flat [lat, lon, lat, lon, ...] at 5 decimals.
 * The same way id twice (a border tile fed by two state extracts) keeps the first. Output is deterministic.
 */
export function encodeTile(ways) {
  const seen = new Set(), groups = new Map(), wayTags = [];
  for (const w of ways) {
    const id = String(w.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = `${clean(w.ref)}\t${clean(w.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, coords: w.coords });
    const pairs = TAGS.filter((t) => w.tags?.[t] != null && w.tags[t] !== '').map((t) => `${t}=${clean(w.tags[t])}`);
    wayTags.push([id, pairs.join('\x1f')]);
  }
  const keys = [...groups.keys()].sort();
  const members = [], spatial = [], byRef = new Map(), byName = new Map();
  const index = (map, value, g) => { if (value) { if (!map.has(value)) map.set(value, []); map.get(value).push(g); } };
  let offset = 0;
  keys.forEach((key, g) => {
    const list = groups.get(key).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const { coords } of list) for (let i = 0; i < coords.length; i += 2) {
      s = Math.min(s, coords[i]); n = Math.max(n, coords[i]); w = Math.min(w, coords[i + 1]); e = Math.max(e, coords[i + 1]);
    }
    const member = gz(`${key}\n${list.map((x) => `${x.id}\t${x.coords.join(',')}`).join('\n')}`);
    spatial.push(`${offset} ${member.length} ${down(w)} ${down(s)} ${up(e)} ${up(n)}`);
    const [ref, name] = key.split('\t');
    index(byRef, ref, g); index(byName, name, g);
    members.push(member);
    offset += member.length;
  });
  const packIndex = (map) => {
    const values = [...map.keys()].sort();
    return gz(`${values.join('\n')}\0${values.map((v) => map.get(v).join(' ')).join('\n')}`);
  };
  const sets = new Map();
  const rows = wayTags.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([id, set]) => {
    if (!sets.has(set)) sets.set(set, sets.size);
    return `${id}\t${sets.get(set)}`;
  });
  const sections = [packIndex(byRef), packIndex(byName), gz(`${[...sets.keys()].join('\n')}\0${rows.join('\n')}`),
    gz(spatial.join('\n'))];
  const groupBytes = members.reduce((t, m) => t + m.length, 0);
  const out = new Uint8Array(HEADER_BYTES + sections.reduce((t, x) => t + x.length, 0) + groupBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAGIC.charCodeAt(i);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true);
  sections.forEach((x, i) => view.setUint32(8 + i * 4, x.length, true));
  view.setUint32(24, groupBytes, true);
  let at = HEADER_BYTES;
  for (const x of [...sections, ...members]) { out.set(x, at); at += x.length; }
  return out;
}

/**
 * Opens a tile. Sections are decompressed on first use and each group once; `budget.left` (decoded characters)
 * bounds the work a caller can spend, throwing TileBudgetError past it.
 */
export function decodeTile(bytes, budget = { left: Infinity }) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < HEADER_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw new TileFormatError('not a v2 road tile');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true), flags = view.getUint16(6, true);
  if (version !== VERSION) throw new TileFormatError(`road tile version ${version}`);
  if (flags) throw new TileFormatError(`unknown road tile flags ${flags}`);
  const lengths = [0, 1, 2, 3, 4].map((i) => view.getUint32(8 + i * 4, true));
  const starts = [];
  let at = HEADER_BYTES;
  for (const l of lengths) { starts.push(at); at += l; }
  if (at !== bytes.length) throw new TileFormatError('road tile length does not match its header');
  const section = (i) => bytes.subarray(starts[i], starts[i] + lengths[i]);
  const text = (u8) => {
    const s = strFromU8(gunzipSync(u8));
    if ((budget.left -= s.length) < 0) throw new TileBudgetError();
    return s;
  };
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  const readIndex = (i) => once(`i${i}`, () => {
    const s = text(section(i)), nul = s.indexOf('\0');
    const values = s.slice(0, nul) ? s.slice(0, nul).split('\n') : [];
    const lists = values.length ? s.slice(nul + 1).split('\n').map((l) => l.split(' ').map(Number)) : [];
    return { values, lists };
  });
  const spatial = () => once('spatial', () => {
    const s = text(section(3));
    return s ? s.split('\n').map((l) => { const [o, len, w, so, e, n] = l.split(' ').map(Number); return { offset: o, length: len, west: w, south: so, east: e, north: n }; }) : [];
  });
  const attributes = () => once('attrs', () => {
    const s = text(section(2)), nul = s.indexOf('\0');
    const sets = s.slice(0, nul).split('\n').map((l) => Object.fromEntries(l ? l.split('\x1f').map((p) => { const eq = p.indexOf('='); return [p.slice(0, eq), p.slice(eq + 1)]; }) : []));
    const byWay = new Map();
    for (const row of s.slice(nul + 1).split('\n')) { if (!row) continue; const tab = row.indexOf('\t'); byWay.set(row.slice(0, tab), sets[Number(row.slice(tab + 1))]); }
    return byWay;
  });
  const group = (g) => once(`g${g}`, () => {
    const box = spatial()[g];
    if (!box) throw new TileFormatError(`no group ${g}`);
    const s = text(bytes.subarray(starts[4] + box.offset, starts[4] + box.offset + box.length));
    const head = s.indexOf('\n');
    const [ref, name] = s.slice(0, head).split('\t');
    const ways = s.slice(head + 1).split('\n').map((row) => {
      const tab = row.indexOf('\t'), flat = row.slice(tab + 1).split(',').map(Number), coords = [];
      for (let i = 0; i < flat.length; i += 2) coords.push([flat[i + 1], flat[i]]); // [lon, lat]
      return { id: row.slice(0, tab), coords };
    });
    return { ref, name, ways };
  });
  return {
    groupCount: () => spatial().length,
    spatial,
    group,
    /** Group numbers whose ref (`field: 'ref'`) or name matches `test`, from one regex pass over the index. */
    groupsMatching(field, test) {
      const { values, lists } = readIndex(field === 'ref' ? 0 : 1), out = new Set();
      values.forEach((v, i) => { test.lastIndex = 0; if (test.test(v)) for (const g of lists[i]) out.add(g); });
      return [...out].sort((a, b) => a - b);
    },
    /** The way's kept tags, or {} when it has none recorded. */
    tags: (wayId) => attributes().get(String(wayId)) ?? {},
  };
}
export class TileBudgetError extends Error {}

const R = 6371008.8, RAD = Math.PI / 180;
/** Distance in metres from p to segment a-b, all [lon, lat], and the nearest point on it (equirectangular, local). */
export function pointSegment(p, a, b) {
  const k = Math.cos(p[1] * RAD);
  const ax = (a[0] - p[0]) * k, ay = a[1] - p[1], bx = (b[0] - p[0]) * k, by = b[1] - p[1];
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  const x = ax + t * dx, y = ay + t * dy;
  return { meters: Math.sqrt(x * x + y * y) * RAD * R, point: [p[0] + x / k, p[1] + y], t };
}

/**
 * Every way in the given decoded tiles passing within `radiusMeters` of `point` ([lon, lat]): one candidate per way
 * (its nearest segment), deduplicated across tiles, sorted by distance then way id. Only groups whose box can reach
 * the radius are decoded.
 */
export function waysNear(tiles, point, radiusMeters) {
  const dLat = radiusMeters / (R * RAD), dLon = dLat / Math.max(0.01, Math.cos(point[1] * RAD));
  const best = new Map();
  for (const tile of tiles) {
    tile.spatial().forEach((box, g) => {
      if (box.east < point[0] - dLon || box.west > point[0] + dLon || box.north < point[1] - dLat || box.south > point[1] + dLat) return;
      const { ref, name, ways } = tile.group(g);
      for (const way of ways) {
        let hit = null;
        for (let i = 0; i < way.coords.length; i++) {
          const near = pointSegment(point, way.coords[i], way.coords[Math.min(i + 1, way.coords.length - 1)]);
          if (near.meters <= radiusMeters && (!hit || near.meters < hit.meters)) hit = { ...near, segment: i };
        }
        if (!hit) continue;
        const had = best.get(way.id);
        if (!had || hit.meters < had.distanceMeters) {
          best.set(way.id, { wayId: way.id, ref, name, coordinate: hit.point, distanceMeters: hit.meters, segment: hit.segment, coords: way.coords, tags: tile.tags(way.id) });
        }
      }
    });
  }
  return [...best.values()].sort((a, b) => a.distanceMeters - b.distanceMeters || (a.wayId < b.wayId ? -1 : a.wayId > b.wayId ? 1 : 0));
}

// ---- Road tile v3: read by byte ranges ------------------------------------------------------------------------------
//
// The same ways, groups, tags and [lon, lat] order as v2, laid out so a reader fetches only what a query needs. A v2
// tile had to be read whole (a one-state build moved 32-43 MB); a v3 reader asks for the tile's head, then only the
// chunks near a point or carrying a ref or name, each checked against its SHA-256.
//
// Chunks: the tile's ways are split by a quadtree over the tile until each leaf holds about CHUNK_TEXT characters, in
//   two layers: roads with a ref, then the rest, so a ref query never reads the side streets. A way goes to the leaf
//   holding its middle point (clamped into the tile); the leaf's box is the union of its ways' boxes, so it is
//   conservative. One chunk is one gzip member:
//     the chunk's distinct tag sets, one per line as `k=v` pairs joined by \x1f, a NUL, then its groups separated by
//     a blank line, each `ref \t name` then one `wayId \t setNumber \t lat,lon,lat,lon,...` line per way.
// Layout, all integers little-endian:
//   header, 24 bytes
//     0  "RAT3"
//     4  uint16 version (3)          a reader rejects any other
//     6  uint16 flags                required flags; none defined
//     8  uint32 table length         gzip text
//    12  uint32 ref index length     gzip text
//    16  uint32 name index length    gzip text
//    20  uint32 chunk data length    the chunks, back to back
//   then the four sections in that order. The HEAD is the header, the table and the ref index: one range, whose
//   SHA-256 the block manifest lists. Table: the name index's SHA-256 on the first line, then one line per chunk,
//   `offset length west south east north sha256`, offset from the start of the chunk data (decodeHead hands out
//   offsets from the start of the tile). Ref and name index: as v2, the
//   distinct values, a NUL, then per value the CHUNK numbers carrying it.
export const MAGIC3 = 'RAT3';
export const VERSION3 = 3;
export const HEADER3_BYTES = 24;
export const CHUNK_TEXT = 32 * 1024; // ~8 KB compressed: a phone decodes little more than the query box (measured 10-30: 96 KB read 13% more)
const MAX_DEPTH = 5;
const sha256Hex = (bytes) => bytesToHex(sha256(bytes));

/** Packs the tile `key` (`row_col`) as v3. Same ways and deduplication as encodeTile; output is deterministic. */
export function encodeTile3(ways, key, { chunkText = CHUNK_TEXT } = {}) {
  const seen = new Set(), rows = [];
  for (const w of ways) {
    const id = String(w.id);
    if (seen.has(id)) continue;
    seen.add(id);
    let s = Infinity, n = -Infinity, we = Infinity, e = -Infinity;
    for (let i = 0; i < w.coords.length; i += 2) { s = Math.min(s, w.coords[i]); n = Math.max(n, w.coords[i]); we = Math.min(we, w.coords[i + 1]); e = Math.max(e, w.coords[i + 1]); }
    const mid = Math.floor(w.coords.length / 4) * 2;
    const pairs = TAGS.filter((t) => w.tags?.[t] != null && w.tags[t] !== '').map((t) => `${t}=${clean(w.tags[t])}`);
    rows.push({ id, ref: clean(w.ref), name: clean(w.name), coords: w.coords, tags: pairs.join('\x1f'), box: [we, s, e, n], at: [w.coords[mid], w.coords[mid + 1]],
      size: id.length + w.coords.join(',').length + 4 });
  }
  const [r0, c0] = String(key).split('_').map(Number);
  if (!Number.isInteger(r0) || !Number.isInteger(c0)) throw new TileFormatError(`bad tile key ${key}`);
  const cell = [c0 / PER_DEGREE, r0 / PER_DEGREE, (c0 + 1) / PER_DEGREE, (r0 + 1) / PER_DEGREE]; // west south east north
  const leaves = [];
  const split = (list, [w, s, e, n], depth) => {
    if (!list.length) return;
    if (depth === MAX_DEPTH || list.reduce((t, r) => t + r.size, 0) <= chunkText) { leaves.push(list); return; }
    const mx = (w + e) / 2, my = (s + n) / 2, q = [[], [], [], []];
    for (const r of list) {
      const lat = Math.min(n, Math.max(s, r.at[0])), lon = Math.min(e, Math.max(w, r.at[1]));
      q[(lat >= my ? 2 : 0) + (lon >= mx ? 1 : 0)].push(r);
    }
    split(q[0], [w, s, mx, my], depth + 1); split(q[1], [mx, s, e, my], depth + 1);
    split(q[2], [w, my, mx, n], depth + 1); split(q[3], [mx, my, e, n], depth + 1);
  };
  split(rows.filter((r) => r.ref), cell, 0);
  split(rows.filter((r) => !r.ref), cell, 0);
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const chunks = [], byRef = new Map(), byName = new Map();
  const index = (map, value, c) => { if (value) { if (!map.has(value)) map.set(value, new Set()); map.get(value).add(c); } };
  leaves.forEach((leaf, c) => {
    const groups = new Map(), sets = new Map();
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const r of leaf.sort(byId)) {
      const key = `${r.ref}\t${r.name}`;
      if (!groups.has(key)) groups.set(key, []);
      if (!sets.has(r.tags)) sets.set(r.tags, sets.size);
      groups.get(key).push(`${r.id}\t${sets.get(r.tags)}\t${r.coords.join(',')}`);
      index(byRef, r.ref, c); index(byName, r.name, c);
      w = Math.min(w, r.box[0]); s = Math.min(s, r.box[1]); e = Math.max(e, r.box[2]); n = Math.max(n, r.box[3]);
    }
    const text = `${[...sets.keys()].join('\n')}\0${[...groups.keys()].sort().map((k) => `${k}\n${groups.get(k).join('\n')}`).join('\n\n')}`;
    chunks.push({ bytes: gz(text), box: [down(w), down(s), up(e), up(n)] });
  });
  const packIndex = (map) => {
    const values = [...map.keys()].sort();
    return gz(`${values.join('\n')}\0${values.map((v) => [...map.get(v)].sort((a, b) => a - b).join(' ')).join('\n')}`);
  };
  const refIndex = packIndex(byRef), nameIndex = packIndex(byName);
  let from = 0;
  const table = gz([sha256Hex(nameIndex), ...chunks.map((ch) => { const l = `${from} ${ch.bytes.length} ${ch.box.join(' ')} ${sha256Hex(ch.bytes)}`; from += ch.bytes.length; return l; })].join('\n'));
  const chunkBytes = chunks.reduce((t, ch) => t + ch.bytes.length, 0);
  const out = new Uint8Array(HEADER3_BYTES + table.length + refIndex.length + nameIndex.length + chunkBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MAGIC3.charCodeAt(i);
  view.setUint16(4, VERSION3, true);
  view.setUint16(6, 0, true);
  [table.length, refIndex.length, nameIndex.length, chunkBytes].forEach((l, i) => view.setUint32(8 + i * 4, l, true));
  let at = HEADER3_BYTES;
  for (const x of [table, refIndex, nameIndex, ...chunks.map((ch) => ch.bytes)]) { out.set(x, at); at += x.length; }
  return out;
}

/** Bytes from the start of a v3 tile to the end of its head (header, table, ref index), from its first 24 bytes. */
export function headLength(bytes) {
  const view = checkHeader3(bytes);
  return HEADER3_BYTES + view.getUint32(8, true) + view.getUint32(12, true);
}
function checkHeader3(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < HEADER3_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC3) throw new TileFormatError('not a v3 road tile');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== VERSION3) throw new TileFormatError(`road tile version ${view.getUint16(4, true)}`);
  if (view.getUint16(6, true)) throw new TileFormatError(`unknown road tile flags ${view.getUint16(6, true)}`);
  return view;
}
const readIndexText = (s) => {
  const nul = s.indexOf('\0');
  const values = s.slice(0, nul) ? s.slice(0, nul).split('\n') : [];
  return { values, lists: values.length ? s.slice(nul + 1).split('\n').map((l) => l.split(' ').map(Number)) : [] };
};

/**
 * Opens a v3 tile's head (exactly its first headLength bytes, already checked against the manifest). Returns the
 * chunk table and ref index, and the ranges a reader fetches next; every range carries the SHA-256 to check it by.
 */
export function decodeHead(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const view = checkHeader3(bytes);
  const [table, ref, name] = [8, 12, 16].map((o) => view.getUint32(o, true));
  if (bytes.length !== HEADER3_BYTES + table + ref) throw new TileFormatError('road tile head length does not match its header');
  const lines = strFromU8(gunzipSync(bytes.subarray(HEADER3_BYTES, HEADER3_BYTES + table))).split('\n');
  const base = HEADER3_BYTES + table + ref + name;
  const chunks = lines.slice(1).map((l) => {
    const [offset, length, west, south, east, north, sha256] = l.split(' ');
    return { offset: base + Number(offset), length: Number(length), west: Number(west), south: Number(south), east: Number(east), north: Number(north), sha256 };
  });
  return {
    chunks,
    nameIndex: { offset: HEADER3_BYTES + table + ref, length: name, sha256: lines[0] },
    refIndex: readIndexText(strFromU8(gunzipSync(bytes.subarray(HEADER3_BYTES + table)))),
    /** Chunk numbers whose box meets the given box. */
    chunksIn(west, south, east, north) {
      return chunks.flatMap((c, i) => (c.east < west || c.west > east || c.north < south || c.south > north ? [] : [i]));
    },
  };
}
/** A ref or name index (the head's refIndex, or the name index range decoded): chunk numbers whose value matches. */
export function decodeIndex(bytes) { return readIndexText(strFromU8(gunzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))); }
export function chunksMatching(index, test) {
  const out = new Set();
  index.values.forEach((v, i) => { test.lastIndex = 0; if (test.test(v)) for (const c of index.lists[i]) out.add(c); });
  return [...out].sort((a, b) => a - b);
}

/**
 * Decodes chunks (bytes already checked against the head) into the v2 DecodedTile interface, so waysNear and the
 * ref/name readers work on them unchanged: spatial() boxes are computed per group here, tags() covers these chunks'
 * ways. `budget.left` (decoded characters) bounds the work, as decodeTile's.
 */
export function decodeChunks(list, budget = { left: Infinity }) {
  const groups = [], tags = new Map();
  for (const bytes of list) {
    const s = strFromU8(gunzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
    if ((budget.left -= s.length) < 0) throw new TileBudgetError();
    const nul = s.indexOf('\0');
    const sets = s.slice(0, nul).split('\n').map((l) => Object.fromEntries(l ? l.split('\x1f').map((p) => { const eq = p.indexOf('='); return [p.slice(0, eq), p.slice(eq + 1)]; }) : []));
    const body = s.slice(nul + 1);
    if (!body) continue;
    for (const text of body.split('\n\n')) {
      const rows = text.split('\n'), [ref, name] = rows[0].split('\t');
      let w = Infinity, so = Infinity, e = -Infinity, n = -Infinity;
      const ways = rows.slice(1).map((row) => {
        const t1 = row.indexOf('\t'), t2 = row.indexOf('\t', t1 + 1), id = row.slice(0, t1);
        const flat = row.slice(t2 + 1).split(',').map(Number), coords = [];
        for (let i = 0; i < flat.length; i += 2) {
          coords.push([flat[i + 1], flat[i]]); // [lon, lat]
          so = Math.min(so, flat[i]); n = Math.max(n, flat[i]); w = Math.min(w, flat[i + 1]); e = Math.max(e, flat[i + 1]);
        }
        tags.set(id, sets[Number(row.slice(t1 + 1, t2))] ?? {});
        return { id, coords };
      });
      groups.push({ ref, name, ways, box: { offset: 0, length: 0, west: w, south: so, east: e, north: n } });
    }
  }
  return {
    groupCount: () => groups.length,
    spatial: () => groups.map((g) => g.box),
    group: (g) => { const x = groups[g]; if (!x) throw new TileFormatError(`no group ${g}`); return { ref: x.ref, name: x.name, ways: x.ways }; },
    groupsMatching(field, test) {
      const out = [];
      groups.forEach((g, i) => { const v = field === 'ref' ? g.ref : g.name; test.lastIndex = 0; if (v && test.test(v)) out.push(i); });
      return out;
    },
    tags: (wayId) => tags.get(String(wayId)) ?? {},
  };
}

// ---- Manifests (schema 3): a small top level, then one manifest per 2° block -----------------------------------------
export const SCHEMA = 3;
export const BLOCK_TILES = 8; // 2° of 0.25° tiles
/** The 2° block a tile key (`row_col`) belongs to, as `row_col` of blocks. */
export const blockOf = (key) => key.split('_').map((n) => Math.floor(Number(n) / BLOCK_TILES)).join('_');

// ---- SHA-256 (FIPS 180-4), for runtimes without Web Crypto (React Native's Hermes) and for the encoder ------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}
export const bytesToHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
