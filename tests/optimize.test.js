import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optimizeRoute, evaluate } from '../src/optimize.js';
import { groupStops, toSec, toHHMM } from '../src/plan.js';

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
    const r = optimizeRoute(d, stops, { seed: trial + 1, timeLimitMs: 200 });
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
  const r = optimizeRoute(d, stops, { timeLimitMs: 300 });
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
