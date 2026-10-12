// Travel times between points. Swappable "providers" so a paid service
// (Google, Mapbox) can be added later without touching the rest of the app.
//
// Default: the free public OSRM server (OpenStreetMap roads, car profile;
// there is no motorbike profile, so times are a little cautious for a bike).
// It is a shared demo server, so we make one request per optimisation. If it
// is down, we fall back to straight-line estimates so the app still works.

const OSRM = 'https://router.project-osrm.org';

export const providers = {
  osrm: {
    label: 'OpenStreetMap (free)',
    async matrix(points, fetchImpl = fetch) {
      const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
      const res = await fetchImpl(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`);
      if (!res.ok) throw new Error(`OSRM error ${res.status}`);
      const json = await res.json();
      if (json.code !== 'Ok') throw new Error(`OSRM: ${json.message || json.code}`);
      return { durations: json.durations, distances: json.distances, source: 'osrm' };
    },
    async geometry(points, fetchImpl = fetch) {
      const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
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

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
