// Weekly diesel and regular gasoline averages from the U.S. Energy Information Administration,
// shown on the Find Stops sheets (services/fuelPrices.ts). The fuel job runs it every Tuesday:
//   node fuel.mjs <work>      writes <work>/fuel.json, then `KIND=fuel node publish.mjs` serves it
// EIA_API_KEY is optional; EIA's public DEMO_KEY covers one request a week.
//
// EIA publishes by PADD region (and California on its own), not per station: a regional
// average, labelled as one in the app.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// PADD (sub-)region per state, as EIA defines them. Every state + DC must be here.
export const STATE_AREA = {
  CT: 'R1X', ME: 'R1X', MA: 'R1X', NH: 'R1X', RI: 'R1X', VT: 'R1X',
  DE: 'R1Y', DC: 'R1Y', MD: 'R1Y', NJ: 'R1Y', NY: 'R1Y', PA: 'R1Y',
  FL: 'R1Z', GA: 'R1Z', NC: 'R1Z', SC: 'R1Z', VA: 'R1Z', WV: 'R1Z',
  IL: 'R20', IN: 'R20', IA: 'R20', KS: 'R20', KY: 'R20', MI: 'R20', MN: 'R20', MO: 'R20',
  NE: 'R20', ND: 'R20', SD: 'R20', OH: 'R20', OK: 'R20', TN: 'R20', WI: 'R20',
  AL: 'R30', AR: 'R30', LA: 'R30', MS: 'R30', NM: 'R30', TX: 'R30',
  CO: 'R40', ID: 'R40', MT: 'R40', UT: 'R40', WY: 'R40',
  AK: 'R5XCA', AZ: 'R5XCA', HI: 'R5XCA', NV: 'R5XCA', OR: 'R5XCA', WA: 'R5XCA',
  CA: 'SCA',
};
const AREAS = [...new Set(Object.values(STATE_AREA))];
const PRODUCTS = { EPD2D: 'diesel', EPMR: 'regular' };

// EIA rows → { weekOf, areas: { R20: { diesel, regular } }, states }. Uses the newest week, and
// throws unless every area has both prices for it, so a half-published week never goes live.
export function packFuel(rows) {
  const weekOf = rows.reduce((max, r) => (r.period > max ? r.period : max), '');
  const areas = {};
  for (const r of rows) {
    if (r.period !== weekOf || !AREAS.includes(r.duoarea) || !PRODUCTS[r.product]) continue;
    const value = Number(r.value);
    if (!(value > 0)) continue;
    (areas[r.duoarea] ??= {})[PRODUCTS[r.product]] = value;
  }
  const missing = AREAS.flatMap((a) => Object.values(PRODUCTS).filter((p) => !areas[a]?.[p]).map((p) => `${a} ${p}`));
  if (!weekOf || missing.length) throw new Error(`EIA week ${weekOf || 'none'} is missing: ${missing.join(', ')}`);
  return { weekOf, areas, states: STATE_AREA };
}

async function main(work) {
  const q = new URLSearchParams({ api_key: process.env.EIA_API_KEY || 'DEMO_KEY', frequency: 'weekly', 'data[0]': 'value',
    'sort[0][column]': 'period', 'sort[0][direction]': 'desc', length: '200' });
  for (const p of Object.keys(PRODUCTS)) q.append('facets[product][]', p);
  for (const a of AREAS) q.append('facets[duoarea][]', a);
  const res = await fetch(`https://api.eia.gov/v2/petroleum/pri/gnd/data/?${q}`);
  if (!res.ok) throw new Error(`EIA ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const fuel = packFuel((await res.json()).response?.data ?? []);
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'fuel.json'), JSON.stringify(fuel) + '\n');
  console.log(`fuel prices for the week of ${fuel.weekOf}: ${AREAS.length} areas`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2] ?? '.build');
