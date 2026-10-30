// Cuts road lines into the tiles worker.mjs reads. build.sh runs it in two steps:
//   node tile.mjs add <work>  < roads.geojsonseq   one state at a time; appends to <work>/raw
//   node tile.mjs finish <work>                     dedupes, packs into <work>/tiles, writes build.json
// Appending state by state keeps memory and disk flat, and a tile on a state border simply
// collects ways from both states; `finish` drops the copies (Geofabrik extracts overlap).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { MAX_TILE_BYTES, PER_DEGREE } from './query.mjs';
import { encodeTile, TAGS } from '../format/roadTile.mjs';

// Ways Overpass would also return but a truck can never drive. The app's name match would
// otherwise happily snap a route onto a footpath that shares a street's name.
export const NOT_FOR_VEHICLES = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor',
  'proposed', 'construction', 'platform', 'elevator']);
// v2 also keeps roads with no name or number in the classes a truck uses, so pickup and delivery legs have real
// geometry; tracks, driveways and parking aisles stay out (plan 1.1).
const NOT_FOR_TRUCKS_UNNAMED = new Set(['track', 'bus_guideway', 'raceway', 'escape', 'busway']);
const UNNAMED_SERVICE_OUT = new Set(['parking_aisle', 'driveway', 'drive-through']);
export const keepUnnamed = (p) => !NOT_FOR_TRUCKS_UNNAMED.has(p.highway) && !(p.highway === 'service' && UNNAMED_SERVICE_OUT.has(p.service));
// v2 is read straight from R2 (no Worker), so its cap is only a sanity bound: dense tiles are never pruned to fit
// (spec section 4). Boston's is 3.8 MB; New York's will be larger.
const V2_MAX_TILE_BYTES = 16 * 1024 * 1024;
const clean = (s) => (s ?? '').replace(/[\t\r\n]/g, ' ');
const r5 = (x) => Math.round(x * 1e5) / 1e5; // ~1 m, far finer than a route needs

// One GeoJSON feature from `osmium export` → { v1, v2, keys } (v1 null for an unnamed road), or null to skip it.
export function toLine(feature) {
  const p = feature.properties ?? {};
  if (NOT_FOR_VEHICLES.has(p.highway) || feature.geometry?.type !== 'LineString') return null;
  const named = Boolean(p.ref || p.name);
  if (!named && !keepUnnamed(p)) return null;
  const pts = feature.geometry.coordinates.map(([lon, lat]) => [r5(lat), r5(lon)]);
  // Every tile any segment's bounding box touches: a superset of the tiles the line crosses,
  // which is what the worker needs, since it reads only the tiles under the asked box.
  const keys = new Set();
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[Math.min(i + 1, pts.length - 1)]];
    for (let r = Math.floor(Math.min(a[0], b[0]) * PER_DEGREE); r <= Math.floor(Math.max(a[0], b[0]) * PER_DEGREE); r++)
      for (let c = Math.floor(Math.min(a[1], b[1]) * PER_DEGREE); c <= Math.floor(Math.max(a[1], b[1]) * PER_DEGREE); c++) keys.add(`${r}_${c}`);
  }
  const head = `${p['@id']}\t${clean(p.ref)}\t${clean(p.name)}\t${pts.flat().join(',')}`;
  const tags = Object.fromEntries(TAGS.filter((t) => p[t] != null).map((t) => [t, String(p[t])]));
  return { v1: named ? `${head}\n` : null, v2: `${head}\t${JSON.stringify(tags)}\n`, keys };
}

async function add(work) {
  const raw = path.join(work, 'raw'), raw2 = path.join(work, 'raw2');
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(raw2, { recursive: true });
  const buffered = new Map(), buffered2 = new Map();
  let bytes = 0, ways = 0, named = 0;
  const flush = () => {
    for (const [key, lines] of buffered) fs.appendFileSync(path.join(raw, key), lines.join(''));
    for (const [key, lines] of buffered2) fs.appendFileSync(path.join(raw2, key), lines.join(''));
    buffered.clear(); buffered2.clear();
    bytes = 0;
  };
  const push = (map, key, line) => { if (!map.has(key)) map.set(key, []); map.get(key).push(line); bytes += line.length; };
  for await (const text of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    const out = toLine(JSON.parse(text.replace(/^\x1e/, '')));
    if (!out) continue;
    ways++;
    if (out.v1) named++;
    for (const key of out.keys) {
      if (out.v1) push(buffered, key, out.v1);
      push(buffered2, key, out.v2);
    }
    if (bytes > 256e6) flush();
  }
  flush();
  // A state with no roads means the download or the export went wrong, not an empty state.
  if (!named) throw new Error('no roads in this extract');
  console.log(`  ${named} named ways, ${ways} for v2`);
}

