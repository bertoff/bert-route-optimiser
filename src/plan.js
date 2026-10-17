// Turns the stop list into an optimised plan: groups envelopes going to the
// same building, builds the travel-time table, runs the optimiser. The table
// and stop details are kept in the plan ("model") so a hand-edited order can be
// re-timed instantly and compared fairly with a fresh optimisation.

import { getMatrix, haversine, sameCondoHops, entranceKey } from './matrix.js';
import { optimizeRoute, evaluate } from './optimize.js';

// "09:30" <-> seconds since midnight
export const toSec = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
};
export const toHHMM = (sec) => {
  const s = Math.round(sec / 60) * 60;
  const h = Math.floor(s / 3600) % 24, m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const isPM = (w) => w.start >= 12 * 3600;
// a re-optimised order only replaces the current one when it saves at least this much
export const GENUINELY_FASTER_SEC = 60;

/**
 * Envelopes for the same postcode become one visit. Its window is the overlap
 * of the envelopes' windows (or the earliest-ending one if they don't overlap),
 * and it is a priority visit if any envelope is. When one building has both AM
 * and PM envelopes, all go in the AM visit: the PM ones are 0 m from an on-time
 * AM delivery, which the early-delivery rule allows.
 */
export function groupStops(stops, serviceSecPerEnvelope) {
  const byCode = new Map();
  for (const s of stops) {
    if (!s.place) continue;
    if (!byCode.has(s.postcode)) byCode.set(s.postcode, { postcode: s.postcode, place: s.place, envelopes: [] });
    byCode.get(s.postcode).envelopes.push(s);
  }
  return [...byCode.values()].map((v) => {
    let wins = v.envelopes.filter((e) => e.from || e.to).map((e) => ({ start: toSec(e.from) ?? 0, end: toSec(e.to) ?? 86400 }));
    if (wins.some(isPM) && wins.some((w) => !isPM(w))) wins = wins.filter((w) => !isPM(w));
    let window = null;
    if (wins.length) {
      const start = Math.max(...wins.map((w) => w.start)), end = Math.min(...wins.map((w) => w.end));
      window = start <= end ? { start, end } : wins.sort((a, b) => a.end - b.end)[0];
    }
    return {
      ...v,
      window,
      earlyOk: !!window && isPM(window),
      priority: v.envelopes.some((e) => e.priority),
      service: serviceSecPerEnvelope * v.envelopes.length,
    };
  });
}

// PM visits may go early when within `meters` (straight line) of another visit
// that is delivered on time; which of those are on time is settled per route.
export function findAnchors(visits, meters) {
  visits.forEach((v, i) => {
    v.anchors = v.earlyOk
      ? visits.map((_, j) => j).filter((j) => j !== i && haversine(v.place, visits[j].place) <= meters)
      : [];
  });
  return visits;
}

/** Times, lateness and distance for visiting the model's nodes in `order`. */
export function retime(model, order) {
  const ev = evaluate(model.durations, model.nodes, order, model.departure, model.endIndex);
  let prev = 0, distance = 0;
  const times = ev.schedule.map((s) => {
    distance += model.distances[prev][s.stop + 1];
    prev = s.stop + 1;
    return { node: s.stop, arrive: s.arrive, start: s.start, wait: s.wait, late: s.late, early: s.early };
  });
  if (model.endIndex != null) distance += model.distances[prev][model.endIndex];
  return { times, finish: ev.finish, endArrive: ev.endArrive, lateCount: ev.lateCount, distance, cost: ev.cost };
}

/**
 * @param start  {lat,lng} where the run begins
 * @param end    null = finish at the last stop; or { place: {lat,lng,...}, label } to ride on to
 * @param earlyMeters  how close a PM stop must be to an on-time stop to be delivered early
 * @param currentOrder  postcodes in the order currently shown; if it covers the same
 *                      stops, the new order only replaces it when genuinely faster
 * @param entrances  gates the rider saved: { entranceKey(place): {lat, lng} }
 */
export async function buildPlan({ start, end = null, stops, departureSec, serviceMin = 2, earlyMeters = 500, currentOrder = null, entrances = {}, providerId = 'osrm' }) {
  const visits = findAnchors(groupStops(stops, serviceMin * 60), earlyMeters);
  if (!visits.length) throw new Error('No stops with a valid address yet.');
  const withGate = (p) => (p && entrances[entranceKey(p)] ? { ...p, entrance: entrances[entranceKey(p)] } : p);
  const points = [start, ...visits.map((v) => v.place), ...(end ? [end.place] : [])].map(withGate);
  const endIndex = end ? points.length - 1 : null;
  const matrix = sameCondoHops(await getMatrix(points, providerId), points);
  const model = {
    durations: matrix.durations, distances: matrix.distances, departure: departureSec, endIndex,
    nodes: visits.map((v) => ({ postcode: v.postcode, service: v.service, window: v.window, priority: v.priority, earlyOk: v.earlyOk, anchors: v.anchors })),
  };
  const result = optimizeRoute(model.durations, model.nodes, { departure: departureSec, endIndex });
  let order = result.order, comparison = null;

  const index = new Map(visits.map((v, i) => [v.postcode, i]));
  if (currentOrder && currentOrder.length === visits.length && currentOrder.every((pc) => index.has(pc)) && new Set(currentOrder).size === visits.length) {
    const mine = currentOrder.map((pc) => index.get(pc));
    const old = retime(model, mine), fresh = retime(model, order);
    // decide on the optimiser's score (time + lateness + priority); report real minutes
    const report = { savedSec: old.endArrive - fresh.endArrive, lateFixed: old.lateCount - fresh.lateCount };
    if (old.cost - fresh.cost >= GENUINELY_FASTER_SEC) comparison = { switched: true, ...report };
    else { order = mine; comparison = { switched: false, ...report }; }
  }

  const t = retime(model, order);
  const ordered = t.times.map((s, k) => ({ ...visits[s.node], node: s.node, seq: k + 1, arrive: s.arrive, start: s.start, wait: s.wait, late: s.late, early: s.early }));
  return {
    visits: ordered,
    model,
    departure: departureSec,
    finish: t.finish,
    end: end ? { ...end, arrive: t.endArrive } : null,
    lateCount: t.lateCount,
    distance: t.distance,
    matrixSource: matrix.source,
    start,
    comparison,
  };
}
