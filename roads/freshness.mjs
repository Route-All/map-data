// Independent freshness alert for the public data. Run it from a private cron, NOT from the
// publisher: it has to notice when the publisher itself has stopped.
//   node freshness.mjs [origin]     origin defaults to https://tiles.routeall.app; a folder works too
// Prints one ALERT line per problem and exits 1, or prints "ok" and exits 0. It alerts when:
// - the events manifest was built over 3 h ago (the hourly publisher has stopped);
// - a road-work feed's last successful check (lastValidatedAt) is over 24 h old, or it never had one;
// - a feed's snapshot row count fell more than 50% from the previous manifest (from 20 rows up);
// - a feed is skipped for any reason but "outside the US", or an active keyless feed in the manifest's registry
//   copy is in neither `feeds` nor `skipped` (a US feed lost, events.mjs usOnly);
// - the road build is 35 days old, or fuel prices are over 15 days old.
// Reads only public files, so it needs no credentials.
import fs from 'node:fs';
import path from 'node:path';

const HOUR = 3_600_000;
const origin = process.argv[2] ?? 'https://tiles.routeall.app';
const get = async (key) => {
  if (!/^https?:/.test(origin)) return JSON.parse(fs.readFileSync(path.join(origin, key), 'utf8'));
  // The query string skips the edge cache on the moving pointers; manifests never change.
  const res = await fetch(`${origin}/${key}${key.endsWith('current.json') ? `?t=${Date.now()}` : ''}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
  return res.json();
};
const now = Date.now();
const age = (at) => (now - Date.parse(at)) / HOUR;
const alerts = [];
const check = async (label, fn) => { try { await fn(); } catch (e) { alerts.push(`${label}: ${e.message}`); } };

await check('events', async () => {
  const pointer = await get('events/v2/current.json').catch(() => null);
  if (!pointer) { // before the v2 publisher's first run: the v1 index's age only
    const v1 = await get('events/current.json');
    if (age(v1.builtAt) > 3) alerts.push(`events: v1 index last published ${age(v1.builtAt).toFixed(1)} h ago (${v1.builtAt}); no v2 yet`);
    return;
  }
  const manifest = await get(pointer.manifest);
  if (age(manifest.builtAt) > 3) alerts.push(`events: last published ${age(manifest.builtAt).toFixed(1)} h ago (${manifest.builtAt})`);
  const previous = pointer.previous ? await get(pointer.previous).catch(() => null) : null;
  for (const [id, f] of Object.entries(manifest.feeds).sort()) {
    // A source that has never answered (NM 503, NY's HTML page) carries no data to go stale: skipped, noted,
    // not failed (owner, 2026-10-31). One that answered before and stopped is still an alert.
    if (!f.lastValidatedAt) console.log(`SKIP events/${id}: has never answered (${f.error ?? f.status})`);
    else if (age(f.lastValidatedAt) > 24) alerts.push(`events/${id}: last checked ${age(f.lastValidatedAt).toFixed(1)} h ago (${f.error ?? f.status})`);
    const before = previous?.feeds?.[id]?.total;
    if (before >= 20 && (f.total ?? 0) < before / 2) alerts.push(`events/${id}: ${f.total ?? 0} rows, down from ${before}`);
  }
  // A feed may stay out of `feeds` only as a non-US skip (events.mjs usOnly). Checked against the registry copy this
  // manifest was built from, not the previous manifest (that moves hourly, this check runs every 3 h): every active
  // keyless feed in it must be fetched or skipped. A deactivated feed is not expected; a keyed one is fetched only
  // when its key is set, which public files do not show.
  for (const [id, s] of Object.entries(manifest.skipped ?? {}).sort()) {
    if (s.reason !== 'outside the US') alerts.push(`events/${id}: skipped (${s.reason})`);
  }
  const registry = manifest.registry?.objectKey ? await get(manifest.registry.objectKey) : [];
  for (const r of registry) {
    const url = r.url?.url ?? r.url;
    if (String(r.active) !== 'true' || String(r.needapikey) === 'true' || !/^https:\/\//.test(url ?? '')) continue;
    if (!manifest.feeds[r.feedname] && !manifest.skipped?.[r.feedname]) alerts.push(`events/${r.feedname}: active in the registry, neither fetched nor skipped`);
  }
});
await check('roads', async () => {
  const build = await get('roads/current.json');
  if (!(age(build.builtAt) < 35 * 24)) alerts.push(`roads: build ${build.buildId} is ${(age(build.builtAt) / 24).toFixed(1)} days old`);
});
await check('fuel', async () => {
  const fuel = await get('fuel/current.json');
  if (!(age(fuel.weekOf) < 15 * 24)) alerts.push(`fuel: prices are for the week of ${fuel.weekOf}`);
});

for (const line of alerts) console.log(`ALERT ${line}`);
if (!alerts.length) console.log('ok');
process.exitCode = alerts.length ? 1 : 0;
