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
