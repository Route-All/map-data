import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const DIR = path.join(import.meta.dirname, '..');
// Eight real rows of FHWA's 2025 delimited all-states file (2025hwybronefiledel.zip), unchanged.
const SAMPLE = path.join(import.meta.dirname, 'nbi-2025-sample.txt');
const py = (code) => execFileSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(DIR)}); import bridges as B\n${code}`], { encoding: 'utf8' });

test('bridges: real NBI rows decoded, metres to feet, unrestricted codes, posting and status', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridges-'));
  // The fixture covers 5 states, so write() refuses the short set; build() is checked on its own and write() below.
  const { states, dropped } = JSON.parse(py(`import json; s, d = B.build(open(${JSON.stringify(SAMPLE)}, encoding='latin-1', newline=''))\nprint(json.dumps({'states': s, 'dropped': d}))`));
  assert.deepEqual(dropped, { 'other territory': 1, 'no location': 1 }); // Puerto Rico; an Idaho forest bridge with no coordinates
  assert.deepEqual(Object.keys(states).sort(), ['AL', 'CT', 'DE', 'KS', 'MS']);
  // Rising Sun Lane over Brandywine Creek: a truss with 4.28 m over the deck, 6.1 m between rails, posted (P), item 70 = 2 (20-30 % below legal).
  assert.deepEqual(states.DE[0], [39.7693, -75.5767, '1001 279', 'CR 279', 'RISING SUN LANE', 'BRANDYWINE CREEK', null, 14.04, null, 20.01, 25.6, 2, 'P']);
  // US 49 over US 11 in Hattiesburg: 3.98 m over the highway beneath = 13.06 ft, under a 13 ft 6 in load. 99.99 over the deck = unrestricted.
  const [ms] = states.MS;
  assert.equal(ms[3], 'US 49'); assert.equal(ms[5], 'US 11'); assert.equal(ms[6], 'H'); assert.equal(ms[7], null); assert.equal(ms[8], 13.06);
  // Kansas codes "no restriction" as 100 ft (30.47 m), not 99.99.
  assert.equal(states.KS[0][7], null);
  // Closed (K) over a railroad (54A R, 6.71 m), rating 0 t, posting 0; and a business route (5C 6).
  const closed = states.AL.find((b) => b[2] === '000729'), bus = states.AL.find((b) => b[2] === '016389');
  assert.deepEqual(closed.slice(6), ['R', null, 22.01, 17.39, 0, 0, 'K']);
  assert.equal(bus[3], 'US 98 Bus');
  // I-84 westbound (5E 4); an LRFR rating factor of 3.0 that FHWA publishes as 97.2 t (x 32.4).
  assert.equal(states.CT[0][3], 'I 84 W'); assert.equal(states.CT[0][10], 97.2);

  // Unit rules on their own: 99.99 and 0 are null; widths are unrestricted only at 99.9; DMS and decimal-degree coordinates.
  assert.deepEqual(JSON.parse(py(`import json; print(json.dumps([B.feet('99.99'), B.feet('0'), B.feet(''), B.feet('4.11'), B.feet('31.5', 99.0), B.feet('99.9', 99.0),
    B.degrees('39460947', 8), B.degrees('075343612', 9), B.degrees('32126910', 8), B.degrees('', 8)]))`)),
    [null, null, null, 13.48, 103.35, null, 39.7693, 75.5767, 32.12691, null]);

  // write(): one gzip per state with its source line and field names, and the index the publisher reads (bytes + SHA-256).
  py(`B.STATES = {'10': 'DE', '28': 'MS'}\ns, _ = B.build(open(${JSON.stringify(SAMPLE)}, encoding='latin-1', newline=''))\nB.write(${JSON.stringify(work)}, {k: s[k] for k in ('DE', 'MS')}, {'url': None, 'year': 2025, 'lastModified': None, 'bytes': 0})`);
  const index = JSON.parse(fs.readFileSync(path.join(work, 'bridges.json'), 'utf8'));
  assert.match(index.buildId, /^\d{8}T\d{6}Z$/);
  const gz = fs.readFileSync(path.join(work, 'bridges', 'DE.json.gz'));
  assert.equal(index.states.DE.bytes, gz.length);
  assert.equal(index.states.DE.sha256, crypto.createHash('sha256').update(gz).digest('hex'));
  const de = JSON.parse(zlib.gunzipSync(gz));
  assert.match(de.source, /FHWA National Bridge Inventory 2025.*public domain/);
  assert.equal(de.fields.length, de.bridges[0].length);
});

test('bridges: the daily check builds only when FHWA has a different file, never an older year', () => {
  const live = { url: 'u25', year: 2025, lastModified: 'Mon, 16 Jun 2025 16:57:04 GMT', bytes: 53277475 };
  assert.deepEqual(JSON.parse(py(`import json; L = ${JSON.stringify(live)}
print(json.dumps([B.should_build(L, L), B.should_build(L, None), B.should_build({**L, 'bytes': 1}, L),
  B.should_build({**L, 'year': 2026, 'url': 'u26'}, L), B.should_build({**L, 'year': 2024, 'url': 'u24'}, L)]))`)),
    [false, true, true, true, false]);
});
