import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { toPlace, packPlaces, placeKey } from '../pois.mjs';

const at = (tags, geometry = { type: 'Point', coordinates: [-117.16, 32.71] }) => ({ type: 'Feature', geometry, properties: { '@id': 'n1', ...tags } });

test('classifies what a trucker searches for', () => {
  assert.equal(toPlace(at({ highway: 'services', name: 'TA' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'fuel', brand: "Love's" })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'fuel', name: 'Corner Gas', 'fuel:HGV_diesel': 'yes' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'parking', hgv: 'designated' })).name, 'Truck Parking');
  assert.equal(toPlace(at({ amenity: 'fuel', brand: 'Chevron' })).kind, 'fuel');
  assert.equal(toPlace(at({ amenity: 'weighbridge', name: 'CAT Scale' })).scales, 1);
  assert.equal(toPlace(at({ highway: 'rest_area' })).kind, 'rest_area');
  assert.equal(toPlace(at({ amenity: 'parking' })), null); // a car park is not a stop
  // Truck-stop audit, 2026-10-24.
  assert.equal(toPlace(at({ amenity: 'fuel', name: "Buc-ee's" })).kind, 'fuel'); // cars only
  assert.equal(toPlace(at({ highway: 'services', name: "Buc-ee's" })).kind, 'fuel');
  assert.equal(toPlace(at({ amenity: 'fuel', name: 'Big Bear Truck Stop' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'fuel', name: 'Sunrise Travel Center' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'fuel', brand: 'Road Ranger' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'fuel', brand: 'Kwik Star' })).kind, 'fuel'); // no showers
  assert.equal(toPlace(at({ amenity: 'fuel', brand: 'Kwik Trip', shower: 'yes' })).kind, 'truck_stop');
  assert.equal(toPlace(at({ amenity: 'restaurant' })), null);
});

test('a building outline becomes one pin at its middle', () => {
  const ring = [[-117.2, 32.7], [-117.1, 32.7], [-117.1, 32.8], [-117.2, 32.8]];
  const p = toPlace(at({ amenity: 'fuel' }, { type: 'Polygon', coordinates: [ring] }));
  assert.deepEqual([p.lon, p.lat], [-117.15, 32.75]);
});

test('a place on a state border is kept once', () => {
  const line = JSON.stringify(toPlace(at({ amenity: 'fuel' })));
  const rows = JSON.parse(zlib.gunzipSync(packPlaces([line, line, ''])));
  assert.equal(rows.length, 1);
  assert.equal(placeKey(32.71, -117.16), '65_-235');
});

test('an unnamed truck stop takes its site\'s name, or says what it is', async () => {
  const { nameUnnamedStops } = await import('../pois.mjs');
  const row = (o) => ({ kind: 'truck_stop', cat: 'truck_stop', name: '', fuel: 1, diesel: 1, showers: 0, food: 0, scales: 0,
    hours: null, phone: null, addr: null, ...o });
  const shell = row({ id: 'shell', kind: 'fuel', cat: 'fuel', name: 'Shell', diesel: 0, addr: '1 Main St', lat: 40, lon: -100 });
  const island = row({ id: 'island', lat: 40.0005, lon: -100 }); // ~56 m away
  const island2 = row({ id: 'island2', lat: 40.0007, lon: -100 });
  const pilot = row({ id: 'pilot', name: 'Pilot', lat: 41, lon: -100 });
  const lot = row({ id: 'lot', lat: 41.0005, lon: -100, showers: 1 });
  const plaza = row({ id: 'plaza', diesel: 0, food: 1, lat: 42, lon: -100 });
  const lone = row({ id: 'lone', lat: 43, lon: -100 });
  const out = nameUnnamedStops([shell, island, island2, pilot, lot, plaza, lone]);
  assert.deepEqual(out.map((r) => [r.id, r.name]), [['island', 'Shell'], ['pilot', 'Pilot'], ['plaza', 'Service Area'], ['lone', 'Truck Fuel']]);
  assert.equal(out[0].addr, '1 Main St');
  assert.equal(out[1].showers, 1);
});

test('an unnamed service area away from any freeway is left out', async () => {
  const { isStrayServices, roadGrid } = await import('../pois.mjs');
  const grid = roadGrid([Array.from({ length: 21 }, (_, i) => [-117.2 + i * 0.01, 32.786])]); // a freeway, mapped in short segments
  const services = (lat, extra = {}) => ({ cat: 'truck_stop', name: '', diesel: 0, lat, lon: -117.1, ...extra });
  assert.equal(isStrayServices(services(32.7865), grid), false); // ~55 m from the freeway
  assert.equal(isStrayServices(services(32.80), grid), true); // ~1.5 km
  assert.equal(isStrayServices(services(32.80, { name: 'TA' }), grid), false);
  assert.equal(isStrayServices(services(32.80, { diesel: 1 }), grid), false); // truck diesel says it is a stop
});
