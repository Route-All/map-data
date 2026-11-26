import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usOnly, wzdxSources } from '../events.mjs';

// Rows as USDOT's registry has them (2026-11-26).
const registry = [
  { feedname: 'wsdot', issuingorganization: 'Washington State DOT', state: 'washington', url: 'https://wzdx.wsdot.wa.gov/api/v4/WorkZoneFeed', active: true, needapikey: false },
  { feedname: 'necdot', issuingorganization: 'NHDOT/VTAOT/MEDOT', state: 'New Hampshire, Vermont, Maine', url: 'https://api.dx.ne-compass.com/wzdx-latest/', active: true, needapikey: false },
  { feedname: 'quebec', issuingorganization: 'Quebec City', state: 'n/a', url: 'https://quebec.gewi.com/wzdx/pull', active: true, needapikey: false },
  { feedname: 'pbs', issuingorganization: 'PurposeBuilt Systems, LLC', state: 'n/a', url: 'https://feeds.purposebuilt.systems/cwz', active: true, needapikey: false },
  { feedname: 'newfeed', issuingorganization: 'Somewhere', state: 'n/a', url: 'https://example.org/wzdx', active: true, needapikey: false },
];
// Last run's bboxes, from the live manifest.
const seen = { feeds: {
  quebec: { bbox: [-71.43886, 46.74985, -71.16176, 46.91896] },
  pbs: { bbox: [-93.61763, 42.00432, -93.58122, 42.00686] },
} };
// Stand-in for the Census grid: the US is south of 45° N here (Quebec City is at 46.8° N, Ames, Iowa at 42° N).
const inUs = (lon, lat) => lat < 45;

test('a feed the registry places in US states is kept, whatever the grid says', () => {
  const { kept } = usOnly(wzdxSources(registry), seen, () => false);
  assert.deepEqual(kept.map((s) => s.id), ['wsdot', 'necdot']);
});

test('Quebec City is skipped as outside the US and never fetched; an "n/a" feed inside the US is kept', () => {
  const { kept, skipped } = usOnly(wzdxSources(registry), seen, inUs);
  assert.deepEqual(kept.map((s) => s.id), ['wsdot', 'necdot', 'pbs']);
  assert.equal(skipped.quebec.reason, 'outside the US');
  assert.deepEqual(skipped.quebec.bbox, seen.feeds.quebec.bbox);
});

test('a feed of unknown jurisdiction is reported, not silently dropped', () => {
  const { skipped } = usOnly(wzdxSources(registry), seen, inUs);
  assert.match(skipped.newfeed.reason, /jurisdiction unknown/);
  assert.equal(skipped.newfeed.name, 'Somewhere');
});

test('Quebec stays outside the US on later runs, from the skipped list', () => {
  const first = usOnly(wzdxSources(registry), seen, inUs);
  const later = usOnly(wzdxSources(registry), { feeds: { pbs: seen.feeds.pbs }, skipped: first.skipped }, inUs);
  assert.equal(later.skipped.quebec.reason, 'outside the US');
});

test('with the grid unreadable, a feed keeps last run\'s verdict', () => {
  const { kept, skipped } = usOnly(wzdxSources(registry), { feeds: { pbs: seen.feeds.pbs }, skipped: { quebec: seen.feeds.quebec } }, null);
  assert.ok(kept.some((s) => s.id === 'pbs'));
  assert.ok(skipped.quebec && skipped.newfeed);
});
