// Truck stops, fuel, rest areas and weigh stations for the map's Find Stops chips, cut into
// tiles the phone reads straight from R2 (services/placeTiles.ts). build.sh runs it like tile.mjs:
//   node pois.mjs add <work> <state>  < places.geojsonseq   one Geofabrik state at a time; appends to <work>/pois-raw
//   node pois.mjs finish <work>                     dedupes, writes <work>/pois/<row>_<col>.bin + pois.json
// Places do not move, so a weekly rebuild from OpenStreetMap is plenty.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

export const PLACE_PER_DEGREE = 2; // 0.5° tiles: a 40 km search touches at most 9
// Chains that are truck stops whoever tagged them; OSM rarely says hgv=yes on these.
const TRUCK_BRANDS = /\b(pilot|flying j|one9|love'?s|travelcenters|^ta$|ta express|petro( stopping)?|sapp bros|ambest|roady'?s|bosselman|little america|iowa 80|road ranger|town pump|boss shop)\b/i;
// Independents OSM tags only as fuel, but whose name says what they are (truck-stop audit 2026-10-24: 142 sites).
const TRUCK_NAME = /\b(truck ?stop|travel (center|centre|plaza|stop)|truck plaza|auto ?truck)\b/i;
// Kwik Trip / Kwik Star: a truck stop only where it has showers (all 101 Kwik Stars were pins before, most are not).
const SHOWER_TRUCK_BRANDS = /\bkwik (trip|star)\b/i;
// Signed for cars only: never a truck stop, whatever else the tags say.
const CARS_ONLY = /\bbuc-?ee'?s\b/i;
// Geofabrik extract name → USPS code, stored on each place so the app can find its region's fuel price.
const STATE_CODES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district-of-columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new-hampshire': 'NH', 'new-jersey': 'NJ', 'new-mexico': 'NM', 'new-york': 'NY',
  'north-carolina': 'NC', 'north-dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode-island': 'RI', 'south-carolina': 'SC', 'south-dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west-virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
export const stateCode = (name) => {
  const code = STATE_CODES[name];
  if (!code) throw new Error(`unknown state ${name}`);
  return code;
};
const yes = (v) => v === 'yes' || v === 'designated' || v === 'only';
// "24/7" and "Mo-Su 00:00-24:00" both mean open all day; the app shows that as "Open 24 hours".
export const hoursOf = (h) => (!h ? null : /^(24\/7|(Mo-Su )?00:00-(24:00|23:59))$/.test(String(h).trim()) ? '24hr' : String(h));
const r5 = (x) => Math.round(x * 1e5) / 1e5;

const CAT_SCALE = /\bcat scale/i;
const TRUCK_WASH = /\b(truck ?wash|blue beacon)\b/i;

