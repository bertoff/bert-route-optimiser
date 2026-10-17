// Stop-order optimiser for one rider: start at the hub, visit every stop once,
// then either finish at the last stop (open end) or ride on to a chosen end
// point (back to the hub, or home).
//
// It respects time windows (arrive early -> wait; arrive late -> a penalty so
// heavy that lateness only happens when it can't be avoided) and priority stops
// (pushed earlier). Early delivery: a PM stop may be served before its window
// opens when it's close to a stop that is being delivered on time (see
// `anchors`); far PM stops still wait.
//
// Method: nearest-neighbour start, then local search (2-opt, moving 1-3 stop
// segments, swaps), repeated with small shake-ups (iterated local search).
// The shake-ups use a seeded random generator and a fixed number of rounds, so
// the same stops and settings always give the same route.

const LATE_PENALTY = 1000;    // cost per second late: windows are kept unless impossible
const PRIORITY_WEIGHT = 1;    // each second a priority stop is delayed costs like a second of riding

/**
 * @param {number[][]} durations  seconds, index 0 = hub, 1..n = stops
 * @param {Array<{service?:number, window?:{start:number,end:number}|null, priority?:boolean,
 *                 earlyOk?:boolean, anchors?:number[]}>} stops  length n. earlyOk + anchors: this
 *                 stop may be served before its window if one of the anchor stops (indexes into
 *                 `stops`) is delivered on time; anchors are not chained through other early stops.
 * @param {object} opts  departure (seconds since midnight), endIndex (matrix index of a
 *                       fixed end point, or null for an open end), rounds, seed
 * @returns {{order:number[], schedule:object[], cost:number, finish:number, endArrive:number, lateCount:number}}
 *          order lists stop indexes 0..n-1 (not matrix indexes); finish = last stop done,
 *          endArrive = arrival at the end point (same as finish for an open end)
 */
export function optimizeRoute(durations, stops, { departure = 0, endIndex = null, rounds = null, seed = 1 } = {}) {
  const n = stops.length;
  if (n === 0) {
    const endArrive = endIndex == null ? departure : departure + durations[0][endIndex];
    return { order: [], schedule: [], cost: endArrive - departure, finish: departure, endArrive, lateCount: 0, travel: 0 };
  }
  const rand = mulberry32(seed);
  const cost = (order) => evaluate(durations, stops, order, departure, endIndex).cost;

  let best = localSearch(nearestNeighbour(durations, n), cost);
  let bestCost = cost(best);
  if (n <= 3) return finish(best);

  // fixed amount of work (not a time limit), so a slower phone gives the same answer
  const totalRounds = rounds ?? defaultRounds(n);
  let current = best, currentCost = bestCost;
  for (let round = 0; round < totalRounds; round++) {
    const shaken = rand() < 0.5 ? doubleBridge(current, rand) : ruinAndRecreate(current, rand, cost);
    const candidate = localSearch(shaken, cost);
    const c = cost(candidate);
    // accept small worsenings too, so the search can climb out of a dead end
    if (c < currentCost * 1.02) { current = candidate; currentCost = c; }
    if (c < bestCost - 1e-9) { best = candidate; bestCost = c; }
    else if (rand() < 0.05) { current = best; currentCost = bestCost; } // occasionally restart from best
  }
  return finish(best);

  function finish(order) {
    const ev = evaluate(durations, stops, order, departure, endIndex);
    return { order, ...ev };
  }
}

// measured: beyond ~40 rounds routes for 30-45 stops stopped improving; small runs get more (cheap)
export const defaultRounds = (n) => Math.max(40, Math.min(200, Math.round(1500 / Math.max(1, n))));

// Walk the route and compute arrival times, waiting, lateness and cost.
// Early PM delivery is settled in a few passes: first every PM stop with a
// nearby anchor may go early; then only those whose anchor actually ended up
// delivered on time during the AM run (before this stop's window opens) keep
// that permission. Anchors never chain through early stops.
export function evaluate(durations, stops, order, departure = 0, endIndex = null) {
  let allow = new Set(order.filter((i) => stops[i].earlyOk && stops[i].anchors?.length));
  if (!allow.size) return walk(durations, stops, order, departure, endIndex, allow);
  let res = walk(durations, stops, order, departure, endIndex, allow);
  for (let pass = 0; pass < 6; pass++) {
    const next = new Set([...allow].filter((i) => stops[i].anchors.some((j) => res.onTime.has(j) && res.onTime.get(j) < stops[i].window.start)));
    if (next.size === allow.size) break;
    allow = next;
    res = walk(durations, stops, order, departure, endIndex, allow);
  }
  return res;
}

