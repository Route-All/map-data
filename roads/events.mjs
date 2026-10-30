// Live road work and closures for the map, from public DOT feeds. The Road Work workflow runs it
// on a schedule (hourly at :17 from the public data repo); every run, manual or scheduled, goes
// through this one entry and the dataset's lock (store.mjs):
//   node events.mjs <dir>     the same files, into a folder for testing
//   R2_S3_ENDPOINT=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node events.mjs     R2 (production)
//   ROLLBACK=1 …              allows publishing over a newer manifest
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node events.mjs     LEGACY: the old app workflow's
//                             REST path, with no lock and no clean-up, until the public repo takes over
//
// Sources, all free and keyless (docs/operations/ROADS.md lists them and the keyed ones to add):
// - Every active WZDx feed in USDOT's registry that needs no key (about 22 states). WZDx is the
//   national work-zone standard, so one parser reads them all.
// - Caltrans' Lane Closure System for California's 12 districts, in Caltrans' own format.
//
// Each run, per feed: fetch (ETag / Last-Modified, or the same bytes, mean unchanged), and keep the
// feed's FULL normalized snapshot (every event, future ones too) as an immutable object. An
// unchanged feed reloads its snapshot and a failed one keeps its previous snapshot and its old
// validation time; a feed with no snapshot yet is Unavailable, never an empty healthy feed. Then
// the display window (under way, or starting within AHEAD_MS) is applied to every snapshot EVERY
// run, so planned work appears on time even when the feed's bytes never change.
//
// Output (v2): events/v2/objects/<sha256>.json (snapshots and 0.5° tiles; a hash path never
// changes bytes), then events/v2/manifests/<time>-<hash>.json (coverage per feed and tile), and
// events/v2/current.json LAST. Mark-and-sweep clean-up runs in the same lock (collectGarbage).
// v1 (events/current.json + events/t/<row>_<col>.json, read by older app versions) is written from
// the same rows after v2. v1 still overwrites stable paths, so an old index can meet a newer tile.

import { sha256, pool } from './store.mjs';

const REGISTRY = 'https://data.transportation.gov/resource/69qe-yiui.json?$limit=500';
const CALTRANS = Array.from({ length: 12 }, (_, i) =>
  `https://cwwp2.dot.ca.gov/data/d${i + 1}/lcs/lcsStatusD${String(i + 1).padStart(2, '0')}.json`);
// Statewide WZDx feeds that work without a key but are missing from USDOT's registry (found
// 2026-10-21 on the states' 511 sites). Arizona's registry entry is only Maricopa County.
const EXTRA_WZDX = [
  { feedname: 'az511', issuingorganization: 'Arizona DOT', url: 'https://az511.com/api/wzdx', active: 'true', needapikey: 'false' },
  { feedname: 'nvroads', issuingorganization: 'Nevada DOT', url: 'https://www.nvroads.com/api/wzdx', active: 'true', needapikey: 'false' },
];
export const PER_DEGREE = 2;
const HOUR = 3_600_000;
// Planned work that has not started yet is shown this far ahead, so a driver planning tonight's
// run sees the overnight closure.
const AHEAD_MS = 24 * HOUR;
const MAX_POINTS = 40;

