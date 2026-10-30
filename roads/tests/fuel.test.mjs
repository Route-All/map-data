import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packFuel, STATE_AREA } from '../fuel.mjs';
import { stateCode } from '../pois.mjs';

const STATES = `alabama alaska arizona arkansas california colorado connecticut delaware district-of-columbia florida
  georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota
  mississippi missouri montana nebraska nevada new-hampshire new-jersey new-mexico new-york north-carolina north-dakota
  ohio oklahoma oregon pennsylvania rhode-island south-carolina south-dakota tennessee texas utah vermont virginia
  washington west-virginia wisconsin wyoming`.split(/\s+/);

test('every state the build downloads has a code and a fuel region', () => {
  assert.equal(STATES.length, 51);
  for (const s of STATES) assert.ok(STATE_AREA[stateCode(s)], s);
  assert.throws(() => stateCode('atlantis'));
});

const rows = (period, skip = '') => Object.values(STATE_AREA).filter((a, i, all) => all.indexOf(a) === i)
  .flatMap((a) => ['EPD2D', 'EPMR'].map((product) => ({ period, duoarea: a, product, value: product === 'EPD2D' ? '6.1' : '4.2' })))
  .filter((r) => `${r.duoarea} ${r.product}` !== skip);

test('packs the newest week', () => {
  const fuel = packFuel([...rows('2026-10-05'), ...rows('2026-10-12')]);
  assert.equal(fuel.weekOf, '2026-10-12');
  assert.deepEqual(fuel.areas.R20, { diesel: 6.1, regular: 4.2 });
  assert.equal(fuel.states.TX, 'R30');
});

test('refuses a week with a region missing, so last week stays live', () => {
  assert.throws(() => packFuel([...rows('2026-10-05'), ...rows('2026-10-12', 'R30 EPD2D')]), /R30 diesel/);
});
