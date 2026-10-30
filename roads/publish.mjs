// Uploads a finished build (build.sh output) to R2 and makes it live. The one publish entry for
// roads, places (KIND=pois) and fuel (KIND=fuel), for scheduled and manual runs alike:
//   R2_S3_ENDPOINT=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node publish.mjs   R2's S3 API
//   ROLLBACK=1 …   allows a build from older sources than the live one
//   STORE_DIR=<folder> node publish.mjs                                           the same, into a folder
// WORK (default .build) is the build to upload; R2_BUCKET defaults to routeall-roads.
// LEGACY, until the public data repo's writer takes over (the old schedule is disabled first):
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node publish.mjs   Cloudflare's REST API, paced
//   WRANGLER=1 node publish.mjs                                         the same through wrangler's login
//
// The bucket is PUBLIC (tiles.routeall.app): upload nothing but tiles and build metadata.
//
// Through the S3 API, inside the dataset's lock (store.mjs, one writer at a time):
// - Only changed tiles are uploaded. A tile whose MD5 matches the live build's copy is copied
//   inside R2 instead; one already uploaded by an interrupted run of this build is skipped. Each
//   upload carries its Content-MD5, so R2 rejects corrupted bytes.
// - Order matters. Every tile first; any tile that still fails after retries stops the run. Then
//   <kind>/<buildId>/build.json, and <kind>/current.json LAST, while still holding the lock. Until
//   the pointer moves, phones keep reading the previous build.
// - Then clean-up: builds other than the new and the previous live one are deleted once the
//   build that replaced them has been live for a day. v1 builds are full copies under their own
//   prefix (old app versions read those paths), so 35 days of daily builds would be ~50 GB; the
//   35-day retention applies to the content-addressed v2 data instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WORK = process.env.WORK ?? new URL('.build', import.meta.url).pathname;
const BUCKET = process.env.R2_BUCKET ?? 'routeall-roads';
const TILE_CACHE = 'public, max-age=31536000, immutable'; // a build's tiles never change
const POINTER_CACHE = 'public, max-age=300'; // a new build reaches the edge within 5 minutes
const PARALLEL = 24;
const DAY = 86_400_000;
const ROLLBACK = process.env.ROLLBACK === '1';
const KIND = process.env.KIND ?? 'roads';

// STORE_DIR=<folder> runs the same path into a folder, for checking it by hand.
if (process.env.R2_ACCESS_KEY_ID || process.env.STORE_DIR) {
  const { openStore, withLock } = await import('./store.mjs');
  const store = await openStore(process.env.STORE_DIR);
  const run = KIND === 'fuel' ? publishFuel : KIND === 'roads2' ? (st, h) => publishAddressed(st, h, ROADS_V2)
    : KIND === 'boundaries' ? (st, h) => publishAddressed(st, h, BOUNDARIES) : publishBuild;
  await withLock(store, KIND, (KIND === 'fuel' ? 1 : 6) * 3_600_000, (holding) => run(store, holding));
  process.exit(0);
}

