// Places OpenStreetMap is thin on, from two open sources, merged into the place tiles by
// pois.mjs finish (mergeExtras). build.sh runs it before the finish step:
//   node extras.mjs <work>     writes <work>/extras.jsonl, one place row per line
//
// - All The Places (alltheplaces.xyz, CC0): each chain's own store locator, scraped weekly.
//   Truck-stop chains, CAT Scales and Blue Beacon truck washes. Walmart is left out on purpose:
//   the owner removed it in 2026-07 because an oversize load does not overnight in a retail lot.
// - US DOT NTAD Truck Stop Parking (public domain): every public rest area, welcome centre,
//   service plaza and weigh station with truck parking, with its route, milepost and spaces.
//
// A source that returns far fewer rows than it normally holds fails the build, so a broken
// scraper cannot quietly delete a chain from the map; last week's tiles stay live.
import fs from 'node:fs';
import path from 'node:path';
import { hoursOf } from './pois.mjs';

const UA = { 'user-agent': 'RouteAll places build (admin@routeall.app)' };
const ATP_LATEST = 'https://data.alltheplaces.xyz/runs/latest.json';
const NTAD = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/NTAD_Truck_Stop_Parking/FeatureServer/0/query';
// Spider → the pin it becomes, and the least it must return (about 70% of the October 2026 run).
export const SPIDERS = {
  pilot_flying_j: { cat: 'truck_stop', floor: 500 },
  loves_us: { cat: 'truck_stop', floor: 500 },
  travelcenters_of_america_us: { cat: 'truck_stop', floor: 250 },
  roadys_us: { cat: 'truck_stop', floor: 180 },
  road_ranger_us: { cat: 'truck_stop', floor: 40 },
  cat_scale_ca_us: { cat: 'scale', floor: 1600 },
  blue_beacon_us: { cat: 'truck_wash', floor: 80 },
  // Gas brands: their own locators give the street address, phone and often hours that OSM lacks
  // on most stations (31% of California's had an address). Floors are about 60% of October 2026.
  bp: { cat: 'fuel', floor: 5000 },
  caseys_general_store_us: { cat: 'fuel', floor: 1100 },
  cenex: { cat: 'fuel', floor: 900 },
  chevron_us: { cat: 'fuel', floor: 5300 },
  circle_k: { cat: 'fuel', floor: 2600 },
  gulf_pr_us: { cat: 'fuel', floor: 530 },
  irving_oil: { cat: 'fuel', floor: 220 },
  kroger_us: { cat: 'fuel', floor: 970 },
  kwik_trip: { cat: 'fuel', floor: 550 },
  marathon_petroleum_us: { cat: 'fuel', floor: 4600 }, // includes ARCO
  maverik: { cat: 'fuel', floor: 500 },
  murphy_usa_us: { cat: 'fuel', floor: 1000 },
  phillips_66_conoco_76: { cat: 'fuel', floor: 3600 },
  quiktrip_us: { cat: 'fuel', floor: 670 },
  sams_club: { cat: 'fuel', floor: 320 },
  seven_eleven_ca_us: { cat: 'fuel', floor: 3400 },
  sheetz: { cat: 'fuel', floor: 520 },
  shell: { cat: 'fuel', floor: 7400 },
  sinclair_us: { cat: 'fuel', floor: 1100 },
  speedway_us: { cat: 'fuel', floor: 1650 },
  stewarts_shops_us: { cat: 'fuel', floor: 430 },
  sunoco_us: { cat: 'fuel', floor: 3250 },
  thorntons_us: { cat: 'fuel', floor: 130 },
  valero: { cat: 'fuel', floor: 2550 },
};
// A gas brand's locator also lists stores without pumps (7-Eleven, Kroger); only fuel sites count.
const sellsFuel = (p) => p.amenity === 'fuel' || Object.keys(p).some((k) => k.startsWith('fuel:'));
const NTAD_FLOOR = 1500;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const KIND = { fuel: 'fuel', truck_stop: 'truck_stop', parking: 'truck_stop', scale: 'weigh_station', weigh_station: 'weigh_station', rest_area: 'rest_area', truck_wash: 'truck_wash' };

const yes = (v) => v === 'yes' || v === 'designated';
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const row = (fields) => ({
  fuel: 0, diesel: 0, showers: 0, food: 0, scales: 0, hours: null, phone: null, parking: null,
  addr: null, road: null, ...fields, kind: KIND[fields.cat],
});

