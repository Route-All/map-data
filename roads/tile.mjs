// Cuts road lines into the tiles worker.mjs reads. build.sh runs it in two steps:
//   node tile.mjs add <work>  < roads.geojsonseq   one state at a time; appends to <work>/raw
//   node tile.mjs finish <work>                     dedupes, packs into <work>/tiles, writes build.json
// Appending state by state keeps memory and disk flat, and a tile on a state border simply
// collects ways from both states; `finish` drops the copies (Geofabrik extracts overlap).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { MAX_TILE_BYTES, PER_DEGREE } from './query.mjs';

// Ways Overpass would also return but a truck can never drive. The app's name match would
// otherwise happily snap a route onto a footpath that shares a street's name.
export const NOT_FOR_VEHICLES = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor',
  'proposed', 'construction', 'platform', 'elevator']);
const clean = (s) => (s ?? '').replace(/[\t\r\n]/g, ' ');
const r5 = (x) => Math.round(x * 1e5) / 1e5; // ~1 m, far finer than a route needs

// One GeoJSON feature from `osmium export` → [tile line, tile keys], or null to skip it.
export function toLine(feature) {
  const p = feature.properties ?? {};
  if (NOT_FOR_VEHICLES.has(p.highway) || !(p.ref || p.name) || feature.geometry?.type !== 'LineString') return null;
  const pts = feature.geometry.coordinates.map(([lon, lat]) => [r5(lat), r5(lon)]);
  // Every tile any segment's bounding box touches: a superset of the tiles the line crosses,
  // which is what the worker needs, since it reads only the tiles under the asked box.
  const keys = new Set();
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i], pts[Math.min(i + 1, pts.length - 1)]];
    for (let r = Math.floor(Math.min(a[0], b[0]) * PER_DEGREE); r <= Math.floor(Math.max(a[0], b[0]) * PER_DEGREE); r++)
      for (let c = Math.floor(Math.min(a[1], b[1]) * PER_DEGREE); c <= Math.floor(Math.max(a[1], b[1]) * PER_DEGREE); c++) keys.add(`${r}_${c}`);
  }
  return [`${p['@id']}\t${clean(p.ref)}\t${clean(p.name)}\t${pts.flat().join(',')}\n`, keys];
}

async function add(work) {
  const raw = path.join(work, 'raw');
  fs.mkdirSync(raw, { recursive: true });
  const buffered = new Map();
  let bytes = 0, ways = 0;
  const flush = () => {
    for (const [key, lines] of buffered) fs.appendFileSync(path.join(raw, key), lines.join(''));
    buffered.clear();
    bytes = 0;
  };
  for await (const text of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    const out = toLine(JSON.parse(text.replace(/^\x1e/, '')));
    if (!out) continue;
    ways++;
    for (const key of out[1]) {
      if (!buffered.has(key)) buffered.set(key, []);
      buffered.get(key).push(out[0]);
      bytes += out[0].length;
    }
    if (bytes > 256e6) flush();
  }
  flush();
  // A state with no roads means the download or the export went wrong, not an empty state.
  if (!ways) throw new Error('no roads in this extract');
  console.log(`  ${ways} ways`);
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
}

const [cmd, work] = process.argv.slice(2);
if (cmd === 'add') await add(work);
else if (cmd === 'finish') finish(work);
else if (cmd) throw new Error(`usage: node tile.mjs add|finish <work dir>`);