/*
  Content-addressed data (road tiles v2, state boundaries; plan 1.5, spec section 5): each object is named by its
  SHA-256 and never changes, a build is a manifest listing the objects it uses, and <prefix>/current.json points at
  the live manifest. A new build uploads only objects not already there, then its manifest, then the pointer LAST.
  Clean-up is mark-and-sweep in the same lock: keep every manifest built in the last RETAIN_DAYS plus the current and
  previous ones, re-read them all, and delete only objects none of them lists. There is no bucket age rule on these
  objects, because a new manifest can reuse an old one.
*/
const RETAIN_DAYS = 35;
const ROADS_V2 = {
  prefix: 'roads/v2', manifest: () => path.join(WORK, 'manifest2.json'), dir: () => path.join(WORK, 'tiles2'),
  objects: (m) => Object.values(m.tiles), local: (o) => o.key.split('/').pop(),
};
const BOUNDARIES = {
  prefix: 'boundaries/v1', manifest: () => path.join(WORK, 'boundaries', 'manifest.json'), dir: () => path.join(WORK, 'boundaries', 'objects'),
  objects: (m) => [m.index, ...Object.values(m.blocks)], local: (o) => o.key.split('/').pop(),
};
export const stampOf = (id) => Date.parse(id.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
/** Manifests to keep: built within RETAIN_DAYS, or current, or previous. */
export function retainedBuilds(ids, current, previous, now = Date.now()) {
  return ids.filter((id) => id === current || id === previous || now - stampOf(id) <= RETAIN_DAYS * DAY);
}

async function publishAddressed(store, holding, kind) {
  const { pool } = await import('./store.mjs');
  const crypto = await import('node:crypto');
  const manifestText = fs.readFileSync(kind.manifest(), 'utf8'), manifest = JSON.parse(manifestText);
  const objects = kind.objects(manifest);
  const live = await store.getJson(`${kind.prefix}/current.json`);
  if (live && live.buildId > manifest.buildId && !ROLLBACK) throw new Error(`live ${kind.prefix} build ${live.buildId} is newer than ${manifest.buildId}; ROLLBACK=1 to go back`);
  const have = new Set((await store.list(`${kind.prefix}/objects/`)).map((o) => o.key));
  const missing = objects.filter((o) => !have.has(o.key));
  console.log(`${kind.prefix} ${manifest.buildId}: ${objects.length} objects, ${missing.length} to upload; live ${live?.buildId ?? 'none'}`);
  const t0 = Date.now();
  await pool(missing, PARALLEL, async (o) => {
    const bytes = fs.readFileSync(path.join(kind.dir(), kind.local(o)));
    // The name is the promise: an object whose bytes do not hash to it never goes up.
    if (bytes.length !== o.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== o.sha256) throw new Error(`${o.key} does not match its manifest entry`);
    await store.put(o.key, bytes, { type: 'application/octet-stream', cache: TILE_CACHE });
  });
  console.log(`objects in place in ${Math.round((Date.now() - t0) / 1000)} s`);
  const manifestKey = `${kind.prefix}/${manifest.buildId}/manifest.json`;
  await store.put(manifestKey, manifestText, { type: 'application/json', cache: TILE_CACHE });
  const previous = live?.buildId === manifest.buildId ? live.previous : live?.buildId;
  await holding();
  await store.put(`${kind.prefix}/current.json`, JSON.stringify({ buildId: manifest.buildId, manifest: manifestKey, ...(previous && { previous }) }), { type: 'application/json', cache: POINTER_CACHE });
  console.log(`live: ${kind.prefix} ${manifest.buildId}`);

  // Mark and sweep, still holding the lock.
  const manifestKeys = (await store.list(`${kind.prefix}/`)).map((o) => o.key).filter((k) => /\/\d{8}T\d{6}Z\/manifest\.json$/.test(k));
  const ids = manifestKeys.map((k) => k.split('/').at(-2)).sort();
  const keep = new Set(retainedBuilds(ids, manifest.buildId, previous));
  const marked = new Set();
  for (const id of keep) {
    const m = await store.getJson(`${kind.prefix}/${id}/manifest.json`);
    if (!m) throw new Error(`retained manifest ${id} could not be read; nothing deleted`);
    for (const o of kind.objects(m)) marked.add(o.key);
  }
  const sweep = (await store.list(`${kind.prefix}/objects/`)).map((o) => o.key).filter((k) => !marked.has(k));
  const oldManifests = ids.filter((id) => !keep.has(id)).map((id) => `${kind.prefix}/${id}/manifest.json`);
  if (sweep.length || oldManifests.length) {
    await holding();
    await store.remove([...oldManifests, ...sweep]);
  }
  console.log(`clean-up: kept ${keep.size} manifests, deleted ${oldManifests.length} manifests and ${sweep.length} objects`);
}

async function publishFuel(store, holding) {
  const text = fs.readFileSync(path.join(WORK, 'fuel.json'), 'utf8');
  const live = await store.getJson('fuel/current.json');
  if (live?.weekOf > JSON.parse(text).weekOf && !ROLLBACK) throw new Error(`live fuel is for ${live.weekOf}, newer than ${JSON.parse(text).weekOf}; ROLLBACK=1 to go back`);
  await holding();
  await store.put('fuel/current.json', text, { cache: POINTER_CACHE });
  console.log('live: fuel/current.json');
}

/** Newest source date of a build: Geofabrik's replication time for roads, the build time for places. */
function sourceAge(b) { return (b.sourceDates ? Object.values(b.sourceDates).sort().at(-1) : b.builtAt) ?? ''; }

async function publishBuild(store, holding) {
  const { md5, pool } = await import('./store.mjs');
  const places = KIND === 'pois';
  const metaFile = path.join(WORK, places ? 'pois.json' : 'build.json');
  const build = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const tilesDir = path.join(WORK, places ? 'pois' : 'tiles');
  const prefix = (id) => (places ? `pois/${id}/` : `roads/${id}/tiles/`);
  const files = fs.readdirSync(tilesDir).filter((f) => f.endsWith('.bin'));
  if (files.length !== build.tileCount) throw new Error(`${files.length} tiles on disk, ${path.basename(metaFile)} says ${build.tileCount}`);
  const live = await store.getJson(`${KIND}/current.json`);
  if (live && sourceAge(build) < sourceAge(live) && !ROLLBACK) throw new Error(`build ${build.buildId} is from older sources (${sourceAge(build)}) than live ${live.buildId} (${sourceAge(live)}); ROLLBACK=1 to go back`);
  console.log(`uploading build ${build.buildId} (${files.length} tiles); live build is ${live?.buildId ?? 'none'}`);

  const etags = async (id) => new Map((await store.list(prefix(id))).map((o) => [o.key.slice(prefix(id).length), o.etag]));
  const already = await etags(build.buildId);
  const before = live && live.buildId !== build.buildId ? await etags(live.buildId) : new Map();
  const counts = { uploaded: 0, copied: 0, skipped: 0 };
  const t0 = Date.now();
  await pool(files, 32, async (f) => {
    const bytes = fs.readFileSync(path.join(tilesDir, f)), sum = md5(bytes);
    const opts = { type: 'application/octet-stream', cache: TILE_CACHE };
    if (already.get(f) === sum) counts.skipped++;
    else if (before.get(f) === sum) { await store.copy(`${prefix(live.buildId)}${f}`, `${prefix(build.buildId)}${f}`, opts); counts.copied++; }
    else { await store.put(`${prefix(build.buildId)}${f}`, bytes, opts); counts.uploaded++; }
    const done = counts.uploaded + counts.copied + counts.skipped;
    if (done % 2000 === 0) console.log(`  ${done}/${files.length} tiles, ${Math.round((Date.now() - t0) / 1000)} s`);
  });
  console.log(`tiles in place in ${Math.round((Date.now() - t0) / 1000)} s: ${JSON.stringify(counts)}`);

  const previous = live?.buildId === build.buildId ? live.previous : live?.buildId;
  await store.put(`${KIND}/${build.buildId}/build.json`, fs.readFileSync(metaFile), { cache: TILE_CACHE });
  await holding();
  await store.put(`${KIND}/current.json`, JSON.stringify({ ...build, ...(previous && { previous }) }), { cache: POINTER_CACHE });
  console.log(`live: ${build.buildId}`);

  // Clean-up, in the same lock. A build id is its build time, so the build after X in id order
  // is the one that replaced it; X goes once that one is a day old and X is not current/previous.
  const ids = [...new Set((await store.list(`${KIND}/`)).map((o) => o.key.match(new RegExp(`^${KIND}/(\\d{8}T\\d{6}Z)/`))?.[1]).filter(Boolean))].sort();
  const stamp = (id) => Date.parse(id.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
  const retire = ids.filter((id, i) => id !== build.buildId && id !== previous && ids[i + 1] && Date.now() - stamp(ids[i + 1]) > DAY);
  for (const id of retire) {
    const keys = (await store.list(`${KIND}/${id}/`)).map((o) => o.key);
    await holding();
    await store.remove(keys);
    console.log(`build ${id} deleted (${keys.length} objects)`);
  }
}

// Cloudflare's API allows 1,200 requests per 5 minutes per user; stay under it rather than
// spend the run on 429s. A full US build (14,764 tiles) therefore takes about 70 minutes to upload.
const WINDOW_MS = 300_000, WINDOW_MAX = 1_100;
const starts = [];
async function paced() {
  while (true) {
    while (starts.length && Date.now() - starts[0] > WINDOW_MS) starts.shift();
    if (starts.length < WINDOW_MAX) { starts.push(Date.now()); return; }
    await sleep(starts[0] + WINDOW_MS - Date.now() + 50);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rest() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
  if (!token || !account) throw new Error('set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or WRANGLER=1');
  const api = `${process.env.CLOUDFLARE_API_BASE ?? 'https://api.cloudflare.com/client/v4'}/accounts/${account}/r2/buckets/${BUCKET}`;
  // Retries what is worth retrying (rate limit, 5xx, network) with backoff; anything else throws.
  async function call(method, url, init = {}) {
    for (let attempt = 1; ; attempt++) {
      await paced();
      let res, why;
      try {
        res = await fetch(url, { method, ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
        if (res.ok || res.status === 404) return res;
        why = `${res.status} ${(await res.text()).slice(0, 200)}`;
        if (res.status !== 429 && res.status < 500) throw new Error(`${method} ${url.replace(api, '')}: ${why}`);
      } catch (error) {
        if (res && res.status !== 429 && res.status < 500) throw error;
        why ??= error.message;
      }
      if (attempt === 8) throw new Error(`${method} ${url.replace(api, '')}: ${why} (gave up after ${attempt} tries)`);
      await sleep(Number(res?.headers.get('retry-after')) * 1000 || 2 ** attempt * 1000);
    }
  }
  return {
    async put(key, file, contentType, cacheControl) {
      await call('PUT', `${api}/objects/${key}`, { body: fs.readFileSync(file), headers: { 'content-type': contentType, 'cache-control': cacheControl } });
    },
    async get(key) {
      const res = await call('GET', `${api}/objects/${key}`);
      return res.status === 404 ? null : res.text();
    },
    async expire(prefix, name) {
      const rules = (await (await call('GET', `${api}/lifecycle`)).json()).result?.rules ?? [];
      rules.push({ id: name, enabled: true, conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86_400 } } });
      await call('PUT', `${api}/lifecycle`, { body: JSON.stringify({ rules }), headers: { 'content-type': 'application/json' } });
    },
  };
}

function wrangler() {
  const run = (...args) => execFileSync('npx', ['wrangler', ...args], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 }).toString();
  return {
    async put(key, file, contentType, cacheControl) {
      run('r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', contentType, '--cache-control', cacheControl, '--remote', '--force');
    },
    async get(key) {
      try { return run('r2', 'object', 'get', `${BUCKET}/${key}`, '--pipe', '--remote'); } catch { return null; }
    },
    async expire(prefix, name) {
      run('r2', 'bucket', 'lifecycle', 'add', BUCKET, name, prefix, '--expire-days', '1', '--force');
    },
    async putAll(entries) { // one wrangler process, its own pacing under the API limit
      const list = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roads-')), 'entries.json');
      fs.writeFileSync(list, JSON.stringify(entries));
      run('r2', 'bulk', 'put', BUCKET, '--filename', list, '--content-type', 'application/octet-stream', '--cache-control', TILE_CACHE, '--remote', '--force', '--concurrency', String(PARALLEL));
    },
  };
}

// LEGACY path from here on (no lock, retirement by lifecycle rule).
console.log('LEGACY REST/wrangler path: no lock. The public data repo publishes through R2_* instead.');
const r2 = process.env.WRANGLER ? wrangler() : rest();
// KIND=fuel serves the week's fuel averages (fuel.mjs): one small file, no build or tiles.
if (process.env.KIND === 'fuel') {
  await r2.put('fuel/current.json', path.join(WORK, 'fuel.json'), 'application/json', POINTER_CACHE);
  console.log('live: fuel/current.json');
  process.exit(0);
}
// KIND=pois publishes the place tiles (pois.mjs) under their own pointer, so a places build can
// never replace the road build the route builder reads.
const PLACES = KIND === 'pois';
const build = JSON.parse(fs.readFileSync(path.join(WORK, PLACES ? 'pois.json' : 'build.json'), 'utf8'));
const TILES = path.join(WORK, PLACES ? 'pois' : 'tiles');
const tileKey = (f) => (PLACES ? `pois/${build.buildId}/${f}` : `roads/${build.buildId}/tiles/${f}`);
const files = fs.readdirSync(TILES).filter((f) => f.endsWith('.bin'));
if (files.length !== build.tileCount) throw new Error(`${files.length} tiles on disk, build.json says ${build.tileCount}`);
const raw = await r2.get(`${KIND}/current.json`);
const live = raw ? JSON.parse(raw) : null;
console.log(`uploading build ${build.buildId} (${files.length} tiles); live build is ${live?.buildId ?? 'none'}`);

const entries = files.map((f) => ({ key: tileKey(f), file: path.join(TILES, f) }));
const t0 = Date.now();
if (r2.putAll) await r2.putAll(entries);
else {
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < entries.length) {
      const { key, file } = entries[next++];
      await r2.put(key, file, 'application/octet-stream', TILE_CACHE);
      if (++done % 1000 === 0) console.log(`  ${done}/${entries.length} tiles, ${Math.round((Date.now() - t0) / 1000)} s`);
    }
  }));
}
console.log(`tiles up in ${Math.round((Date.now() - t0) / 1000)} s`);

// The pointer remembers the build it replaced, so the next run knows which one to retire.
const previous = live?.buildId === build.buildId ? live.previous : live?.buildId;
const pointer = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roads-')), 'current.json');
fs.writeFileSync(pointer, JSON.stringify({ ...build, ...(previous && { previous }) }));
await r2.put(`${KIND}/${build.buildId}/build.json`, path.join(WORK, PLACES ? 'pois.json' : 'build.json'), 'application/json', TILE_CACHE);
await r2.put(`${KIND}/current.json`, pointer, 'application/json', POINTER_CACHE);
console.log(`live: ${build.buildId}`);

const retire = live?.buildId === build.buildId ? null : live?.previous;
if (retire && retire !== build.buildId && retire !== previous) {
  await r2.expire(`${KIND}/${retire}/`, `${KIND}-retire-${retire}`);
  console.log(`build ${retire} will be deleted by R2 within a day`);
}
