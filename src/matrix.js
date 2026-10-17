// Travel times between points. Swappable "providers" so a paid service
// (Google, Mapbox) can be added later without touching the rest of the app.
//
// Default: the free public OSRM server (OpenStreetMap roads, car profile;
// there is no motorbike profile, so times are a little cautious for a bike).
// It is a shared demo server (about one request a second at most), so we make
// one travel-time request per optimisation, plus a one-off lookup per new
// address (remembered on the phone). If it is down, we fall back to
// straight-line estimates so the app still works.

const OSRM = 'https://router.project-osrm.org';
// where to route to: a gate the rider saved > the building's own street > the building itself
export const routePoint = (p) => p.entrance || p.snap || p;
const coord = (p) => { const q = routePoint(p); return `${q.lng.toFixed(6)},${q.lat.toFixed(6)}`; };

// Gates are saved per condominium (all its blocks share one) or per address otherwise.
export const entranceKey = (place) => (place?.building && place.building !== 'NIL' ? `B:${place.building.toUpperCase().trim()}` : `P:${place?.postcode}`);

// ---- attach each building to its own street ----
// The map otherwise uses the closest road point, which can be the wrong road
// (e.g. a main road behind a condo instead of the street its gate is on), and
// that gets one-way loops backwards. We ask for nearby road points and use the
// closest one on the street OneMap gives for the address, if within 150 m.
const SNAP_KEY = 'ro.snap.v1';
let snapCache = null;
const loadSnaps = () => {
  if (snapCache) return snapCache;
  try { snapCache = JSON.parse(localStorage.getItem(SNAP_KEY)) || {}; } catch { snapCache = {}; }
  return snapCache;
};
const saveSnaps = () => { try { localStorage.setItem(SNAP_KEY, JSON.stringify(snapCache)); } catch { /* only a speed-up */ } };
let snapQueue = Promise.resolve(), lastSnap = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pickSnap(waypoints, road, maxMeters = 150) {
  const want = String(road || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!want) return null;
  const hit = waypoints.filter((w) => String(w.name || '').toUpperCase().replace(/\s+/g, ' ').trim() === want && w.distance <= maxMeters)
    .sort((a, b) => a.distance - b.distance)[0];
  return hit ? { lng: hit.location[0], lat: hit.location[1] } : null;
}

/** Looks up (once per address, then remembered) where a building meets its own street. */
export function snapPlace(place, fetchImpl = fetch) {
  if (!place?.postcode || !place.road) return Promise.resolve(null);
  const cache = loadSnaps();
  if (place.postcode in cache) return Promise.resolve(cache[place.postcode]);
  const run = snapQueue.then(async () => {
    if (place.postcode in cache) return cache[place.postcode];
    const wait = lastSnap + 1100 - Date.now(); // stay under the demo server's limit
    if (wait > 0) await sleep(wait);
    lastSnap = Date.now();
    try {
      const res = await fetchImpl(`${OSRM}/nearest/v1/driving/${place.lng.toFixed(6)},${place.lat.toFixed(6)}?number=40`);
      if (!res.ok) return null; // try again another time
      const json = await res.json();
      const snap = json.code === 'Ok' ? pickSnap(json.waypoints, place.road) : null;
      cache[place.postcode] = snap; saveSnaps();
      return snap;
    } catch { return null; }
  });
  snapQueue = run.catch(() => {});
  return run;
}
const withSnaps = async (points, fetchImpl) => Promise.all(points.map(async (p) => (p.entrance ? p : { ...p, snap: await snapPlace(p, fetchImpl) })));

export const providers = {
  osrm: {
    label: 'OpenStreetMap (free)',
    async matrix(points, fetchImpl = fetch) {
      const coords = (await withSnaps(points, fetchImpl)).map(coord).join(';');
      const res = await fetchImpl(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`);
      if (!res.ok) throw new Error(`OSRM error ${res.status}`);
      const json = await res.json();
      if (json.code !== 'Ok') throw new Error(`OSRM: ${json.message || json.code}`);
      return { durations: json.durations, distances: json.distances, source: 'osrm' };
    },
    async geometry(points, fetchImpl = fetch) {
      const coords = (await withSnaps(points, fetchImpl)).map(coord).join(';');
      const res = await fetchImpl(`${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson`);
      if (!res.ok) throw new Error(`OSRM error ${res.status}`);
      const json = await res.json();
      if (json.code !== 'Ok') throw new Error(`OSRM: ${json.message || json.code}`);
      return json.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    },
  },
};

// Straight-line fallback: distance x 1.4 (roads aren't straight) at ~30 km/h.
export function estimateMatrix(points) {
  const durations = [], distances = [];
  for (const a of points) {
    const drow = [], trow = [];
    for (const b of points) {
      const m = haversine(a, b) * 1.4;
      trow.push(m); drow.push(m / (30 / 3.6));
    }
    durations.push(drow); distances.push(trow);
  }
  return { durations, distances, source: 'estimate' };
}

export async function getMatrix(points, providerId = 'osrm') {
  try {
    return await providers[providerId].matrix(points);
  } catch (err) {
    console.warn('Travel-time service failed, using straight-line estimate', err);
    return estimateMatrix(points);
  }
}

// Blocks of the same condominium are reached through the condo's own carpark:
// a short hop (~30 s), never a lap of the public roads outside.
export const CONDO_HOP_SEC = 30;
export function sameCondoHops(matrix, points) {
  const condo = (p) => (p.building && p.building !== 'NIL' ? p.building.toUpperCase().trim() : '');
  const durations = matrix.durations.map((r) => r.slice()), distances = matrix.distances.map((r) => r.slice());
  for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) {
    if (i === j || !condo(points[i]) || condo(points[i]) !== condo(points[j])) continue;
    const d = haversine(points[i], points[j]);
    if (d > 400) continue; // same name but far apart: not the same estate
    if (durations[i][j] > CONDO_HOP_SEC) { durations[i][j] = CONDO_HOP_SEC; distances[i][j] = Math.min(distances[i][j], d * 1.3); }
  }
  return { ...matrix, durations, distances };
}

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
