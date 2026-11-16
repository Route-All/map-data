// Where each numbered route crosses a state line, built once per road build so the app looks a state-line start, end or
// bundle join up instead of searching ways at runtime.
//   node crossings.mjs <work>     after build.sh (which leaves <work>/routed.jsonl) and boundaries.mjs (<work>/boundaries)
// Writes the table as one more content-addressed object beside the boundary grid and lists it in boundaries/manifest.json
// as `crossings`, so it is published with the boundaries (KIND=boundaries) and read by the same loader.
// Each crossing: { from, to, network, ref, modifier, direction, at: [lon, lat], bearing } — travel from `from` into `to`
// along a way of that route relation, `bearing` the heading there in degrees. A two-way road crosses both ways; a one-way
// carriageway (or a relation role saying so) only the way it runs. `ref` keeps a relation's own ";" between refs, as the
// app's relationMatches reads it.
// Two kinds: a way that runs across the line, placed on the line; and two ways of the same route that meet at a node with
// a different state behind each (OSM splits most routes at the line, one relation per state), placed at that node.
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
// A join node further than this from any state line is no crossing (a route meeting itself inside a state).
const JOIN_METERS = 2000;

/** The state a point is plainly inside, or null (outside the US, or within the boundary's margin). */
export const stateOf = async (grid, p, boundaryMeters = 30) => { const r = await stateAt(grid.index, async (b) => grid.blocks[b], p, { boundaryMeters }); return r.kind === 'inside' ? r.state : null; };

