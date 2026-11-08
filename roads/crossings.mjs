// Where each numbered route crosses a state line, built once per road build so the app looks a state-line start, end or
// bundle join up instead of searching ways at runtime.
//   node crossings.mjs <work>     after build.sh (which leaves <work>/routed.jsonl) and boundaries.mjs (<work>/boundaries)
// Writes the table as one more content-addressed object beside the boundary grid and lists it in boundaries/manifest.json
// as `crossings`, so it is published with the boundaries (KIND=boundaries) and read by the same loader.
// Each crossing: { from, to, network, ref, modifier, direction, at: [lon, lat], bearing } — travel from `from` into `to`
// along a way of that route relation, `bearing` the heading there in degrees. A two-way road crosses both ways; a one-way
// carriageway (or a relation role saying so) only the way it runs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { decodeJson, encodeJson, stateAt } from '../format/stateBoundary.mjs';

const RAD = Math.PI / 180;
const bearing = (a, b) => {
  const y = Math.sin((b[0] - a[0]) * RAD) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((b[0] - a[0]) * RAD);
  return Math.round(((Math.atan2(y, x) / RAD) + 360) % 360);
};

/** The state a point is plainly inside, or null (outside the US, or within the boundary's margin). */
export const stateOf = async (grid, p, boundaryMeters = 30) => { const r = await stateAt(grid.index, async (b) => grid.blocks[b], p, { boundaryMeters }); return r.kind === 'inside' ? r.state : null; };

/**
 * One routed way → its crossings. `way`: { id, routes ("network|ref|modifier|role|direction;..."), oneway, coords: [[lon, lat], ...] }.
 * The line is placed by halving the segment where the state changes, to well under a metre.
 */
export async function wayCrossings(grid, way) {
  const pts = way.coords, out = [];
  if (pts.length < 2) return out;
  let i = 0, a = null;
  for (; i < pts.length && !(a = await stateOf(grid, pts[i])); i++);
  for (let j = i + 1; j < pts.length; j++) {
    const b = await stateOf(grid, pts[j]);
    if (!b) continue;
    if (b !== a) {
      let lo = pts[i], hi = pts[j];
      for (let k = 0; k < 24; k++) {
        // No margin while halving: the exact polygon says which side each midpoint is on.
        const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], s = await stateOf(grid, mid, 0);
        if (s === a) lo = mid; else if (s === b) hi = mid; else break; // on the line itself, or a third state: close enough
      }
      const at = [+((lo[0] + hi[0]) / 2).toFixed(6), +((lo[1] + hi[1]) / 2).toFixed(6)], ahead = bearing(pts[i], pts[j]);
      for (const entry of String(way.routes).split(';')) {
        const [network, ref, modifier, role, direction] = entry.split('|');
        const forward = ['yes', '1', 'true'].includes(way.oneway) || role === 'forward';
        const backward = way.oneway === '-1' || role === 'backward';
        const base = { network, ref, ...(modifier ? { modifier } : {}), ...(direction ? { direction } : {}), at, way: Number(way.id) };
        if (!backward) out.push({ from: a, to: b, ...base, bearing: ahead });
        if (!forward) out.push({ from: b, to: a, ...base, bearing: (ahead + 180) % 360 });
      }
    }
    a = b; i = j;
  }
  return out;
}

async function main(work) {
  const dir = path.join(work, 'boundaries'), manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const read = (o) => decodeJson(fs.readFileSync(path.join(dir, 'objects', `${o.sha256}.json.gz`)));
  const grid = { index: read(manifest.index), blocks: Object.fromEntries(Object.entries(manifest.blocks).map(([k, o]) => [k, read(o)])) };
  const crossings = [];
  let ways = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(work, 'routed.jsonl')), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    ways++;
    crossings.push(...await wayCrossings(grid, JSON.parse(line)));
  }
  // Geofabrik's state extracts overlap at the lines, so a border way can arrive twice.
  const seen = new Set(), table = crossings.filter((c) => { const k = `${c.way}|${c.from}|${c.to}|${c.network}|${c.ref}|${c.modifier ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => (`${x.from}${x.to}${x.network}${x.ref}` < `${y.from}${y.to}${y.network}${y.ref}` ? -1 : 1) || x.way - y.way);
  const bytes = encodeJson({ schema: 1, builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), crossings: table });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, 'objects', `${sha256}.json.gz`), bytes);
  manifest.crossings = { key: `boundaries/v1/objects/${sha256}.json.gz`, sha256, bytes: bytes.length };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest) + '\n');
  console.log(`crossings: ${table.length} from ${ways} routed ways, ${(bytes.length / 1e3).toFixed(0)} KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [work] = process.argv.slice(2);
  if (!work) throw new Error('usage: node crossings.mjs <work dir>');
  await main(work);
}
