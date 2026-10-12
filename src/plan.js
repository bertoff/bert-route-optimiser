// Turns the stop list into an optimised plan: groups envelopes going to the
// same building, builds the travel-time table, runs the optimiser.

import { getMatrix } from './matrix.js';
import { optimizeRoute } from './optimize.js';

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

/**
 * Envelopes for the same postcode become one visit. Its window is the overlap
 * of the envelopes' windows (or the earliest-ending one if they don't overlap),
 * and it is a priority visit if any envelope is.
 */
export function groupStops(stops, serviceSecPerEnvelope) {
  const byCode = new Map();
  for (const s of stops) {
    if (!s.place) continue;
    if (!byCode.has(s.postcode)) byCode.set(s.postcode, { postcode: s.postcode, place: s.place, envelopes: [] });
    byCode.get(s.postcode).envelopes.push(s);
  }
  return [...byCode.values()].map((v) => {
    const wins = v.envelopes.filter((e) => e.from || e.to).map((e) => ({ start: toSec(e.from) ?? 0, end: toSec(e.to) ?? 86400 }));
    let window = null;
    if (wins.length) {
      const start = Math.max(...wins.map((w) => w.start)), end = Math.min(...wins.map((w) => w.end));
      window = start <= end ? { start, end } : wins.sort((a, b) => a.end - b.end)[0];
    }
    return {
      ...v,
      window,
      priority: v.envelopes.some((e) => e.priority),
      service: serviceSecPerEnvelope * v.envelopes.length,
    };
  });
}

/**
 * @param start  {lat,lng} where the run begins
 * @param end    null = finish at the last stop; or { place: {lat,lng,...}, label } to ride on to
 */
export async function buildPlan({ start, end = null, stops, departureSec, serviceMin = 2, providerId = 'osrm' }) {
  const visits = groupStops(stops, serviceMin * 60);
  if (!visits.length) throw new Error('No stops with a valid address yet.');
  const points = [start, ...visits.map((v) => v.place), ...(end ? [end.place] : [])];
  const endIndex = end ? points.length - 1 : null;
  const matrix = await getMatrix(points, providerId);
  const result = optimizeRoute(matrix.durations, visits, { departure: departureSec, endIndex, timeLimitMs: 600 });
  const ordered = result.schedule.map((s, k) => ({
    ...visits[s.stop],
    seq: k + 1,
    arrive: s.arrive, start: s.start, wait: s.wait, late: s.late, leave: s.leave,
    legDistance: matrix.distances[k === 0 ? 0 : result.schedule[k - 1].stop + 1][s.stop + 1],
  }));
  const lastIdx = result.schedule[result.schedule.length - 1].stop + 1;
  const endDistance = end ? matrix.distances[lastIdx][endIndex] : 0;
  return {
    visits: ordered,
    departure: departureSec,
    finish: result.finish,
    end: end ? { ...end, arrive: result.endArrive, legDistance: endDistance } : null,
    lateCount: result.lateCount,
    distance: ordered.reduce((sum, v) => sum + (v.legDistance || 0), 0) + endDistance,
    matrixSource: matrix.source,
    start,
  };
}