/** The way's relations, each with the ways it may be driven: `fwd` along the way's coordinates, `back` against them. */
function entries(way) {
  const implied = way.oneway == null && (way.highway === 'motorway' || way.junction === 'roundabout' || way.junction === 'circular');
  return String(way.routes).split(';').map((entry) => {
    const [network, ref = '', modifier, role, direction] = entry.split('|');
    const forward = ['yes', '1', 'true'].includes(way.oneway) || implied || role === 'forward';
    const backward = way.oneway === '-1' || role === 'backward';
    return { network, ref: ref.replace(/\//g, ';'), ...(modifier ? { modifier } : {}), ...(direction ? { direction } : {}), fwd: !backward, back: !forward };
  });
}
const route = (e) => `${e.network}|${e.ref}|${e.modifier ?? ''}`;
const row = (e, from, to, at, way, bearing) => ({ from, to, network: e.network, ref: e.ref, ...(e.modifier ? { modifier: e.modifier } : {}), ...(e.direction ? { direction: e.direction } : {}), at, way, bearing });

/**
 * One routed way → { crossings, ends }. `way`: { id, routes ("network|ref|modifier|role|direction;..."), oneway, highway, junction,
 * coords: [[lon, lat], ...] }. A line inside the way is placed by halving the segment where the state changes, to well under a
 * metre. `ends`: each end within JOIN_METERS of a line, with the state behind it, for joins().
 */
export async function wayCrossings(grid, way) {
  const pts = way.coords, out = [], ends = [];
  if (pts.length < 2) return { crossings: out, ends };
  const es = entries(way), id = Number(way.id);
  let i = 0, a = null, first = null, margin;
  for (; i < pts.length && !(a = await stateOf(grid, pts[i])); i++);
  // A way with no point clear of the line's 30 m margin still lies in a state: the exact polygon says which. Kansas City's I-435 eastbound is
  // split at State Line Road and its next node is 22 m into Missouri (way 1295019164), so that way had no state, its end at the line made no
  // join, and the table held I-435's southern crossing out of Missouri but not into it.
  // Only a SHORT way (under 60 m): a route mapped along the line itself (US 71 on State Line Avenue, Texarkana) also lies within the margin, and
  // read point by point against the exact polygon it would flip state at every node and make crossings that are not there (Fable review).
  const metres = (p, q) => { const k = Math.PI / 180, x = (q[0] - p[0]) * k * Math.cos(((p[1] + q[1]) / 2) * k), y = (q[1] - p[1]) * k; return 6371e3 * Math.hypot(x, y); };
  const length = pts.reduce((t, p, k) => (k ? t + metres(pts[k - 1], p) : 0), 0);
  if (!a && length < 60) { margin = 0; for (i = 0; i < pts.length && !(a = await stateOf(grid, pts[i], 0)); i++); }
  first = a;
  for (let j = i + 1; j < pts.length; j++) {
    const b = await stateOf(grid, pts[j], margin);
    if (!b) continue;
    if (b !== a) {
      let lo = pts[i], hi = pts[j];
      for (let k = 0; k < 24; k++) {
        // No margin while halving: the exact polygon says which side each midpoint is on.
        const mid = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], s = await stateOf(grid, mid, 0);
        if (s === a) lo = mid; else if (s === b) hi = mid; else break; // on the line itself, or a third state: close enough
      }
      const at = [+((lo[0] + hi[0]) / 2).toFixed(6), +((lo[1] + hi[1]) / 2).toFixed(6)], ahead = bearing(pts[i], pts[j]);
      for (const e of es) {
        if (e.fwd) out.push(row(e, a, b, at, id, ahead));
        if (e.back) out.push(row(e, b, a, at, id, (ahead + 180) % 360));
      }
    }
    a = b; i = j;
  }
  if (first) {
    const last = pts.length - 1;
    // The start's state is the first one met from the start, the end's the last one: a way that crosses inside has two.
    for (const [k, prev, state, isLast] of [[0, pts[1], first, false], [last, pts[last - 1], a, true]]) {
      if ((await stateOf(grid, pts[k], JOIN_METERS)) === null) ends.push({ node: pts[k], prev, state, isLast, es, id });
    }
  }
  return { crossings: out, ends };
}

/**
 * Ends of different ways at the same node, the same route on both, a different state behind each → crossings at that node.
 * Travel from A's state into B's runs along A into the node (A's end: forward; A's start: backward), then along B out of it.
 */
export function joins(ends) {
  const at = new Map(), out = [];
  for (const e of ends) { const k = `${e.node[0]},${e.node[1]}`; at.set(k, [...(at.get(k) ?? []), e]); }
  for (const list of at.values()) {
    for (const A of list) for (const B of list) {
      if (A.id === B.id || A.state === B.state) continue;
      for (const ea of A.es) {
        if (!(A.isLast ? ea.fwd : ea.back)) continue;
        const eb = B.es.find((x) => route(x) === route(ea) && (B.isLast ? x.back : x.fwd));
        if (eb) out.push(row(ea, A.state, B.state, [+A.node[0].toFixed(6), +A.node[1].toFixed(6)], A.id, bearing(A.prev, A.node)));
      }
    }
  }
  return out;
}

/** Each crossing once (Geofabrik's state extracts overlap at the lines, so a border way can arrive twice), in a fixed order. */
export function table(crossings) {
  const key = (c) => [c.from, c.to, c.network, c.ref, c.modifier ?? '', c.direction ?? '', c.at[0], c.at[1], c.way, c.bearing].join('|');
  const seen = new Set(), cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return crossings.filter((c) => { const k = key(c); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => cmp(x.from, y.from) || cmp(x.to, y.to) || cmp(x.network, y.network) || cmp(x.ref, y.ref) || cmp(x.modifier ?? '', y.modifier ?? '')
      || cmp(x.direction ?? '', y.direction ?? '') || x.way - y.way || x.at[0] - y.at[0] || x.at[1] - y.at[1] || x.bearing - y.bearing);
}

async function main(work) {
  const dir = path.join(work, 'boundaries'), manifestFile = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const read = (o) => decodeJson(fs.readFileSync(path.join(dir, 'objects', `${o.sha256}.json.gz`)));
  const grid = { index: read(manifest.index), blocks: Object.fromEntries(Object.entries(manifest.blocks).map(([k, o]) => [k, read(o)])) };
  const crossings = [], ends = [], seenWays = new Set();
  let ways = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(work, 'routed.jsonl')), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const way = JSON.parse(line);
    if (seenWays.has(way.id)) continue;
    seenWays.add(way.id);
    ways++;
    const r = await wayCrossings(grid, way);
    crossings.push(...r.crossings);
    ends.push(...r.ends);
  }
  const joined = joins(ends), rows = table([...crossings, ...joined]);
  // No build time inside: the object is content-addressed, so an unchanged table keeps its hash and phones keep their copy.
  const bytes = encodeJson({ schema: 1, crossings: rows });
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(dir, 'objects', `${sha256}.json.gz`), bytes);
  manifest.crossings = { key: `boundaries/v1/objects/${sha256}.json.gz`, sha256, bytes: bytes.length };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest) + '\n');
  console.log(`crossings: ${rows.length} (${crossings.length} on a way, ${joined.length} at a join) from ${ways} routed ways, ${(bytes.length / 1e3).toFixed(0)} KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [work] = process.argv.slice(2);
  if (!work) throw new Error('usage: node crossings.mjs <work dir>');
  await main(work);
}