// Dedupes a tile's lines by way id (border tiles get the same way from two states) and packs
// them in the format query.mjs readTile documents.
export function packTile(lines) {
  const seen = new Set(), groups = new Map();
  for (const line of lines) {
    const t1 = line.indexOf('\t');
    const id = line.slice(0, t1);
    if (!line || seen.has(id)) continue;
    seen.add(id);
    const t3 = line.indexOf('\t', line.indexOf('\t', t1 + 1) + 1);
    const key = line.slice(t1 + 1, t3);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`${id}\t${line.slice(t3 + 1)}`);
  }
  const members = [], byRef = new Map(), byName = new Map();
  const add = (index, value, at) => { if (value) { if (!index.has(value)) index.set(value, []); index.get(value).push(at); } };
  let offset = 0;
  for (const [key, ways] of groups) {
    const gz = zlib.gzipSync(`${key}\n${ways.join('\n')}`, { level: 9 });
    const [ref, name] = key.split('\t');
    add(byRef, ref, `${offset}:${gz.length}`);
    add(byName, name, `${offset}:${gz.length}`);
    members.push(gz);
    offset += gz.length;
  }
  const pack = (index) => zlib.gzipSync(`${[...index.keys()].join('\n')}\0${[...index.values()].map((ats) => ats.join(' ')).join('\n')}`, { level: 9 });
  const refs = pack(byRef), names = pack(byName), head = Buffer.alloc(8);
  head.writeUInt32LE(refs.length, 0);
  head.writeUInt32LE(names.length, 4);
  return Buffer.concat([head, refs, names, ...members]);
}

// v2: each tile stored once under its SHA-256 and listed in the build's manifest with its size, so a listed tile
// that is missing is an error, never "no roads here" (plan 1.1, spec section 4).
function packTilesV2(work) {
  const raw2 = path.join(work, 'raw2'), out = path.join(work, 'tiles2');
  fs.mkdirSync(out, { recursive: true });
  const tiles = {};
  let bytes = 0;
  for (const key of fs.readdirSync(raw2).sort()) {
    const ways = fs.readFileSync(path.join(raw2, key), 'utf8').split('\n').filter(Boolean).map((line) => {
      const [id, ref, name, flat, tags] = line.split('\t');
      return { id, ref, name, coords: flat.split(',').map(Number), tags: JSON.parse(tags) };
    });
    const tile = encodeTile(ways);
    if (tile.length > V2_MAX_TILE_BYTES) throw new Error(`v2 tile ${key} is ${tile.length} bytes, over ${V2_MAX_TILE_BYTES}`);
    const sha256 = crypto.createHash('sha256').update(tile).digest('hex');
    fs.writeFileSync(path.join(out, `${sha256}.bin`), tile);
    tiles[key] = { key: `roads/v2/objects/${sha256}.bin`, sha256, bytes: tile.length };
    fs.rmSync(path.join(raw2, key));
    bytes += tile.length;
  }
  return { tiles, bytes };
}

function finish(work) {
  const raw = path.join(work, 'raw'), tiles = path.join(work, 'tiles');
  fs.mkdirSync(tiles, { recursive: true });
  let tileCount = 0, bytes = 0;
  for (const key of fs.readdirSync(raw)) {
    const tile = packTile(fs.readFileSync(path.join(raw, key), 'utf8').split('\n'));
    // The worker refuses bigger tiles; a build that makes one must not go live.
    if (tile.length > MAX_TILE_BYTES) throw new Error(`tile ${key} is ${tile.length} bytes, over ${MAX_TILE_BYTES}`);
    fs.writeFileSync(path.join(tiles, `${key}.bin`), tile);
    fs.rmSync(path.join(raw, key));
    tileCount++; bytes += tile.length;
  }
  if (!tileCount) throw new Error('no tiles');
  const sourceDates = Object.fromEntries(fs.readFileSync(path.join(work, 'sources.txt'), 'utf8').trim().split('\n').map((l) => l.split(' ')));
  const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const build = { buildId: builtAt.replace(/[-:]/g, ''), builtAt, tileCount, sourceDates };
  fs.writeFileSync(path.join(work, 'build.json'), JSON.stringify(build, null, 1) + '\n');
  console.log(`${tileCount} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
  // A v2 failure must not cost the v1 build above: without manifest2.json the roads2 publish fails on its own, after
  // v1 is live (roads.yml publishes v1 first).
  let v2;
  try { v2 = packTilesV2(work); } catch (error) { console.error(`::error::v2 tiles not built: ${error.message}`); return; }
  const manifest = {
    schema: 2, buildId: build.buildId, builtAt, grid: { perDegree: PER_DEGREE },
    // Coverage is the states built; a tile key absent from `tiles` is empty only inside them.
    coverage: { states: Object.keys(sourceDates).sort(), complete: true },
    sourceDates, tiles: v2.tiles,
  };
  fs.writeFileSync(path.join(work, 'manifest2.json'), JSON.stringify(manifest) + '\n');
  console.log(`v2: ${Object.keys(v2.tiles).length} tiles, ${(v2.bytes / 1e6).toFixed(1)} MB`);
}

const [cmd, work] = process.argv.slice(2);
if (cmd === 'add') await add(work);
else if (cmd === 'finish') finish(work);
else if (cmd) throw new Error(`usage: node tile.mjs add|finish <work dir>`);
