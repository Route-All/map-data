// Has Geofabrik published a newer extract than the live road build? The daily Roads job asks
// first and builds only when one has, so a new extract goes live within a day.
//   node source-check.mjs [--force]     prints newer=true|false (for $GITHUB_OUTPUT); reasons go to stderr
// Compares each state's replication time on Geofabrik (<state>-updates/state.txt) with the time the
// live build recorded for it (roads/current.json sourceDates, from the same header).
const ORIGIN = 'https://tiles.routeall.app';
const GEOFABRIK = 'https://download.geofabrik.de/north-america/us';

const say = (newer, why) => { console.error(why); console.log(`newer=${newer}`); };
const live = await fetch(`${ORIGIN}/roads/current.json?t=${Date.now()}`).then((r) => (r.ok ? r.json() : null));
if (process.argv.includes('--force')) say(true, 'forced');
else if (!live?.sourceDates) say(true, 'no live build with source dates');
else {
  // Geofabrik's server sometimes stalls a request: 20 s each, three tries, then the job fails.
  const stateTxt = async (state) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(`${GEOFABRIK}/${state}-updates/state.txt`, { headers: { 'user-agent': 'RouteAll roads build' }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (e) {
        if (attempt === 3) throw new Error(`${state}: Geofabrik state.txt ${e.message}`);
      }
    }
  };
  let newer = null;
  // One newer state is enough: the build downloads every state's latest extract anyway.
  for (const [state, built] of Object.entries(live.sourceDates)) {
    const at = (await stateTxt(state)).match(/^timestamp=(.+)$/m)?.[1].replaceAll('\\:', ':');
    if (!Date.parse(at)) throw new Error(`${state}: no timestamp in state.txt`);
    if (Date.parse(at) > Date.parse(built)) { newer = `${state}: built from ${built}, Geofabrik has ${at}`; break; }
  }
  say(Boolean(newer), newer ?? `live build ${live.buildId} is current with Geofabrik`);
}
