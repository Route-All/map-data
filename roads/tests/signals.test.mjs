import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mergeSignals, signalKey, signalTiles } from '../signals.mjs';

// ~1 m of latitude, in degrees.
const M = 1 / 111_320;

test('one junction mapped per approach is one light, at the mean', () => {
  const [lon, lat] = [-117.2393, 32.7925];
  const approaches = [[lon, lat + 12 * M], [lon, lat - 12 * M], [lon + 12 * M / Math.cos((lat * Math.PI) / 180), lat]];
  const merged = mergeSignals(approaches);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0], [Math.round(((lon * 2 + approaches[2][0]) / 3) * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
});

test('lights over 30 m apart stay separate; a chain of close nodes is one', () => {
  assert.equal(mergeSignals([[-87.69, 41.75], [-87.69, 41.75 + 31 * M]]).length, 2);
  assert.equal(mergeSignals([[-87.69, 41.75], [-87.69, 41.75 + 29 * M]]).length, 1);
  // A–B 25 m, B–C 25 m, A–C 50 m: single linkage joins all three (the ponytail ceiling in signals.mjs).
  assert.equal(mergeSignals([[-87.69, 41.75], [-87.69, 41.75 + 25 * M], [-87.69, 41.75 + 50 * M]]).length, 1);
  // Neighbours across a 0.001° grid line and across the 0.25° tile line still merge.
  assert.equal(mergeSignals([[-87.69, 41.74999], [-87.69, 41.75001]]).length, 1);
  assert.equal(mergeSignals([]).length, 0);
});

test('coordinates are rounded to 5 decimals', () => {
  assert.deepEqual(mergeSignals([[-117.123456789, 32.987654321]]), [[-117.12346, 32.98765]]);
});

test('tile key is floor(lat / 0.25)_floor(lon / 0.25), negative longitudes floor down', () => {
  assert.equal(signalKey(-117.2393, 32.7925), '131_-469');
  assert.equal(signalKey(-87.69, 41.7503), '167_-351');
  assert.equal(signalKey(-87.5, 41.75), '167_-350'); // exactly on a line: the tile to the north-east
  assert.equal(signalKey(-87.50001, 41.74999), '166_-351');
  const tiles = signalTiles([[-117.2393, 32.7925], [-117.24, 32.79], [-87.69, 41.7503]]);
  assert.deepEqual(Object.keys(tiles).sort(), ['131_-469', '167_-351']);
  assert.deepEqual(tiles['131_-469'], { s: [[-117.2393, 32.7925], [-117.24, 32.79]] });
});

test('finish + publish: gzip tiles, then the exact contract pointer; no other dataset touched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signals-')), work = path.join(root, 'work'), store = path.join(root, 'store');
  fs.mkdirSync(work);
  // n1 comes from two state extracts; n2 is the same junction's other approach.
  fs.writeFileSync(path.join(work, 'signals-raw.csv'), 'n1,-87.69,41.75\nn1,-87.69,41.75\nn2,-87.69,41.7501\nn3,-117.2393,32.7925\n');
  const SIGNALS = new URL('../signals.mjs', import.meta.url).pathname, PUBLISH = new URL('../publish.mjs', import.meta.url).pathname;
  execFileSync('node', [SIGNALS, 'finish', work]);
  const build = JSON.parse(fs.readFileSync(path.join(work, 'signals.json'), 'utf8'));
  assert.equal(build.nodes, 3);
  assert.equal(build.signals, 2);
  execFileSync('node', [PUBLISH], { env: { ...process.env, STORE_DIR: store, WORK: work, KIND: 'signals' } });
  const pointer = JSON.parse(fs.readFileSync(path.join(store, 'signals/current.json'), 'utf8'));
  assert.deepEqual(pointer, { version: build.buildId, deg: 0.25, path: `signals/v1/${build.buildId}` });
  const tile = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(store, pointer.path, '167_-351.json'))));
  assert.deepEqual(tile, { s: [[-87.69, 41.75005]] });
  assert.deepEqual(fs.readdirSync(store).sort(), ['locks', 'signals']); // roads/, pois/ … untouched
  assert.deepEqual(fs.readdirSync(path.join(store, 'locks')), []); // the lock was released
});