/** One All The Places feature (OSM-style tags) → a place row, or null when it is not a US site. */
export function fromAtp(spider, feature) {
  const p = feature.properties ?? {};
  const [lon, lat] = feature.geometry?.coordinates ?? [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if ((p['addr:country'] ?? 'US') !== 'US' || !US_STATES.has(String(p['addr:state'] ?? '').toUpperCase())) return null;
  if (/coming soon/i.test(`${p.branch ?? ''} ${p.name ?? ''}`)) return null;
  // Kwik Trip sites with showers are truck stops (truck-stop audit, 2026-10-24); the rest stay gas stations.
  const cat = spider === 'kwik_trip' && (yes(p.shower) || yes(p.showers)) ? 'truck_stop' : SPIDERS[spider].cat;
  if (cat === 'fuel' && !sellsFuel(p)) return null;
  const street = p['addr:street_address'] ?? p['addr:full'] ?? null;
  const city = p['addr:city'];
  return row({
    id: `atp:${spider}:${p.ref ?? `${r5(lat)},${r5(lon)}`}`, src: 'atp', cat, brand: p.brand ?? null,
    // A gas station goes by its brand ("Chevron"), not the franchise company in the locator.
    name: (cat === 'fuel' ? p.brand || p.name : p.name || p.brand) || '', lat: r5(lat), lon: r5(lon), st: p['addr:state'].toUpperCase(),
    addr: street ? [street, city].filter(Boolean).join(', ') : null,
    phone: p.phone || null, hours: hoursOf(p.opening_hours),
    fuel: cat === 'truck_stop' ? 1 : 0,
    diesel: cat === 'truck_stop' || yes(p['fuel:diesel']) || yes(p['fuel:HGV_diesel']) ? 1 : 0,
    showers: yes(p.shower) || yes(p.showers) ? 1 : 0,
    food: cat === 'truck_stop' ? 1 : 0,
    scales: cat === 'scale' ? 1 : 0,
    parking: Number.parseInt(p['capacity:hgv'] ?? '', 10) || null,
  });
}

/** One NTAD Truck Stop Parking record → a place row. The survey names say what each site is. */
export function fromNtad(a) {
  const name = String(a.nhs_rest_stop ?? '').replace(/\s+/g, ' ').trim();
  const cat = /weigh|scale|inspection|port of entry/i.test(name) ? 'weigh_station'
    : /plaza|travel cent|truck stop/i.test(name) ? 'truck_stop'
    : /rest|welcome|information|visitor|tourist/i.test(name) ? 'rest_area' : 'parking';
  const mp = Number.parseFloat(a.mile_post);
  return row({
    id: `ntad:${a.OBJECTID}`, src: 'ntad', cat, name: name || 'Truck Parking', lat: r5(a.latitude), lon: r5(a.longitude),
    st: a.state, parking: Number.isFinite(a.number_of_spots) && a.number_of_spots > 0 ? a.number_of_spots : null,
    road: [a.highway_route?.trim(), Number.isFinite(mp) ? `MP ${mp.toFixed(1).replace(/\.0$/, '')}` : null].filter(Boolean).join(' · ') || null,
  });
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
}

// One broken spider in a run (Pilot Flying J's file was empty in the 2026-10-17 run) must not stop the build or
// drop the chain: each spider takes the newest of the last few runs that has it above its floor.
const ATP_HISTORY = 'https://data.alltheplaces.xyz/runs/history.json';
const ATP_RUNS_BACK = 4;

async function atp() {
  const latest = await getJson(ATP_LATEST);
  const history = await getJson(ATP_HISTORY).catch(() => []);
  const runs = [latest, ...history.filter((r) => r.output_url && r.run_id !== latest.run_id).reverse()].slice(0, ATP_RUNS_BACK);
  const rows = [], used = {};
  for (const spider of Object.keys(SPIDERS)) {
    let got = null;
    for (const run of runs) {
      const base = run.output_url.replace(/\/output\.zip$/, '');
      const json = await getJson(`${base}/output/${spider}.geojson`).catch(() => null);
      const these = (json?.features ?? []).map((f) => fromAtp(spider, f)).filter(Boolean);
      if (these.length >= SPIDERS[spider].floor) { got = these; used[spider] = run.run_id; break; }
      console.log(`  ${spider}: ${these.length} in run ${run.run_id}, trying an earlier run`);
    }
    if (!got) throw new Error(`${spider}: under ${SPIDERS[spider].floor} places in each of the last ${runs.length} runs`);
    console.log(`  ${spider}: ${got.length}${used[spider] === latest.run_id ? '' : ` (run ${used[spider]})`}`);
    rows.push(...got);
  }
  return { rows, run: latest.run_id, runs: used };
}

async function ntad() {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson(`${NTAD}?where=1%3D1&outFields=*&orderByFields=OBJECTID&resultOffset=${offset}&resultRecordCount=1000&f=json`);
    const features = page.features ?? [];
    rows.push(...features.map((f) => f.attributes).filter((a) => Number.isFinite(a.latitude) && Number.isFinite(a.longitude)).map(fromNtad));
    if (features.length < 1000 && !page.exceededTransferLimit) break;
  }
  console.log(`  ntad: ${rows.length}`);
  if (rows.length < NTAD_FLOOR) throw new Error(`NTAD returned ${rows.length}, expected at least ${NTAD_FLOOR}`);
  return rows;
}

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) {
  const work = process.argv[2];
  if (!work) throw new Error('usage: node extras.mjs <work dir>');
  console.log('== extras');
  const [a, n] = [await atp(), await ntad()];
  fs.writeFileSync(path.join(work, 'extras.jsonl'), [...a.rows, ...n].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.appendFileSync(path.join(work, 'sources.txt'), `alltheplaces ${a.run}\nntad-truck-stop-parking ${new Date().toISOString().slice(0, 10)}\n`);
}
