// Where the public-data jobs read and write. One small interface, so events.mjs and publish.mjs
// run the same path for manual and scheduled runs:
//   get(key)                → { text, etag } or null          getJson(key) → parsed or null
//   put(key, body, opts)    → true, or false when opts.ifNoneMatch / opts.ifMatch did not hold
//   copy(from, to, opts), list(prefix) → [{ key, etag, size }], remove(keys)
//
//   openStore()         R2 through its S3 API (R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//                       R2_BUCKET): the production writer
//   openStore(dir)      a folder, for runs by hand
//   memoryStore()       a Map, for checks; `ops` records every write in order
//
// The bucket is PUBLIC (tiles.routeall.app). Nothing but public data goes through here.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const md5 = (body) => createHash('md5').update(body).digest('hex');
export const sha256 = (body) => createHash('sha256').update(body).digest('hex');

/** Runs fn over items, at most `n` at a time. */
export async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const withJson = (store) => Object.assign(store, {
  async getJson(key) { const got = await store.get(key); return got ? JSON.parse(got.text) : null; },
});

export async function openStore(dir) {
  if (dir) return fileStore(dir);
  const { R2_S3_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error('set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, or give a folder');
  return s3Store({ endpoint, accessKeyId, secretAccessKey, bucket: process.env.R2_BUCKET ?? 'routeall-roads' });
}

export async function s3Store({ endpoint, accessKeyId, secretAccessKey, bucket }) {
  const S3 = await import('@aws-sdk/client-s3');
  // Checksums only where S3 requires them: R2 verifies each upload against its Content-MD5 instead,
  // and that MD5 is the ETag publish.mjs compares to skip unchanged tiles.
  const s3 = new S3.S3Client({ region: 'auto', endpoint, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 8, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  const status = (e) => e?.$metadata?.httpStatusCode;
  const headers = (opts) => ({ ContentType: opts.type ?? 'application/json', CacheControl: opts.cache });
  return withJson({
    locks: true,
    async get(key) {
      try {
        const res = await s3.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key }));
        return { text: await res.Body.transformToString(), etag: res.ETag };
      } catch (e) { if (status(e) === 404) return null; throw e; }
    },
    async put(key, body, opts = {}) {
      const bytes = typeof body === 'string' ? Buffer.from(body) : body;
      try {
        await s3.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ...headers(opts),
          ContentMD5: createHash('md5').update(bytes).digest('base64'), IfNoneMatch: opts.ifNoneMatch, IfMatch: opts.ifMatch }));
        return true;
      } catch (e) { if (status(e) === 412) return false; throw e; }
    },
    async copy(from, to, opts = {}) {
      await s3.send(new S3.CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: `${bucket}/${from}`, MetadataDirective: 'REPLACE', ...headers(opts) }));
    },
    async list(prefix) {
      const out = [];
      let ContinuationToken;
      do {
        const res = await s3.send(new S3.ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
        for (const o of res.Contents ?? []) out.push({ key: o.Key, etag: o.ETag?.replaceAll('"', ''), size: o.Size });
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },
    // One DeleteObject per key: DeleteObjects needs a request checksum, and deletes are free on R2.
    async remove(keys) { await pool(keys, 32, (Key) => s3.send(new S3.DeleteObjectCommand({ Bucket: bucket, Key }))); },
  });
}

/**
 * LEGACY: Cloudflare's REST API with CLOUDFLARE_API_TOKEN, what the app repo's Road Work workflow
 * holds today. No conditional writes and no listing, so no lock and no clean-up: kept only until
 * the public data repo's R2_* writer takes over, and the old schedule is disabled first.
 */
export function restStore() {
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${process.env.R2_BUCKET ?? 'routeall-roads'}/objects/`;
  const call = async (method, key, body, opts = {}) => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(api + key, { method, body, headers: { authorization: `Bearer ${token}`,
        ...(body && { 'content-type': opts.type ?? 'application/json', ...(opts.cache && { 'cache-control': opts.cache }) }) } });
      if (res.ok || res.status === 404) return res;
      if (attempt === 5 || (res.status < 500 && res.status !== 429)) throw new Error(`${method} ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  };
  return withJson({
    async get(k) { const res = await call('GET', k); return res.status === 404 ? null : { text: await res.text(), etag: res.headers.get('etag') }; },
    async put(k, body, opts) { await call('PUT', k, body, opts); return true; },
    async remove(keys) { await pool(keys, 16, (k) => call('DELETE', k)); },
  });
}