// One GeoJSON feature from `osmium export` → a place row, or null. Kinds, most specific first:
//   truck_stop (travel centers, truck-stop chains, diesel-for-trucks fuel, truck parking),
//   weigh_station (state inspection sites and CAT scales), rest_area, fuel, truck_wash.
// `kind` is what the Find Stops search filters on and never changes meaning, because installed
// apps read the same tiles. `cat` is the map's pin: it splits truck parking out of truck_stop and
// CAT scales out of weigh_station. Apps older than the map layer ignore `cat` and unknown kinds.
export function toPlace(feature) {
  const p = feature.properties ?? {};
  const name = p.name || p.brand || '';
  const label = `${p.brand ?? ''} ${p.name ?? ''}`;
  const truckFuel = p.amenity === 'fuel' && !CARS_ONLY.test(label) && (TRUCK_BRANDS.test(p.brand ?? '') || TRUCK_BRANDS.test(p.name ?? '')
    || TRUCK_NAME.test(p.name ?? '') || (SHOWER_TRUCK_BRANDS.test(label) && (yes(p.shower) || yes(p.showers)))
    || yes(p.hgv) || yes(p['fuel:HGV_diesel']));
  const truckParking = p.amenity === 'parking' && yes(p.hgv);
  let kind = null;
  if ((p.highway === 'services' && !CARS_ONLY.test(label)) || truckFuel || truckParking) kind = 'truck_stop';
  else if (p.amenity === 'weighbridge') kind = 'weigh_station';
  else if (p.highway === 'rest_area') kind = 'rest_area';
  else if (p.amenity === 'fuel' || (p.highway === 'services' && CARS_ONLY.test(label))) kind = 'fuel';
  else if (p.amenity === 'car_wash' && (yes(p.hgv) || yes(p.truck_wash) || TRUCK_WASH.test(name))) kind = 'truck_wash';
  if (!kind) return null;
  const at = centre(feature.geometry);
  if (!at) return null;
  const cat = truckParking && !truckFuel && p.highway !== 'services' ? 'parking'
    : kind === 'weigh_station' && (CAT_SCALE.test(name) || CAT_SCALE.test(p.brand ?? '')) ? 'scale' : kind;
  return {
    id: String(p['@id'] ?? ''), kind, cat, name: name || (p.amenity === 'parking' ? 'Truck Parking' : ''),
    lat: r5(at[1]), lon: r5(at[0]),
    fuel: p.amenity === 'fuel' || p.highway === 'services' || p.fuel === 'yes' ? 1 : 0,
    diesel: yes(p['fuel:diesel']) || yes(p['fuel:HGV_diesel']) || truckFuel ? 1 : 0,
    showers: yes(p.shower) || yes(p.showers) ? 1 : 0,
    food: yes(p.food) || yes(p.restaurant) || p.highway === 'services' ? 1 : 0,
    scales: p.amenity === 'weighbridge' || CAT_SCALE.test(name) ? 1 : 0,
    hours: hoursOf(p.opening_hours),
    phone: p.phone || p['contact:phone'] || null,
    parking: Number.parseInt(p['capacity:hgv'] ?? '', 10) || null,
    addr: [[p['addr:housenumber'], p['addr:street']].filter(Boolean).join(' '), p['addr:city']].filter(Boolean).join(', ') || null,
  };
}

// A point, or the mean of a polygon's outer ring: close enough for a map pin at a site this size.
function centre(g) {
  if (g?.type === 'Point') return g.coordinates;
  const ring = g?.type === 'Polygon' ? g.coordinates[0] : g?.type === 'MultiPolygon' ? g.coordinates[0]?.[0] : null;
  if (!ring?.length) return null;
  const [x, y] = ring.reduce(([a, b], [lon, lat]) => [a + lon, b + lat], [0, 0]);
  return [x / ring.length, y / ring.length];
}

export const placeKey = (lat, lon) => `${Math.floor(lat * PLACE_PER_DEGREE)}_${Math.floor(lon * PLACE_PER_DEGREE)}`;

