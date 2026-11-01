// Traffic signals for turn-by-turn ("at the second light, turn right") and the lights-ahead cue, cut into tiles
// the phone reads straight from R2 (format/signals.md). build.sh runs it like pois.mjs:
//   node signals.mjs add <work>  < signals.geojsonseq   one Geofabrik state at a time; appends to <work>/signals-raw.csv
//   node signals.mjs finish <work>                      merges, writes <work>/signals/<row>_<col>.json + signals.json
// Source: OSM nodes tagged highway=traffic_signals. Pedestrian-only signals are highway=crossing +
// crossing=traffic_signals and never pass build.sh's filter.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

export const DEG = 0.25; // the tile size the pointer names; the app keys tiles the same way
// ponytail: single-linkage at 30 m. One junction's per-approach nodes merge, but two separate lights closer than
// 30 m (a divided road's median crossing) become one, and a chain of nodes can span more. Group by the OSM
// junction node the ways share if that miscounts lights.
export const MERGE_M = 30;

const r5 = (x) => Math.round(x * 1e5) / 1e5;
export const signalKey = (lon, lat) => `${Math.floor(lat / DEG)}_${Math.floor(lon / DEG)}`;

/** OSM signal nodes ([lon, lat][]) → one [lon, lat] per light: nodes within `within` m of each other, their mean. */
export function mergeSignals(points, within = MERGE_M) {
  // 0.001° cells: at least 30 m wide in longitude up to 74° N, so a neighbour within 30 m is in the 3×3 around it.
  const cell = (lon, lat) => `${Math.floor(lat * 1000)}_${Math.floor(lon * 1000)}`;
  const grid = new Map();
  points.forEach(([lon, lat], i) => {
    const k = cell(lon, lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const parent = points.map((_, i) => i);
  const root = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  points.forEach(([lon, lat], i) => {
    const kx = 111_320 * Math.cos((lat * Math.PI) / 180), r0 = Math.floor(lat * 1000), c0 = Math.floor(lon * 1000);
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) for (const j of grid.get(`${r}_${c}`) ?? []) {
      if (j <= i) continue;
      const [x, y] = points[j];
      if (Math.hypot((x - lon) * kx, (y - lat) * 111_320) <= within) parent[root(j)] = root(i);
    }
  });
  const groups = new Map();
  points.forEach((p, i) => {
    const g = root(i);
    if (!groups.has(g)) groups.set(g, [0, 0, 0]);
    const s = groups.get(g);
    s[0] += p[0]; s[1] += p[1]; s[2]++;
  });
  return [...groups.values()].map(([x, y, n]) => [r5(x / n), r5(y / n)]);
}

/** Merged lights → { "<row>_<col>": { s: [[lon, lat], ...] } }, keyed by the rounded point the tile holds. */
export function signalTiles(points) {
  const tiles = {};
  for (const p of points) (tiles[signalKey(p[0], p[1])] ??= { s: [] }).s.push(p);
  return tiles;
}

async function add(work) {
  const out = [];
  for await (const text of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    const f = JSON.parse(text.replace(/^\x1e/, ''));
    if (f.geometry?.type !== 'Point') continue;
    out.push(`${f.properties?.['@id'] ?? ''},${f.geometry.coordinates[0]},${f.geometry.coordinates[1]}\n`);
  }
  fs.appendFileSync(path.join(work, 'signals-raw.csv'), out.join(''));
  console.log(`  ${out.length} signal nodes`);
}

function finish(work) {
  const raw = path.join(work, 'signals-raw.csv'), out = path.join(work, 'signals');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // Border nodes come in both states' extracts: one per OSM id before merging, so the mean is not weighted.
  const byId = new Map();
  for (const line of fs.readFileSync(raw, 'utf8').split('\n')) {
    if (!line) continue;
    const [id, lon, lat] = line.split(',');
    byId.set(id, [Number(lon), Number(lat)]);
  }
  const lights = mergeSignals([...byId.values()]);
  let tileCount = 0, bytes = 0;
  // Gzip bodies like the place tiles (pois.mjs): the phone gunzips them itself.
  for (const [key, tile] of Object.entries(signalTiles(lights))) {
    const gz = zlib.gzipSync(JSON.stringify(tile), { level: 9 });
    fs.writeFileSync(path.join(out, `${key}.json`), gz);
    tileCount++; bytes += gz.length;
  }
  fs.rmSync(raw, { force: true });
  if (!tileCount) throw new Error('no signal tiles');
  const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const build = { buildId: builtAt.replace(/[-:]/g, ''), builtAt, tileCount, deg: DEG, nodes: byId.size, signals: lights.length };
  fs.writeFileSync(path.join(work, 'signals.json'), JSON.stringify(build, null, 1) + '\n');
  console.log(`${byId.size} signal nodes → ${lights.length} lights in ${tileCount} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
}

const [cmd, work] = process.argv[1]?.endsWith('signals.mjs') ? process.argv.slice(2) : [];
if (cmd === 'add') await add(work);
else if (cmd === 'finish') finish(work);
else if (cmd) throw new Error('usage: node signals.mjs add|finish <work dir>');