function walk(durations, stops, order, departure, endIndex, allowEarly) {
  let t = departure, prev = 0, cost = 0, lateCount = 0, travel = 0;
  const schedule = [], onTime = new Map(); // stop -> time its delivery started
  for (const i of order) {
    const s = stops[i];
    const leg = durations[prev][i + 1];
    travel += leg;
    let arrive = t + leg;
    let wait = 0, late = 0, early = false;
    if (s.window) {
      if (arrive < s.window.start) {
        if (allowEarly.has(i)) early = true; // nearby an on-time stop: deliver now, no limit on how early
        else wait = s.window.start - arrive;
      } else if (arrive > s.window.end) { late = arrive - s.window.end; lateCount++; }
    }
    const start = arrive + wait;
    if (!early && !late) onTime.set(i, start);
    t = start + (s.service || 0);
    cost += late * LATE_PENALTY;
    if (s.priority) cost += (start - departure) * PRIORITY_WEIGHT;
    schedule.push({ stop: i, arrive, start, wait, late, early, leave: t, leg });
    prev = i + 1;
  }
  // ride on to the chosen end point, if any
  const endLeg = endIndex == null ? 0 : durations[prev][endIndex];
  const endArrive = t + endLeg;
  travel += endLeg;
  cost += endArrive - departure; // total time until the run is over
  return { schedule, cost, finish: t, endArrive, endLeg, lateCount, travel, onTime };
}

function nearestNeighbour(d, n) {
  const left = new Set(Array.from({ length: n }, (_, i) => i));
  const order = [];
  let at = 0;
  while (left.size) {
    let pick = -1, bestD = Infinity;
    for (const i of left) if (d[at][i + 1] < bestD) { bestD = d[at][i + 1]; pick = i; }
    order.push(pick); left.delete(pick); at = pick + 1;
  }
  return order;
}

// Local search over three neighbourhoods until a full sweep finds no better
// move. Improvements are taken on the spot and the sweep carries on (instead
// of starting over), which gives the same kind of result with far less work.
function localSearch(order, cost) {
  let cur = order.slice(), curCost = cost(cur);
  const n = cur.length;
  const tryCand = (cand) => {
    const c = cost(cand);
    if (c < curCost - 1e-9) { cur = cand; curCost = c; return true; }
    return false;
  };
  let improved = true;
  while (improved) {
    improved = false;
    // 2-opt: reverse cur[i..j]
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      if (tryCand(cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1)))) improved = true;
    }
    // or-opt: move a segment of 1-3 stops elsewhere
    for (let len = 1; len <= 3; len++) for (let i = 0; i + len <= n; i++) {
      const seg = cur.slice(i, i + len), rest = cur.slice(0, i).concat(cur.slice(i + len));
      for (let k = 0; k <= rest.length; k++) {
        if (k === i) continue;
        if (tryCand(rest.slice(0, k).concat(seg, rest.slice(k)))) { improved = true; break; }
      }
    }
    // swap two stops
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      const cand = cur.slice();
      [cand[i], cand[j]] = [cand[j], cand[i]];
      if (tryCand(cand)) improved = true;
    }
  }
  return cur;
}

// Shake-up 1 (double bridge): cut the route in 4 pieces and reconnect as A C B D.
function doubleBridge(order, rand) {
  const n = order.length;
  const [p, q, r] = [0, 0, 0].map(() => Math.floor(rand() * (n + 1))).sort((a, b) => a - b);
  return order.slice(0, p).concat(order.slice(q, r), order.slice(p, q), order.slice(r));
}

// Shake-up 2 (ruin and recreate): pull out a few random stops, then put each
// back wherever it costs least.
function ruinAndRecreate(order, rand, cost) {
  const k = Math.min(order.length - 1, 2 + Math.floor(rand() * Math.max(2, order.length / 6)));
  let route = order.slice();
  const removed = [];
  for (let i = 0; i < k; i++) removed.push(route.splice(Math.floor(rand() * route.length), 1)[0]);
  for (const stop of removed) {
    let bestPos = 0, bestC = Infinity;
    for (let pos = 0; pos <= route.length; pos++) {
      const c = cost(route.slice(0, pos).concat(stop, route.slice(pos)));
      if (c < bestC) { bestC = c; bestPos = pos; }
    }
    route.splice(bestPos, 0, stop);
  }
  return route;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

