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

/** Every tile key a box touches, as `row_col`. */
export function tilesForBox(west, south, east, north) {
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