export function fileStore(dir) {
  const file = (k) => path.join(dir, k);
  const read = (k) => (fs.existsSync(file(k)) ? fs.readFileSync(file(k)) : null);
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : []);
  return withJson({
    locks: true,
    async get(k) { const b = read(k); return b && { text: b.toString('utf8'), etag: md5(b) }; },
    async put(k, body, opts = {}) {
      const b = read(k);
      if ((opts.ifNoneMatch && b) || (opts.ifMatch && (!b || md5(b) !== opts.ifMatch))) return false;
      fs.mkdirSync(path.dirname(file(k)), { recursive: true });
      fs.writeFileSync(file(k), body);
      return true;
    },
    async copy(from, to) { fs.mkdirSync(path.dirname(file(to)), { recursive: true }); fs.copyFileSync(file(from), file(to)); },
    async list(prefix) {
      const base = path.dirname(file(`${prefix}x`));
      return walk(base).map((f) => path.relative(dir, f).split(path.sep).join('/')).filter((k) => k.startsWith(prefix))
        .map((key) => { const b = read(key); return { key, etag: md5(b), size: b.length }; });
    },
    async remove(keys) { for (const k of keys) fs.rmSync(file(k), { force: true }); },
  });
}

export function memoryStore(seed = {}) {
  const objects = new Map(Object.entries(seed).map(([k, v]) => [k, Buffer.from(v)]));
  const ops = [];
  return withJson({
    locks: true, objects, ops,
    async get(k) { const b = objects.get(k); return b && { text: b.toString('utf8'), etag: md5(b) }; },
    async put(k, body, opts = {}) {
      const b = objects.get(k);
      if ((opts.ifNoneMatch && b) || (opts.ifMatch && (!b || md5(b) !== opts.ifMatch))) return false;
      objects.set(k, Buffer.from(body));
      ops.push(`put ${k}`);
      return true;
    },
    async copy(from, to) { objects.set(to, objects.get(from)); ops.push(`copy ${to}`); },
    async list(prefix) { return [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, etag: md5(b), size: b.length })); },
    async remove(keys) { for (const k of keys) { objects.delete(k); ops.push(`delete ${k}`); } },
  });
}

/**
 * One writer per dataset. The lease is created only if absent (If-None-Match) and taken over
 * only once expired, and only from the exact copy that was read (If-Match), so two publishers,
 * scheduled or by hand, from any repo or machine, never write the same dataset at once. fn gets
 * `holding()`, which throws if the lease was lost; call it before every pointer move or delete.
 */
export async function withLock(store, dataset, ttlMs, fn) {
  const key = `locks/${dataset}.json`;
  const now = Date.now();
  const me = { owner: randomUUID(), by: process.env.GITHUB_RUN_ID ? `GitHub run ${process.env.GITHUB_RUN_ID}` : 'a run by hand',
    startedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString() };
  const body = JSON.stringify(me);
  if (!(await store.put(key, body, { ifNoneMatch: '*', cache: 'no-store' }))) {
    const held = await store.get(key);
    const lease = held && JSON.parse(held.text);
    if (lease && Date.parse(lease.expiresAt) > now) throw new Error(`${dataset} is being published by ${lease.by} since ${lease.startedAt}; one writer at a time`);
    const took = held ? await store.put(key, body, { ifMatch: held.etag, cache: 'no-store' }) : await store.put(key, body, { ifNoneMatch: '*', cache: 'no-store' });
    if (!took) throw new Error(`another publisher took the ${dataset} lock first`);
    if (lease) console.log(`took over the ${dataset} lock left by ${lease.by} (expired ${lease.expiresAt})`);
  }
  const mine = async () => (await store.getJson(key))?.owner === me.owner;
  const holding = async () => { if (!(await mine())) throw new Error(`lost the ${dataset} lock; stopping before writing anything live`); };
  try {
    return await fn(holding);
  } finally {
    if (await mine()) await store.remove([key]);
  }
}
