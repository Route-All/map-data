// Builds the US state-boundary grid (format/stateBoundary.mjs) from Census TIGER/Line state polygons (public domain).
//   node boundaries.mjs <work>     → <work>/boundaries/objects/<sha256>.json.gz and <work>/boundaries/manifest.json
// The 50 states and DC; territories read as outside the US. Objects are named by their hash and never change, so a
// new build reuses every block whose lines did not move.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as shapefile from 'shapefile';
import { buildGrid, encodeJson } from '../format/stateBoundary.mjs';

export const TIGER_YEAR = 2025;
const URL_ = `https://www2.census.gov/geo/tiger/TIGER${TIGER_YEAR}/STATE/tl_${TIGER_YEAR}_us_state.zip`;
const TERRITORIES = new Set(['PR', 'VI', 'GU', 'AS', 'MP', 'UM']);

export async function readStates(shpPath) {
  const states = [];
  const source = await shapefile.open(shpPath, shpPath.replace(/\.shp$/, '.dbf'));
  for (let r; !(r = await source.read()).done;) {
    const code = r.value.properties.STUSPS;
    if (TERRITORIES.has(code)) continue;
    const g = r.value.geometry;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    // GeoJSON closes rings by repeating the first point; the clipper wants it once.
    states.push({ code, polygons: polygons.map((poly) => poly.map((ring) => ring.slice(0, -1))) });
  }
  if (states.length !== 51) throw new Error(`expected 50 states and DC, read ${states.length}`);
  return states;
}

async function main(work) {
  const dir = path.join(work, 'boundaries'), objects = path.join(dir, 'objects'), src = path.join(work, 'tiger');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(objects, { recursive: true });
  fs.mkdirSync(src, { recursive: true });
  const zip = path.join(src, 'states.zip');
  if (!fs.existsSync(zip)) execFileSync('curl', ['-fsSL', '--retry', '5', '-A', 'RouteAll boundaries build', '-o', zip, URL_], { stdio: 'inherit' });
  execFileSync('unzip', ['-o', '-q', zip, '-d', src]);
  const shp = fs.readdirSync(src).find((f) => f.endsWith('.shp'));
  // Best effort: a Census hiccup on this HEAD must not fail the build; the date is informational.
  let lastModified = null;
  try { lastModified = execFileSync('curl', ['-fsSI', '-A', 'RouteAll boundaries build', URL_]).toString().match(/last-modified: (.+)/i)?.[1]?.trim() ?? null; } catch {}
  const started = Date.now();
  const { index, blocks } = buildGrid(await readStates(path.join(src, shp)));
  const put = (value) => {
    const bytes = encodeJson(value), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(objects, `${sha256}.json.gz`), bytes);
    return { key: `boundaries/v1/objects/${sha256}.json.gz`, sha256, bytes: bytes.length };
  };
  index.source = `TIGER/Line ${TIGER_YEAR} states`;
  const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifest = {
    schema: 1, buildId: builtAt.replace(/[-:]/g, ''), builtAt,
    source: { name: `Census TIGER/Line ${TIGER_YEAR} states`, url: URL_, lastModified },
    index: put(index),
    blocks: Object.fromEntries(Object.keys(blocks).sort().map((k) => [k, put(blocks[k])])),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
  const cells = Object.values(index.cells), total = [manifest.index, ...Object.values(manifest.blocks)].reduce((t, o) => t + o.bytes, 0);
  console.log(`boundaries: ${cells.length} cells (${cells.filter((c) => c === 0).length} with a line), ${Object.keys(blocks).length} blocks, ${(total / 1e6).toFixed(1)} MB, index ${(manifest.index.bytes / 1e3).toFixed(0)} KB, ${((Date.now() - started) / 1e3).toFixed(0)} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [work] = process.argv.slice(2);
  if (!work) throw new Error('usage: node boundaries.mjs <work dir>');
  await main(work);
}