const r5 = (x) => Math.round(x * 1e5) / 1e5;
// Long descriptions end on a whole word with an ellipsis, never mid-word.
const clip = (text, max = 280) => (!text ? null : text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, '')}…`);
const time = (s) => { const t = Date.parse(s ?? ''); return Number.isFinite(t) ? t : null; };

/** Points of any WZDx geometry, thinned to at most MAX_POINTS for the map's line. */
export function linePoints(geometry) {
  const g = geometry ?? {};
  const pts = g.type === 'Point' ? [g.coordinates]
    : g.type === 'LineString' || g.type === 'MultiPoint' ? g.coordinates
    : g.type === 'MultiLineString' ? g.coordinates.flat() : [];
  const ok = pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
    && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
  if (ok.length <= MAX_POINTS) return ok.map(([x, y]) => [r5(x), r5(y)]);
  const step = (ok.length - 1) / (MAX_POINTS - 1);
  return Array.from({ length: MAX_POINTS }, (_, i) => ok[Math.round(i * step)]).map(([x, y]) => [r5(x), r5(y)]);
}

// What the work does to traffic, as WZDx's own vehicle_impact codes (the app words them). Caltrans
// closures are mapped onto the same codes, plus ramp-closed.
const IMPACTS = new Set(['all-lanes-closed', 'some-lanes-closed', 'some-lanes-closed-merge-left', 'some-lanes-closed-merge-right',
  'some-lanes-closed-split', 'alternating-one-way', 'flagging', 'temporary-traffic-signal', 'all-lanes-open']);
const impactCode = (v) => (IMPACTS.has(v) ? (v.startsWith('some-lanes-closed') ? 'some-lanes-closed' : v) : null);

/**
 * Shown now: not over, and under way or starting within AHEAD_MS. A Caltrans closure the crew has
 * set up (`placed`) is shown whatever its planned start. Applied to the stored snapshots every run.
 */
export const inWindow = (r, now) => (r.to === null || r.to >= now) && (r.placed || r.from === null || r.from <= now + AHEAD_MS);

/**
 * One WZDx v4 feature → an event row, whatever its dates (inWindow decides when it shows), or null
 * when it is finished, cancelled or a detour (the road it avoids is already shown). Work with every
 * lane open is kept: shoulder work and narrowed lanes still matter to an oversize load, and some
 * states (New Jersey) mark every zone so.
 */
export function normalizeWzdx(feature, source) {
  const p = feature?.properties ?? {};
  const core = p.core_details ?? p;
  if (core.event_type && core.event_type !== 'work-zone') return null;
  if (['completed', 'cancelled'].includes(p.event_status)) return null;
  const from = time(p.start_date), to = time(p.end_date);
  const line = linePoints(feature.geometry);
  if (!line.length) return null;
  const road = (core.road_names ?? []).filter(Boolean).join(' / ') || null;
  return {
    id: `${source.id}:${feature.id ?? p.id ?? `${line[0]}`}`,
    type: p.vehicle_impact === 'all-lanes-closed' ? 'closure' : 'work_zone',
    road, dir: core.direction && core.direction !== 'unknown' ? core.direction : null,
    desc: clip(String(core.description ?? '').trim()),
    impact: impactCode(p.vehicle_impact), lanes: null,
    from, to, src: source.name, lon: line[0][0], lat: line[0][1], line: line.length > 1 ? line : null,
    // When the state last changed this event, and where it is in words, for the detail sheet.
    upd: time(core.update_date ?? p.update_date), place: null,
  };
}

/**
 * One Caltrans LCS record → an event row. 1097 means the crew has set the closure up, 1098 that
 * it has been picked up, 1022 that it was cancelled; a closure not yet set up is shown only when
 * it is due within the day (inWindow), and one with no start at all never is.
 */
export function normalizeCaltrans(record) {
  const l = record?.lcs;
  if (!l) return null;
  const c = l.closure ?? {};
  if (c.code1098?.isCode1098 === 'true' || c.code1022?.isCode1022 === 'true') return null;
  const ts = c.closureTimestamp ?? {};
  const from = Number(ts.closureStartEpoch) * 1000 || null;
  const to = ts.isClosureEndIndefinite === 'true' ? null : Number(ts.closureEndEpoch) * 1000 || null;
  const placed = c.code1097?.isCode1097 === 'true';
  if (!placed && from === null) return null;
  const b = l.location?.begin ?? {}, e = l.location?.end ?? {};
  const a = [Number(b.beginLongitude), Number(b.beginLatitude)], z = [Number(e.endLongitude), Number(e.endLatitude)];
  if (!a.every(Number.isFinite) || Math.abs(a[0]) > 180 || !a[0]) return null;
  const line = z.every(Number.isFinite) && z[0] && (z[0] !== a[0] || z[1] !== a[1]) ? [a, z].map(([x, y]) => [r5(x), r5(y)]) : null;
  const full = c.typeOfClosure === 'Full';
  const ramp = c.facility && c.facility !== 'Mainline';
  // "2 of 3": how many lanes are shut. Left out for a full closure, which says it all.
  const lanes = !full && /^\d+$/.test(c.lanesClosed ?? '') && /^\d+$/.test(c.totalExistingLanes ?? '') ? `${c.lanesClosed}/${c.totalExistingLanes}` : null;
  const where = [b.beginLocationName, ramp ? c.facility : null].filter(Boolean).join(' · ');
  return {
    id: `caltrans:${l.index}`, type: full ? 'closure' : 'work_zone',
    road: b.beginRoute || null, dir: l.location?.travelFlowDirection?.toLowerCase() || null,
    desc: [c.typeOfWork, where].filter(Boolean).join(' — ') || null,
    impact: full ? (ramp ? 'ramp-closed' : 'all-lanes-closed') : 'some-lanes-closed', lanes,
    from, to, src: 'Caltrans', lon: r5(a[0]), lat: r5(a[1]), line,
    upd: Number(l.recordTimestamp?.recordEpoch) * 1000 || null,
    place: [b.beginNearbyPlace, b.beginCounty ? `${b.beginCounty} County` : null].filter(Boolean).join(', ') || null,
    // Kept in the snapshot for inWindow, dropped from published rows (publicRow).
    ...(placed && { placed: true }),
  };
}

const publicRow = ({ placed, ...row }) => row;

export const tileKey = (lat, lon) => `${Math.floor(lat * PER_DEGREE)}_${Math.floor(lon * PER_DEGREE)}`;

/**
 * A feed's body, or `unchanged` on a 304 or the same bytes as `seen.hash` (the SHA-256 of the
 * body as sent). `stamp` holds the validators for next run and the source's Last-Modified.
 */
async function getBody(url, fetchImpl, seen = null, extraHeaders = {}) {
  const headers = { 'user-agent': 'RouteAll road events (admin@routeall.app)', accept: 'application/json', ...extraHeaders };
  if (seen?.etag) headers['if-none-match'] = seen.etag;
  if (seen?.modified) headers['if-modified-since'] = seen.modified;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(25_000) });
  if (res.status === 304) return { unchanged: true, stamp: seen };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  const stamp = { etag: res.headers.get('etag'), modified: res.headers.get('last-modified'), hash: sha256(bytes) };
  if (seen?.hash && seen.hash === stamp.hash) return { unchanged: true, stamp };
  // Florida's feed is gzip without a Content-Encoding header.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  return { json: JSON.parse(new TextDecoder().decode(bytes)), stamp };
}

// Feeds that take their key in a header instead of the URL (from each agency's developer docs).
const KEY_HEADER = {
  ordot: (key) => ({ 'Ocp-Apim-Subscription-Key': key }),
  massdot__cwz: (key) => ({ authorization: `Bearer ${key}` }),
  mdot_4: (key) => ({ api_key: key }),
};
// The registry writes a keyed feed's URL with a placeholder where the key goes, or ends it with "=".
const KEY_PLACEHOLDER = /INSERT[-_]API[-_]KEY(?:[-_]HERE)?|\[[^\]]*key[^\]]*\]|YOUR-[A-Z-]*API-KEY|%3ckey%3e|<key>/i;

/**
 * The registry's active WZDx feeds: every keyless one, plus each keyed one whose key is in `keys`
 * (the WZDX_KEYS secret, feed name → key), with the key put where that feed expects it.
 */
export function wzdxSources(registry, keys = {}) {
  return registry.filter((r) => String(r.active) === 'true').flatMap((r) => {
    let url = r.url?.url ?? r.url;
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return [];
    if (String(r.needapikey) !== 'true') return [{ id: r.feedname, name: r.issuingorganization, url }];
    const key = keys[r.feedname];
    if (!key) return [];
    if (KEY_HEADER[r.feedname]) return [{ id: r.feedname, name: r.issuingorganization, url, headers: KEY_HEADER[r.feedname](key) }];
    if (KEY_PLACEHOLDER.test(url)) url = url.replace(KEY_PLACEHOLDER, encodeURIComponent(key));
    else if (/=$/.test(url)) url += encodeURIComponent(key);
    else return [];
    return [{ id: r.feedname, name: r.issuingorganization, url }];
  });
}

const V2 = 'events/v2';
const OBJECTS = `${V2}/objects/`;
const OBJECT_CACHE = 'public, max-age=31536000, immutable'; // a hash path never changes bytes
const POINTER_CACHE = 'public, max-age=60';
// Retention (spec section 5): every manifest for 35 days, and always the current and previous one.
const RETAIN_MS = 35 * 24 * HOUR;
// Clean-up re-reads every retained manifest (about 840 at hourly runs), so it runs once a day.
const GC_EVERY_MS = 23 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** [west, south, east, north] around rows, or null. Where a feed reports, for tile coverage. */
function bboxOf(rows) {
  if (!rows.length) return null;
  let w = 180, s = 90, e = -180, n = -90;
  for (const r of rows) for (const [x, y] of [[r.lon, r.lat], ...(r.line ?? [])]) {
    w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y);
  }
  return [w, s, e, n];
}

/** Writes text as events/v2/objects/<sha256>.json unless it is already there; returns the key. */
async function putObject(store, text, known) {
  const key = `${OBJECTS}${sha256(text)}.json`;
  // A key the previous manifest lists still exists (clean-up keeps it), so it is not sent again.
  if (!known.has(key)) await store.put(key, text, { cache: OBJECT_CACHE, ifNoneMatch: '*' });
  return key;
}

/**
 * One feed this run → { state, rows }. `rows` is its full normalized snapshot: parsed now when
 * the bytes changed, reloaded when they did not, and last run's when the fetch failed (keeping the
 * old validation time). No snapshot at all → Unavailable with no rows.
 */
async function refreshFeed(source, prev, { store, known, now, fetchImpl }) {
  const attempt = { name: source.name, lastAttemptAt: iso(now) };
  const snapshot = async (key) => {
    const rows = key && (await store.getJson(key));
    if (!Array.isArray(rows)) throw new Error(`snapshot ${key ?? '(none)'} is missing`);
    return rows;
  };
  try {
    const seen = prev?.normalizedObjectKey ? { ...prev.validators, hash: prev.sourceBodyHash } : null;
    const body = await getBody(source.url, fetchImpl, seen, source.headers);
    if (body.unchanged) {
      // A 304 or the same bytes: confirmed again (lastValidatedAt moves), published time does not.
      const rows = await snapshot(prev.normalizedObjectKey);
      const { error, ...kept } = prev;
      return { rows, state: { ...kept, ...attempt, status: 'fresh', coverage: 'complete', lastValidatedAt: iso(now),
        validators: { etag: body.stamp?.etag ?? prev.validators?.etag ?? null, modified: body.stamp?.modified ?? prev.validators?.modified ?? null } } };
    }
    const rows = source.parse(body.json).filter(Boolean).map((r) => ({ ...r, feed: source.id })).sort(byId);
    const info = body.json.feed_info ?? body.json.road_event_feed_info;
    const published = time(info?.update_date) ?? time(body.stamp.modified);
    return { rows, state: { ...attempt, status: 'fresh', coverage: 'complete', lastValidatedAt: iso(now),
      sourcePublishedAt: published === null ? null : iso(published), sourceBodyHash: body.stamp.hash,
      normalizedObjectKey: await putObject(store, JSON.stringify(rows), known),
      validators: { etag: body.stamp.etag, modified: body.stamp.modified }, total: rows.length, bbox: bboxOf(rows) } };
  } catch (e) {
    const error = String(e.message ?? e).slice(0, 120);
    try {
      return { rows: await snapshot(prev?.normalizedObjectKey), state: { ...prev, ...attempt, status: 'retained', coverage: 'partial', error } };
    } catch {
      // The area it last reported in is kept, so its tiles still read as unchecked, not empty.
      return { rows: [], state: { ...attempt, status: 'unavailable', coverage: 'unavailable', error,
        lastValidatedAt: prev?.lastValidatedAt ?? null, bbox: prev?.bbox ?? null } };
    }
  }
}

/** USDOT's feed registry, kept as an object like a feed snapshot; the last good one if it fails. */
async function loadRegistry(prev, { store, known, now, fetchImpl }) {
  const attempt = { lastAttemptAt: iso(now) };
  try {
    const rows = (await getBody(REGISTRY, fetchImpl)).json
      .map(({ feedname, issuingorganization, url, active, needapikey }) => ({ feedname, issuingorganization, url, active, needapikey }));
    if (!rows.length) throw new Error('registry is empty');
    return { rows, state: { ...attempt, status: 'fresh', coverage: 'complete', lastValidatedAt: iso(now), objectKey: await putObject(store, JSON.stringify(rows), known) } };
  } catch (e) {
    const error = String(e.message ?? e).slice(0, 120);
    const rows = prev?.objectKey ? await store.getJson(prev.objectKey) : null;
    if (Array.isArray(rows)) return { rows, state: { ...prev, ...attempt, status: 'retained', coverage: 'partial', error } };
    return { rows: [], state: { ...attempt, status: 'unavailable', coverage: 'unavailable', error } };
  }
}

/** Every object key a manifest needs: tiles, feed snapshots and the registry. */
export const referencedKeys = (m) => [
  ...Object.values(m.tiles ?? {}).map((t) => `${OBJECTS}${t.sha256}.json`),
  ...Object.values(m.feeds ?? {}).map((f) => f.normalizedObjectKey),
  m.registry?.objectKey,
].filter(Boolean);

/**
 * One event per place when feeds overlap (Arizona's statewide feed repeats Maricopa County's):
 * an event within 50 m of one already kept from a different feed is dropped. `order` ranks the
 * feeds (registry order, then the extras), so the same event is kept every run and tiles do not
 * change for nothing.
 */
export function dedupeAcrossFeeds(rows, order) {
  const rank = (r) => order.get(r.feed) ?? order.size;
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const grid = new Map(), kept = [];
  const cell = (lat, lon) => `${Math.floor(lat * 1000)}_${Math.floor(lon * 1000)}`; // ~100 m
  for (const r of sorted) {
    const r0 = Math.floor(r.lat * 1000), c0 = Math.floor(r.lon * 1000);
    let dup = false;
    for (let i = r0 - 1; i <= r0 + 1 && !dup; i++) for (let j = c0 - 1; j <= c0 + 1 && !dup; j++) {
      for (const k of grid.get(`${i}_${j}`) ?? []) {
        if (k.feed === r.feed) continue;
        const d = Math.hypot((k.lat - r.lat) * 111_320, (k.lon - r.lon) * 111_320 * Math.cos((r.lat * Math.PI) / 180));
        if (d < 50) { dup = true; break; }
      }
    }
    if (dup) continue;
    kept.push(r);
    const key = cell(r.lat, r.lon);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(r);
  }
  return kept;
}

/** Rows → { key: rows } in the 0.5° grid, each tile sorted so identical content hashes identically. */
export function tileRows(rows) {
  const tiles = new Map();
  for (const r of rows) {
    const key = tileKey(r.lat, r.lon);
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key).push(r);
  }
  for (const list of tiles.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tiles;
}

const shortHash = (text) => sha256(text).slice(0, 16); // v1 index hashes, the same as before
const compact = (isoTime) => isoTime.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const manifestTime = (key) => Date.parse(key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('/') + 17)
  .replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
const tileBox = (key) => { const [r, c] = key.split('_').map(Number); return [c / PER_DEGREE, r / PER_DEGREE, (c + 1) / PER_DEGREE, (r + 1) / PER_DEGREE]; };
const overlaps = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
const v1Areas = (index) => Object.fromEntries(Object.entries(index?.feedTiles ?? {}).map(([id, keys]) => [id, keys.map(tileBox)
  .reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])])]));

/**
 * One refresh, inside the dataset's lock (`holding` throws if it was lost). Reads the previous
 * manifest through events/v2/current.json, refreshes every feed, applies the window to every
 * snapshot, then writes objects → manifest → current.json → v1 output, and cleans up when due.
 * Refuses to publish over a newer manifest unless `rollback`.
 */
export async function refreshEvents(store, { fetchImpl = fetch, now = Date.now(), keys = {}, rollback = false, gc, holding = async () => {} } = {}) {
  const pointer = await store.getJson(`${V2}/current.json`);
  const prev = pointer && (await store.getJson(pointer.manifest));
  if (pointer && !prev) console.log(`  ${pointer.manifest} is missing: every feed is fetched afresh`);
  if (prev && now <= Date.parse(prev.builtAt) && !rollback) throw new Error(`refusing to publish ${iso(now)} over the newer ${prev.builtAt}; ROLLBACK=1 to go back`);
  const ctx = { store, known: new Set(prev ? referencedKeys(prev) : []), now, fetchImpl };

  const registry = await loadRegistry(prev?.registry, ctx);
  const sources = [
    ...wzdxSources([...registry.rows, ...EXTRA_WZDX], keys).map((s) => ({ ...s, parse: (j) => (j.features ?? []).map((f) => normalizeWzdx(f, s)) })),
    ...CALTRANS.map((url, i) => ({ id: `caltrans-d${i + 1}`, name: 'Caltrans', url, parse: (j) => (j.data ?? []).map((r) => normalizeCaltrans(r)) })),
  ];
  // First v2 run: each feed's area from the v1 index's feedTiles, so a feed down today still
  // marks where it reports. A feed that has never reported anywhere has no area: it shows only in
  // the manifest's coverage, /health/events and freshness.mjs.
  const seeds = prev ? {} : v1Areas(await store.getJson('events/current.json'));
  const results = await Promise.all(sources.map((s) => refreshFeed(s, prev?.feeds?.[s.id] ?? (seeds[s.id] && { bbox: seeds[s.id] }), ctx)));
  const feeds = Object.fromEntries(sources.map((s, i) => [s.id, results[i].state]));

  const order = new Map(sources.map((s, i) => [s.id, i]));
  const visible = results.flatMap((r) => r.rows.filter((row) => inWindow(row, now)));
  const unique = dedupeAcrossFeeds(visible, order);
  if (visible.length !== unique.length) console.log(`  ${visible.length - unique.length} events repeated by another feed, kept once`);
  for (const [id, f] of Object.entries(feeds)) f.count = unique.filter((r) => r.feed === id).length;
  const tiles = tileRows(unique.map(publicRow));

  // Coverage: a tile is Partial when a feed reporting around it was not confirmed this run. A key
  // absent from `tiles` is empty only where no such feed reports (the phone checks feed bboxes).
  // A feed that has never produced a snapshot has no bbox: it shows in `feeds` and `coverage` only.
  const doubtful = Object.values(feeds).filter((f) => f.coverage !== 'complete' && f.bbox).map((f) => f.bbox);
  const states = [registry.state, ...Object.values(feeds)].map((f) => f.coverage);
  const manifest = {
    schema: 2, builtAt: iso(now), perDegree: PER_DEGREE, aheadHours: AHEAD_MS / HOUR, objectPrefix: OBJECTS,
    coverage: states.every((c) => c === 'complete') ? 'complete' : states.every((c) => c === 'unavailable') ? 'unavailable' : 'partial',
    count: unique.length, registry: registry.state, feeds, tiles: {},
  };
  const texts = new Map();
  for (const [key, list] of tiles) {
    const text = JSON.stringify(list);
    texts.set(key, text);
    manifest.tiles[key] = { sha256: sha256(text), bytes: Buffer.byteLength(text), ...(doubtful.some((b) => overlaps(b, tileBox(key))) && { coverage: 'partial' }) };
  }
  // Sixteen at a time: a run after a format change writes every tile, not the usual thirty.
  await pool([...texts.values()], 16, (text) => putObject(store, text, ctx.known));
  const manifestText = JSON.stringify(manifest);
  const manifestKey = `${V2}/manifests/${compact(manifest.builtAt)}-${sha256(manifestText).slice(0, 12)}.json`;
  await store.put(manifestKey, manifestText, { cache: OBJECT_CACHE, ifNoneMatch: '*' });

  // The pointer moves last, and only while this run still holds the lock. `previous` is the last
  // usable manifest, which clean-up always keeps.
  const usable = prev && prev.coverage !== 'unavailable';
  const due = gc ?? (!pointer?.gcAt || now - Date.parse(pointer.gcAt) > GC_EVERY_MS);
  const next = { schema: 2, manifest: manifestKey, builtAt: manifest.builtAt, coverage: manifest.coverage,
    previous: usable ? pointer.manifest : pointer?.previous ?? null, gcAt: due ? iso(now) : pointer?.gcAt ?? null };
  await holding();
  await store.put(`${V2}/current.json`, JSON.stringify(next), { cache: POINTER_CACHE });

  const written = await writeV1(store, tiles, texts, feeds, manifest);
  const swept = due ? await collectGarbage(store, next, now, holding) : null;
  return { manifest: manifestKey, coverage: manifest.coverage, count: unique.length, tiles: tiles.size, written, swept,
    unavailable: Object.keys(feeds).filter((id) => feeds[id].status === 'unavailable'),
    retained: Object.keys(feeds).filter((id) => feeds[id].status === 'retained') };
}

/** The v1 files older app versions read, the same shape as before. Only changed tiles are rewritten. */
async function writeV1(store, tiles, texts, feeds, manifest) {
  const prev = (await store.getJson('events/current.json')) ?? { tiles: {} };
  const index = { builtAt: manifest.builtAt, perDegree: PER_DEGREE, tiles: {}, feeds: {}, feedTiles: {}, count: manifest.count };
  for (const [id, f] of Object.entries(feeds)) index.feeds[id] = { ok: f.status === 'fresh', count: f.count, ...(f.error && { error: f.error }) };
  const writes = [];
  for (const [key, list] of tiles) {
    const text = texts.get(key), hash = shortHash(text);
    index.tiles[key] = hash;
    for (const r of list) (index.feedTiles[r.feed] ??= new Set()).add(key);
    if (prev.tiles?.[key] !== hash) writes.push(() => store.put(`events/t/${key}.json`, text, { cache: 'public, max-age=86400' }));
  }
  await pool(writes, 16, (w) => w());
  const gone = Object.keys(prev.tiles ?? {}).filter((key) => !tiles.has(key)).map((key) => `events/t/${key}.json`);
  if (gone.length) await store.remove(gone);
  index.feedTiles = Object.fromEntries(Object.entries(index.feedTiles).map(([id, set]) => [id, [...set]]));
  await store.put('events/current.json', JSON.stringify(index), { cache: POINTER_CACHE });
  return writes.length;
}

/**
 * Mark and sweep, in the publisher's lock. Keeps every manifest under 35 days old plus the current
 * and previous; re-reads ALL of them and deletes only objects none lists. A retained manifest that
 * cannot be read stops the sweep before anything is deleted. No bucket age rule may ever touch
 * events/v2/objects: a new manifest can reuse an old hash.
 */
export async function collectGarbage(store, pointer, now, holding = async () => {}) {
  const manifests = (await store.list(`${V2}/manifests/`)).map((o) => o.key);
  const keep = manifests.filter((k) => k === pointer.manifest || k === pointer.previous || !(now - manifestTime(k) >= RETAIN_MS));
  const expired = manifests.filter((k) => !keep.includes(k));
  const live = new Set();
  await pool(keep, 16, async (k) => {
    const m = await store.getJson(k);
    if (!m) throw new Error(`retained manifest ${k} unreadable; nothing deleted`);
    for (const key of referencedKeys(m)) live.add(key);
  });
  const orphans = (await store.list(OBJECTS)).map((o) => o.key).filter((k) => !live.has(k));
  await holding();
  // Manifests first: a sweep cut short never leaves a kept manifest naming a deleted object.
  await store.remove(expired);
  await store.remove(orphans);
  return { manifestsKept: keep.length, manifestsDeleted: expired.length, objectsKept: live.size, objectsDeleted: orphans.length };
}

if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('events.mjs')) {
  const { openStore, withLock, restStore } = await import('./store.mjs');
  const dir = process.argv[2];
  const legacy = !dir && !process.env.R2_ACCESS_KEY_ID && process.env.CLOUDFLARE_API_TOKEN;
  const store = legacy ? restStore() : await openStore(dir);
  const opts = { keys: process.env.WZDX_KEYS ? JSON.parse(process.env.WZDX_KEYS) : {}, rollback: process.env.ROLLBACK === '1' };
  const started = Date.now();
  if (legacy) console.log('LEGACY REST path: no lock and no clean-up. The public data repo publishes through R2_* instead.');
  const result = legacy ? await refreshEvents(store, { ...opts, gc: false })
    : await withLock(store, 'events', 30 * 60_000, (holding) => refreshEvents(store, { ...opts, holding }));
  const manifest = await store.getJson(result.manifest);
  for (const [id, f] of Object.entries(manifest.feeds).sort()) {
    console.log(`  ${id}: ${f.status === 'unavailable' ? `UNAVAILABLE ${f.error}` : `${f.count} shown of ${f.total}${f.status === 'retained' ? `, RETAINED from ${f.lastValidatedAt} (${f.error})` : ''}`}`);
  }
  console.log(JSON.stringify(result), `${Date.now() - started} ms`);
}
