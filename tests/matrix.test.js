import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSnap, sameCondoHops, routePoint, entranceKey, providers, CONDO_HOP_SEC } from '../src/matrix.js';
import { buildPlan } from '../src/plan.js';

test("pickSnap uses the building's own street, not just the closest road", () => {
  // like The Tapestry: closest road point is the main road behind it
  const waypoints = [
    { name: 'Main Avenue 10', distance: 54, location: [103.9278, 1.3533] },
    { name: 'Side Street 86', distance: 92, location: [103.9289, 1.3527] },
  ];
  assert.deepEqual(pickSnap(waypoints, 'SIDE STREET 86'), { lng: 103.9289, lat: 1.3527 });
  assert.equal(pickSnap(waypoints, 'NOWHERE ROAD'), null, 'street not nearby: keep the default');
  assert.equal(pickSnap([{ name: 'Side Street 86', distance: 400, location: [0, 0] }], 'SIDE STREET 86'), null, 'too far');
});

test('blocks of the same condo are a short hop through the carpark, never a lap outside', () => {
  const p = (building, lat) => ({ building, lat, lng: 103.928 });
  const points = [p('', 1.3500), p('THE SANTORINI', 1.3517), p('THE SANTORINI', 1.3523), p('THE TAPESTRY', 1.3530)];
  const lap = 110; // a one-way loop makes the road map think this takes ~2 min
  const m = { durations: points.map(() => points.map(() => lap)), distances: points.map(() => points.map(() => 1300)) };
  const out = sameCondoHops(m, points);
  assert.equal(out.durations[1][2], CONDO_HOP_SEC);
  assert.equal(out.durations[2][1], CONDO_HOP_SEC, 'both directions');
  assert.equal(out.durations[2][3], lap, 'a different condo still follows the roads');
  assert.equal(out.durations[0][1], lap);
});

test('a saved gate wins over the street point, which wins over the building', () => {
  const b = { lat: 1, lng: 2 };
  assert.equal(routePoint(b), b);
  assert.deepEqual(routePoint({ ...b, snap: { lat: 3, lng: 4 } }), { lat: 3, lng: 4 });
  assert.deepEqual(routePoint({ ...b, snap: { lat: 3, lng: 4 }, entrance: { lat: 5, lng: 6 } }), { lat: 5, lng: 6 });
  assert.equal(entranceKey({ building: 'The Santorini', postcode: '111111' }), 'B:THE SANTORINI', 'shared by all blocks');
  assert.equal(entranceKey({ building: '', postcode: '111111' }), 'P:111111');
});

test('route planning uses saved gates', async () => {
  let seen = null;
  providers.fakeGate = { matrix: async (pts) => { seen = pts; const m = pts.map(() => pts.map(() => 60)); return { durations: m, distances: m, source: 'fake' }; } };
  const place = { postcode: '111111', building: 'SAMPLE CONDO', lat: 1, lng: 2 };
  await buildPlan({ start: { lat: 0, lng: 0 }, stops: [{ postcode: '111111', place }], departureSec: 0, providerId: 'fakeGate',
    entrances: { 'B:SAMPLE CONDO': { lat: 9, lng: 9 } } });
  assert.deepEqual(seen[1].entrance, { lat: 9, lng: 9 });
  delete providers.fakeGate;
});