// OSM's amenity=weighbridge is any scale: quarries, landfills, grain elevators as well as the
// state's stations. In California 41 of 61 were private scales away from any highway. A
// weighbridge counts as a weigh station when its name says so, or, unnamed, when it sits within
// 300 m of a freeway or trunk road or their ramps; anything else is dropped. Checked against
// Caltrans' official station list: every station kept matched, and none dropped was on it.
const STATION_NAME = /weigh|inspection|port of entry|enforcement|\bchp\b|highway patrol|state patrol|\bdot\b/i;
export const STATION_NEAR_ROAD_M = 300;
export function roadGrid(lines) {
  const grid = new Map();
  for (const coords of lines) for (let i = 0; i < coords.length - 1; i++) {
    const key = `${Math.floor(coords[i][1] * 50)}_${Math.floor(coords[i][0] * 50)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push([coords[i], coords[i + 1]]);
  }
  return grid;
}
export function metresToRoad(grid, [lon, lat]) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 111_320;
  let best = Infinity;
  const r0 = Math.floor(lat * 50), c0 = Math.floor(lon * 50);
  for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++) for (const [a, b] of grid.get(`${r}_${c}`) ?? []) {
    const ax = (a[0] - lon) * kx, ay = (a[1] - lat) * ky, dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
export function isStateStation(place, grid) {
  return STATION_NAME.test(place.name) || (!place.name && metresToRoad(grid, [place.lon, place.lat]) <= STATION_NEAR_ROAD_M);
}

async function add(work, state, roadsFile) {
  const st = stateCode(state);
  // Freeways, trunk roads and their ramps for this state (build.sh), to tell stations from private scales.
  const grid = roadGrid(roadsFile && fs.existsSync(roadsFile) ? fs.readFileSync(roadsFile, 'utf8').split('\n')
    .filter((l) => l.trim()).map((l) => JSON.parse(l.replace(/^\x1e/, '')).geometry.coordinates) : []);
  let privateScales = 0;
  const raw = path.join(work, 'pois-raw');
  fs.mkdirSync(raw, { recursive: true });
  const buffered = new Map();
  let count = 0;
  for await (const text of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    const place = toPlace(JSON.parse(text.replace(/^\x1e/, '')));
    if (!place) continue;
    if (place.cat === 'weigh_station' && !isStateStation(place, grid)) { privateScales++; continue; }
    place.st = st;
    count++;
    const key = placeKey(place.lat, place.lon);
    if (!buffered.has(key)) buffered.set(key, []);
    buffered.get(key).push(JSON.stringify(place) + '\n');
  }
  for (const [key, lines] of buffered) fs.appendFileSync(path.join(raw, key), lines.join(''));
  console.log(`  ${count} places, ${privateScales} private scales left out`);
}

// Border tiles hold the same place from two state extracts: keep the first per OSM id.
export function uniquePlaces(lines) {
  const seen = new Set(), rows = [];
  for (const line of lines) {
    if (!line) continue;
    const place = JSON.parse(line);
    if (seen.has(place.id)) continue;
    seen.add(place.id);
    rows.push(place);
  }
  return rows;
}
export const packPlaces = (lines) => zlib.gzipSync(JSON.stringify(uniquePlaces(lines)), { level: 9 });

const metres = (a, b) => {
  const dLat = (b.lat - a.lat) * 111_320, dLon = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};
// Which OpenStreetMap pins an outside row may stand for, and how far apart the two can sit.
const MATCH = {
  truck_stop: { cats: ['truck_stop', 'fuel', 'parking'], within: 300 },
  scale: { cats: ['scale', 'weigh_station'], within: 250 },
  truck_wash: { cats: ['truck_wash'], within: 250 },
  fuel: { cats: ['fuel'], within: 150 },
  rest_area: { cats: ['rest_area', 'parking'], within: 600 },
  weigh_station: { cats: ['weigh_station'], within: 600 },
  parking: { cats: ['parking', 'rest_area'], within: 400 },
};

// The names one chain's sites go by in OpenStreetMap ("Pilot", "Flying J", "ONE9" are one company).
const CHAINS = [/pilot|flying j|one9/i, /love'?s/i, /\bta\b|petro|travelcenters/i];

// Brand and DOT rows (extras.mjs) onto the OpenStreetMap rows. A match keeps the OSM pin and its id
// and takes the outside row's name, address, road and amenities, because the chain's own site and
// the DOT survey are better at those than volunteer tags. An outside row with no OSM pin near it is
// added as it is. Any further OSM pin of the same site (each fuel island, the truck lot beside the
// store) is dropped so the map shows the site once.
export function mergeExtras(rows, extras) {
  const cell = (lat, lon) => `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`; // ~1 km
  const grid = new Map();
  for (const row of rows) {
    const k = cell(row.lat, row.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(row);
  }
  const near = (x, within, cats) => {
    const found = [];
    const r0 = Math.floor(x.lat * 100), c0 = Math.floor(x.lon * 100);
    for (let r = r0 - 1; r <= r0 + 1; r++) for (let c = c0 - 1; c <= c0 + 1; c++)
      for (const row of grid.get(`${r}_${c}`) ?? []) {
        const d = metres(x, row);
        if (!row.gone && d <= within && cats.includes(row.cat ?? row.kind)) found.push({ row, d });
      }
    return found.sort((a, b) => a.d - b.d);
  };
  // Added rows join the grid, so a later source cannot add the same place again.
  const push = (x) => {
    rows.push(x);
    const k = cell(x.lat, x.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(x);
  };
  let matched = 0, added = 0, dropped = 0;
  for (const x of extras) {
    const rule = MATCH[x.cat];
    const hits = rule ? near(x, rule.within, rule.cats).filter(({ row }) => !row.src) : [];
    // A gas brand fills in what the OSM station lacks (address, phone, hours) and keeps its name and
    // pin. One beside a truck stop is the truck stop's own pumps: never added as a second pin.
    // One site is often in two locators (a 7-Eleven selling Shell fuel), so any station within
    // 150 m, already filled in or not, is the same site.
    if (x.cat === 'fuel') {
      const same = near(x, 150, ['fuel']);
      if (same.length) {
        const row = same[0].row;
        row.addr ??= x.addr; row.phone ??= x.phone; row.hours ??= x.hours; row.name ||= x.name; row.src ??= 'osm+atp';
        matched++;
      } else if (!near(x, 150, ['truck_stop']).length) { push(x); added++; }
      continue;
    }
    if (!hits.length) { push(x); added++; continue; }
    const [{ row }, ...rest] = hits;
    Object.assign(row, { ...x, id: row.id, lat: row.lat, lon: row.lon,
      phone: x.phone ?? row.phone, hours: x.hours ?? row.hours, parking: x.parking ?? row.parking,
      showers: x.showers || row.showers, food: x.food || row.food, scales: x.scales || row.scales,
      diesel: x.diesel || row.diesel, fuel: x.fuel || row.fuel });
    matched++;
    // Only pins that are plainly the same business: unnamed, or carrying the chain's name. The
    // independent station across the road keeps its pin.
    const chain = CHAINS.find((re) => re.test(`${x.brand ?? ''} ${x.name}`));
    const word = x.name.toLowerCase().split(/[^a-z0-9']+/).find((w) => w.length > 2);
    // Rest areas come in pairs across the highway, so only truck stops collapse.
    if (x.cat === 'truck_stop') for (const { row: other } of rest) {
      const name = other.name.toLowerCase();
      if (other.cat === 'parking' && name !== 'truck parking') continue;
      if (!name || name === 'truck parking' || (chain ? chain.test(name) : word && name.includes(word))) { other.gone = true; dropped++; }
    }
  }
  console.log(`extras: ${matched} matched an OSM pin, ${added} added, ${dropped} duplicate pins dropped`);
  return rows.filter((row) => !row.gone);
}

// Ramps signposted to a weigh station ("Weigh Station", "Truck Scales"), from the destination tags
// OSM mappers copy off the exit signs. Many stations are signed but never mapped as a place (I-15
// at Rainbow, I-80 at Cordelia), so the sign is how we find them. The pin goes at the end of the
// signed ramp, where the scale lane begins.
// Only ramps and access roads, never a lane sign on the freeway itself: that way ends where the
// lane splits off, up to a kilometre before the station. "Inspection station" and "port of entry"
// are left out: they are as often an agricultural check or a border crossing as a scale.
const WEIGH_SIGN = /\bweigh\b|\btruck scales?\b|^scales?$/i;
const RAMP = /_link$|^service$/;
export function signRow(feature, st) {
  const p = feature.properties ?? {};
  if (!RAMP.test(p.highway ?? '')) return null;
  const signed = [p.destination, p['destination:lanes'], p['destination:street'], p.exit_to]
    .filter(Boolean).flatMap((v) => String(v).split(/[;|]/)).map((v) => v.trim());
  if (!signed.some((v) => WEIGH_SIGN.test(v))) return null;
  const c = feature.geometry?.coordinates;
  if (feature.geometry?.type !== 'LineString' || !c?.length) return null;
  const [lon, lat] = c[c.length - 1];
  return { id: `sign:${p['@id']}`, kind: 'weigh_station', cat: 'weigh_station', name: 'Weigh Station',
    lat: r5(lat), lon: r5(lon), fuel: 0, diesel: 0, showers: 0, food: 0, scales: 1, hours: null, phone: null,
    parking: null, road: p.ref ? String(p.ref).split(';')[0] : null, src: 'osm-sign', st };
}

async function signs(work, state) {
  const st = stateCode(state);
  const out = [];
  for await (const text of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!text.trim()) continue;
    const row = signRow(JSON.parse(text.replace(/^\x1e/, '')), st);
    if (row) out.push(JSON.stringify(row) + '\n');
  }
  fs.appendFileSync(path.join(work, 'signs.jsonl'), out.join(''));
  console.log(`  ${out.length} roads signed to a weigh station`);
}

/**
 * One pin per signed station that no mapped weigh station already covers. Signs within 1.5 km are
 * one station (a ramp and the lane before it); a mapped weigh station within 2.5 km means it is
 * already on the map. CAT Scales do not count: a truck stop's scale is not the state's station.
 * Returns the rows to add; these are also the gaps OSM mappers can fill.
 */
export function signedStations(rows, signRows) {
  const stations = rows.filter((r) => (r.cat ?? r.kind) === 'weigh_station');
  const added = [];
  for (const s of signRows) {
    if (added.some((a) => metres(a, s) < 1500) || stations.some((w) => metres(w, s) < 2500)) continue;
    added.push(s);
  }
  return added;
}

function finish(work) {
  const raw = path.join(work, 'pois-raw'), out = path.join(work, 'pois');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  let rows = uniquePlaces(fs.readdirSync(raw).flatMap((key) => fs.readFileSync(path.join(raw, key), 'utf8').split('\n')));
  const extrasFile = path.join(work, 'extras.jsonl');
  if (fs.existsSync(extrasFile)) rows = mergeExtras(rows, fs.readFileSync(extrasFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  // An unnamed scale at a truck stop is the truck stop's own scale, not the state's station.
  const stops = rows.filter((r) => r.cat === 'truck_stop');
  for (const r of rows) {
    if (r.cat === 'weigh_station' && !r.name && !r.src && stops.some((t) => metres(t, r) < 250)) r.cat = 'scale';
  }
  const signsFile = path.join(work, 'signs.jsonl');
  if (fs.existsSync(signsFile)) {
    const gaps = signedStations(rows, fs.readFileSync(signsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    rows.push(...gaps);
    console.log(`weigh stations found only by their exit signs: ${gaps.length}`);
    // For mapping them in OSM properly (by hand or a MapRoulette challenge); never uploaded to R2.
    fs.writeFileSync(path.join(work, 'weigh-station-gaps.geojson'), JSON.stringify({ type: 'FeatureCollection', features: gaps.map((g) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon, g.lat] },
      properties: { state: g.st, road: g.road, osm_way: g.id.replace('sign:', '').replace(/^w/, '') },
    })) }));
  }
  const byKey = new Map();
  for (const row of rows) {
    const key = placeKey(row.lat, row.lon);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }
  let tileCount = 0, bytes = 0;
  for (const [key, tileRows] of byKey) {
    const tile = zlib.gzipSync(JSON.stringify(tileRows), { level: 9 });
    fs.writeFileSync(path.join(out, `${key}.bin`), tile);
    tileCount++; bytes += tile.length;
  }
  fs.rmSync(raw, { recursive: true, force: true });
  if (!tileCount) throw new Error('no place tiles');
  const counts = {};
  for (const row of rows) counts[row.cat ?? row.kind] = (counts[row.cat ?? row.kind] ?? 0) + 1;
  console.log('places by pin:', JSON.stringify(counts));
  const builtAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const build = { buildId: builtAt.replace(/[-:]/g, ''), builtAt, tileCount, perDegree: PLACE_PER_DEGREE };
  fs.writeFileSync(path.join(work, 'pois.json'), JSON.stringify(build, null, 1) + '\n');
  console.log(`${tileCount} place tiles, ${(bytes / 1e6).toFixed(1)} MB`);
}

const [cmd, work, state] = process.argv[1]?.endsWith('pois.mjs') ? process.argv.slice(2) : [];
if (cmd === 'add') await add(work, state, process.argv[5]);
else if (cmd === 'signs') await signs(work, state);
else if (cmd === 'finish') finish(work);
else if (cmd) throw new Error('usage: node pois.mjs add|signs|finish <work dir>');
