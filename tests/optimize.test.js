import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeRoute, evaluate } from '../src/optimize.js';
import { groupStops, findAnchors, retime, buildPlan, toSec, toHHMM } from '../src/plan.js';
import { providers } from '../src/matrix.js';

// Matrix from 1-D positions: travel time = distance (index 0 = hub)
const lineMatrix = (positions) => positions.map((a) => positions.map((b) => Math.abs(a - b)));

function bruteForce(d, stops, departure = 0) {
  const n = stops.length;
  let best = Infinity;
  const perm = (arr, used) => {
    if (arr.length === n) { best = Math.min(best, evaluate(d, stops, arr, departure).cost); return; }
    for (let i = 0; i < n; i++) if (!used[i]) { used[i] = true; arr.push(i); perm(arr, used); arr.pop(); used[i] = false; }
  };
  perm([], []);
  return best;
}

test('empty and single stop', () => {
  assert.deepEqual(optimizeRoute([[0]], []).order, []);
  assert.deepEqual(optimizeRoute([[0, 5], [5, 0]], [{}]).order, [0]);
});

test('stops along one road are visited in road order (open route, no return)', () => {
  // hub at 0; stops at 30, 10, 50, 20, 40
  const d = lineMatrix([0, 30, 10, 50, 20, 40]);
  const r = optimizeRoute(d, [{}, {}, {}, {}, {}], { seed: 3 });
  assert.deepEqual(r.order, [1, 3, 0, 4, 2]); // 10,20,30,40,50
  assert.equal(r.finish, 50);
});

test('matches brute force on random asymmetric matrices (7 stops)', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 15; trial++) {
    const n = 7;
    const d = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i === j ? 0 : Math.round(60 + rnd() * 900))));
    const stops = Array.from({ length: n }, () => ({ service: 120 }));
    const r = optimizeRoute(d, stops, { seed: trial + 1 });
    assert.equal(Math.round(r.cost), Math.round(bruteForce(d, stops)), `trial ${trial}`);
  }
});

test('time window pulls a far stop earlier when it would otherwise be late', () => {
  // hub 0; A at 10, B at 20, C at 100; 30s handover each. Going A,B,C reaches C at 160.
  const d = lineMatrix([0, 10, 20, 100]);
  const free = optimizeRoute(d, [{ service: 30 }, { service: 30 }, { service: 30 }]);
  assert.deepEqual(free.order, [0, 1, 2]);
  const r = optimizeRoute(d, [{ service: 30 }, { service: 30 }, { service: 30, window: { start: 0, end: 105 } }]);
  assert.equal(r.order[0], 2, 'C first');
  assert.equal(r.lateCount, 0);
});

test('waits when arriving before a window opens', () => {
  const d = lineMatrix([0, 10]);
  const r = optimizeRoute(d, [{ window: { start: 100, end: 200 }, service: 5 }]);
  assert.equal(r.schedule[0].wait, 90);
  assert.equal(r.finish, 105);
});

test('priority stop is moved earlier', () => {
  // hub at 0; stops at 10, 20, 30 (west) and 15 east (-15)
  const d = lineMatrix([0, 10, 20, 30, -15]);
  const plain = optimizeRoute(d, [{}, {}, {}, {}]);
  assert.equal(plain.order[0], 3, 'nearest east stop first anyway');
  const pri = optimizeRoute(d, [{}, {}, { priority: true }, {}]);
  assert.ok(pri.order.indexOf(2) < plain.order.indexOf(2), 'priority stop earlier than without priority');
});

test('40 stops finish quickly and beat nearest-neighbour or equal it', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = Array.from({ length: 41 }, () => [rnd() * 5000, rnd() * 5000]);
  const d = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 8));
  const stops = Array.from({ length: 40 }, () => ({ service: 90 }));
  const t0 = Date.now();
  const r = optimizeRoute(d, stops);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(new Set(r.order).size, 40);
  // nearest-neighbour baseline
  const left = new Set(stops.map((_, i) => i)); const nn = []; let at = 0;
  while (left.size) { let p = -1, b = Infinity; for (const i of left) if (d[at][i + 1] < b) { b = d[at][i + 1]; p = i; } nn.push(p); left.delete(p); at = p + 1; }
  assert.ok(r.cost <= evaluate(d, stops, nn).cost);
});

