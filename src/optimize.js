// Stop-order optimiser for one rider: start at the hub, visit every stop once,
// finish at the last stop (no return trip).
//
// It respects optional time windows (arrive early -> wait; arrive late -> heavy
// penalty) and priority stops (pushed earlier). Method: nearest-neighbour start,
// then local search (2-opt, moving 1-3 stop segments, swaps), repeated with
// small random shake-ups while there is time left (iterated local search).
// Not guaranteed perfect, but for 25-50 stops it lands very close.

const LATE_PENALTY = 20;      // cost per second late (1 min late ~ 20 min of riding)
const PRIORITY_WEIGHT = 1;    // each second a priority stop is delayed costs like a second of riding

/**
 * @param {number[][]} durations  seconds, index 0 = hub, 1..n = stops
 * @param {Array<{service?:number, window?:{start:number,end:number}|null, priority?:boolean}>} stops  length n
 * @param {object} opts  departure (seconds since midnight), timeLimitMs, seed
 * @returns {{order:number[], schedule:object[], cost:number, finish:number, lateCount:number}}
 *          order lists stop indexes 0..n-1 (not matrix indexes)
 */
export function optimizeRoute(durations, stops, { departure = 0, timeLimitMs = 400, maxRounds = 5000, seed = 1 } = {}) {
  const n = stops.length;
  if (n === 0) return { order: [], schedule: [], cost: 0, finish: departure, lateCount: 0 };
  const rand = mulberry32(seed);
  const cost = (order) => evaluate(durations, stops, order, departure).cost;

  let best = localSearch(nearestNeighbour(durations, n), cost);
  let bestCost = cost(best);
  if (n <= 3) return finish(best);

  const deadline = now() + timeLimitMs;
  let current = best, currentCost = bestCost;
  for (let round = 0; round < maxRounds && now() < deadline; round++) {
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
    const ev = evaluate(durations, stops, order, departure);
    return { order, ...ev };
  }
}

// Walk the route and compute arrival times, waiting, lateness and cost.
export function evaluate(durations, stops, order, departure = 0) {
  let t = departure, prev = 0, cost = 0, lateCount = 0, travel = 0;
  const schedule = [];
  for (const i of order) {
    const s = stops[i];
    const leg = durations[prev][i + 1];
    travel += leg;
    let arrive = t + leg;
    let wait = 0, late = 0;
    if (s.window) {
      if (arrive < s.window.start) { wait = s.window.start - arrive; }
      else if (arrive > s.window.end) { late = arrive - s.window.end; lateCount++; }
    }
    const start = arrive + wait;
    t = start + (s.service || 0);
    cost += late * LATE_PENALTY;
    if (s.priority) cost += (start - departure) * PRIORITY_WEIGHT;
    schedule.push({ stop: i, arrive, start, wait, late, leave: t, leg });
    prev = i + 1;
  }
  cost += t - departure; // total time until the last stop is done
  return { schedule, cost, finish: t, lateCount, travel };
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

// First-improvement local search over three neighbourhoods until no move helps.
function localSearch(order, cost) {
  let cur = order.slice(), curCost = cost(cur);
  const n = cur.length;
  let improved = true;
  while (improved) {
    improved = false;
    // 2-opt: reverse cur[i..j]
    for (let i = 0; i < n - 1 && !improved; i++) for (let j = i + 1; j < n; j++) {
      const cand = cur.slice(0, i).concat(cur.slice(i, j + 1).reverse(), cur.slice(j + 1));
      const c = cost(cand);
      if (c < curCost - 1e-9) { cur = cand; curCost = c; improved = true; break; }
    }
    if (improved) continue;
    // or-opt: move a segment of 1-3 stops elsewhere
    for (let len = 1; len <= 3 && !improved; len++) for (let i = 0; i + len <= n && !improved; i++) {
      const seg = cur.slice(i, i + len);
      const rest = cur.slice(0, i).concat(cur.slice(i + len));
      for (let k = 0; k <= rest.length; k++) {
        if (k === i) continue;
        const cand = rest.slice(0, k).concat(seg, rest.slice(k));
        const c = cost(cand);
        if (c < curCost - 1e-9) { cur = cand; curCost = c; improved = true; break; }
      }
    }
    if (improved) continue;
    // swap two stops
    for (let i = 0; i < n - 1 && !improved; i++) for (let j = i + 1; j < n; j++) {
      const cand = cur.slice();
      [cand[i], cand[j]] = [cand[j], cand[i]];
      const c = cost(cand);
      if (c < curCost - 1e-9) { cur = cand; curCost = c; improved = true; break; }
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

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
