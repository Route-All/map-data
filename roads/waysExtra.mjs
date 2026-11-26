// Hand-kept tags on OSM way ids from a state DOT's open data (ways-extra.json): for pavement no name or ref tie can reach.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, 'ways-extra.json');
let byId = null;
const load = () => {
  if (byId) return byId;
  byId = new Map();
  for (const e of JSON.parse(fs.readFileSync(FILE, 'utf8')).entries) for (const id of e.ways) byId.set(String(id), e);
  return byId;
};
/** The way's tags with its entry's applied: only where it has `when`'s tags, lacks every key the entry sets (never over OSM) and every
 *  [lon, lat] of `coords` is inside the entry's box (an id a mapper's merge stretches onto other pavement keeps OSM's tags). */
export function withWayExtras(id, tags, coords) {
  const e = load().get(String(id).replace(/^w/, ''));
  if (!e) return tags;
  const [s, w, n, east] = e.box;
  if (!coords?.length || coords.some(([lon, lat]) => !(lat >= s && lat <= n && lon >= w && lon <= east))) return tags;
  if (Object.entries(e.when ?? {}).some(([k, v]) => tags[k] !== v)) return tags;
  if (Object.keys(e.set).some((k) => tags[k] != null && tags[k] !== '')) return tags;
  return { ...tags, ...e.set };
}