test('groupStops merges envelopes for one building', () => {
  const place = { lat: 1, lng: 2 };
  const g = groupStops([
    { postcode: '260008', place, from: '09:00', to: '12:00' },
    { postcode: '260008', place, from: '10:00', to: '13:00', priority: true },
    { postcode: '266477', place },
    { postcode: '999999', place: null },
  ], 120);
  assert.equal(g.length, 2);
  assert.equal(g[0].envelopes.length, 2);
  assert.deepEqual(g[0].window, { start: toSec('10:00'), end: toSec('12:00') });
  assert.equal(g[0].priority, true);
  assert.equal(g[0].service, 240);
  assert.equal(g[1].window, null);
});

test('time helpers', () => {
  assert.equal(toSec('09:30'), 34200);
  assert.equal(toHHMM(34200), '09:30');
  assert.equal(toSec(''), null);
});

test('AM and PM envelopes for one building all go in the AM slot (PM is 0 m from an on-time AM delivery)', () => {
  const place = { lat: 1, lng: 2 };
  const [g] = groupStops([
    { postcode: '260008', place, from: '09:00', to: '13:30' },
    { postcode: '260008', place, from: '13:00', to: '18:00' },
  ], 120);
  assert.deepEqual(g.window, { start: toSec('09:00'), end: toSec('13:30') });
  assert.equal(g.earlyOk, false);
});

test('PM stops wait for 13:00 and AM stops come first', () => {
  // hub 0; PM stop right next to the hub, AM stop further away
  const d = lineMatrix([0, 60, 600]);
  const r = optimizeRoute(d, [
    { window: { start: toSec('13:00'), end: toSec('18:00') } },
    { window: { start: toSec('09:00'), end: toSec('13:30') } },
  ], { departure: toSec('09:00') });
  assert.deepEqual(r.order, [1, 0], 'AM stop first even though the PM stop is closer');
  assert.equal(r.lateCount, 0);
});

test('a fixed end point changes the best order (ride home after the last stop)', () => {
  // hub at 0, stops at -10 and +10, home at +50
  const d = lineMatrix([0, -10, 10, 50]);
  const open = optimizeRoute(d, [{}, {}]);
  assert.equal(open.endArrive, open.finish, 'open end: run ends at the last stop');
  const home = optimizeRoute(d, [{}, {}], { endIndex: 3 });
  assert.deepEqual(home.order, [0, 1], 'west stop first so the last stop is on the way home');
  assert.equal(home.finish, 30);
  assert.equal(home.endArrive, 70);
});

test('ending back at the hub makes a round trip', () => {
  const d = lineMatrix([0, 10, 20, 0]); // index 3 = hub again
  const r = optimizeRoute(d, [{}, {}], { endIndex: 3 });
  assert.equal(r.endArrive, 40);
});

const AM = { start: toSec('09:00'), end: toSec('13:30') }, PM = { start: toSec('13:00'), end: toSec('18:00') };

test('early delivery: a PM stop next to an on-time AM stop is delivered during the AM run', () => {
  // hub 0, AM stop at 600, PM stop at 610 (next door), all on one road
  const d = lineMatrix([0, 600, 610]);
  const stops = [{ window: AM, service: 60 }, { window: PM, service: 60, earlyOk: true, anchors: [0] }];
  const r = optimizeRoute(d, stops, { departure: toSec('09:00') });
  const pm = r.schedule.find((s) => s.stop === 1);
  assert.equal(pm.early, true);
  assert.equal(pm.wait, 0, 'no waiting until 13:00');
  assert.ok(pm.start < toSec('13:00'));
  assert.equal(r.lateCount, 0);
});

test('far PM stops still wait for 13:00', () => {
  const d = lineMatrix([0, 600, 5000]);
  const stops = [{ window: AM, service: 60 }, { window: PM, service: 60, earlyOk: true, anchors: [] }];
  const r = optimizeRoute(d, stops, { departure: toSec('09:00') });
  const pm = r.schedule.find((s) => s.stop === 1);
  assert.equal(pm.early, false);
  assert.equal(pm.start, toSec('13:00'));
});

test('early delivery is not chained through another early PM stop', () => {
  // PM stop B is near PM stop A only; A is near the AM stop. B must still wait.
  const d = lineMatrix([0, 600, 610, 620]);
  const stops = [
    { window: AM, service: 60 },
    { window: PM, service: 60, earlyOk: true, anchors: [0, 2] }, // A: near the AM stop
    { window: PM, service: 60, earlyOk: true, anchors: [1] },    // B: only near A
  ];
  const r = optimizeRoute(d, stops, { departure: toSec('09:00') });
  const a = r.schedule.find((s) => s.stop === 1), b = r.schedule.find((s) => s.stop === 2);
  assert.equal(a.early, true);
  assert.equal(b.early, false);
  assert.ok(b.start >= toSec('13:00'));
});

test('early PM deliveries never make an AM stop late', () => {
  // two PM stops next to the hub with long handovers, one far AM stop that only
  // makes 13:30 if gone to first
  // delivering both PM stops early first would get to the AM stop at 13:33 (3 min late)
  const d = lineMatrix([0, 10, 20, 14000]);
  const stops = [
    { window: PM, service: 1200, earlyOk: true, anchors: [2] },
    { window: PM, service: 1200, earlyOk: true, anchors: [2] },
    { window: AM, service: 60 },
  ];
  const r = optimizeRoute(d, stops, { departure: toSec('09:00') });
  assert.equal(r.lateCount, 0);
  assert.equal(r.schedule.find((x) => x.stop === 2).late, 0, 'AM stop on time');
  assert.ok(r.order.indexOf(2) < 2, 'not both PM stops before the AM stop');
});

test('findAnchors uses the distance setting (straight line)', () => {
  const v = (lat, window) => ({ place: { lat, lng: 103.8 }, window, earlyOk: window === PM });
  const visits = findAnchors([v(1.3000, AM), v(1.3030, PM), v(1.3100, PM)], 500); // ~330 m and ~1.1 km away
  assert.deepEqual(visits[1].anchors, [0]);
  assert.deepEqual(visits[2].anchors, []);
  assert.deepEqual(findAnchors([v(1.3000, AM), v(1.3100, PM)], 2000)[1].anchors, [0]);
});

test('same stops and settings always give the same route', () => {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pts = Array.from({ length: 26 }, () => [rnd() * 5000, rnd() * 5000]);
  const d = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]) / 8));
  const stops = Array.from({ length: 25 }, (_, i) => ({ service: 90, window: i % 4 ? PM : AM }));
  const a = optimizeRoute(d, stops, { departure: toSec('09:00') }), b = optimizeRoute(d, stops, { departure: toSec('09:00') });
  assert.deepEqual(a.order, b.order);
});

test('retime gives live ETAs for a hand-edited order', () => {
  const model = { durations: lineMatrix([0, 10, 20]), distances: lineMatrix([0, 10, 20]), departure: 0, endIndex: null,
    nodes: [{ service: 5 }, { service: 5 }] };
  const a = retime(model, [0, 1]), b = retime(model, [1, 0]);
  assert.deepEqual(a.times.map((t) => t.start), [10, 25]);
  assert.deepEqual(b.times.map((t) => t.start), [20, 35]);
  assert.equal(b.distance, 30);
});

test('re-optimising keeps the current order unless the new one is genuinely faster', async () => {
  // fake travel-time service: positions along one road (seconds)
  const pos = { 0: 0, 1: 100, 2: 200, 3: 300 };
  providers.fake = { matrix: async (pts) => { const xs = pts.map((p) => pos[p.id]); const m = xs.map((a) => xs.map((b) => Math.abs(a - b))); return { durations: m, distances: m, source: 'fake' }; } };
  const place = (id) => ({ id, lat: 1, lng: 2 });
  const stops = ['1', '2', '3'].map((id) => ({ postcode: id, place: place(id) }));
  const base = { start: place('0'), stops, departureSec: 0, serviceMin: 0, providerId: 'fake' };
  const good = await buildPlan({ ...base, currentOrder: ['1', '2', '3'] });
  assert.equal(good.comparison.switched, false, 'already the best: kept');
  assert.deepEqual(good.visits.map((v) => v.postcode), ['1', '2', '3']);
  const bad = await buildPlan({ ...base, currentOrder: ['3', '1', '2'] });
  assert.equal(bad.comparison.switched, true);
  assert.ok(bad.comparison.savedSec >= 60);
  assert.deepEqual(bad.visits.map((v) => v.postcode), ['1', '2', '3']);
  Object.assign(pos, { 1: 100, 2: 110, 3: 120 });
  const close = await buildPlan({ ...base, currentOrder: ['1', '3', '2'] }); // only ~20 s slower
  assert.equal(close.comparison.switched, false, 'not genuinely faster: kept');
  assert.deepEqual(close.visits.map((v) => v.postcode), ['1', '3', '2']);
  delete providers.fake;
});

test('an afternoon (on-time PM) delivery does not allow early delivery in the morning', () => {
  // two PM stops next door to each other, no AM stops: nobody is on time before 13:00, so both wait
  const d = lineMatrix([0, 600, 610]);
  const stops = [{ window: PM, service: 60, earlyOk: true, anchors: [1] }, { window: PM, service: 60, earlyOk: true, anchors: [0] }];
  const r = optimizeRoute(d, stops, { departure: toSec('09:00') });
  assert.ok(r.schedule.every((x) => !x.early && x.start >= toSec('13:00')));
});
