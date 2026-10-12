// Postal code -> building, via OneMap (Singapore Land Authority, free).
// Every Singapore building has its own 6-digit postal code, so one lookup
// gives the exact block. Results are cached because addresses don't change.

const ONEMAP = 'https://www.onemap.gov.sg/api/common/elastic/search';
const CACHE_KEY = 'ro.geocache.v1';

let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full or blocked: cache is only a speed-up */ }
}

// OneMap allows roughly 250 requests a minute and answers "429 Too Many
// Requests" beyond that, so requests go out one at a time with a small gap,
// and failed ones are retried with growing pauses.
const MIN_GAP_MS = 300;
let queue = Promise.resolve();
let lastRequest = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttledFetch(url, fetchImpl) {
  const run = queue.then(async () => {
    const wait = lastRequest + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    return fetchImpl(url);
  });
  queue = run.catch(() => {});
  return run;
}

async function fetchJsonWithRetry(url, fetchImpl, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await throttledFetch(url, fetchImpl);
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`OneMap error ${res.status}`), { fatal: true });
    } catch (err) {
      // a 429 without CORS headers shows up as a plain network error, so retry those too
      if (err.fatal || attempt >= retries) throw err;
    }
    if (attempt >= retries) throw new Error('OneMap is busy or unreachable');
    await sleep(1000 * 2 ** attempt);
  }
}

/**
 * @returns {Promise<{postcode,lat,lng,blk,road,building,address}|null>}
 *   null only when OneMap answered and has no such postcode.
 *   Throws when OneMap couldn't be reached (no signal, busy) so callers can retry.
 */
export async function lookupPostcode(postcode, fetchImpl = fetch) {
  const c = loadCache();
  if (postcode in c) return c[postcode];
  const url = `${ONEMAP}?searchVal=${postcode}&returnGeom=Y&getAddrDetails=Y&pageNum=1`;
  const json = await fetchJsonWithRetry(url, fetchImpl);
  if (!Array.isArray(json.results)) throw new Error(json.error || 'Unexpected OneMap reply');
  const hit = (json.results || []).find((r) => r.POSTAL === postcode);
  const value = hit ? {
    postcode,
    lat: Number(hit.LATITUDE),
    lng: Number(hit.LONGITUDE),
    blk: hit.BLK_NO,
    road: hit.ROAD_NAME,
    building: hit.BUILDING === 'NIL' ? '' : hit.BUILDING,
    address: hit.ADDRESS,
  } : null;
  c[postcode] = value;
  saveCache();
  return value;
}

// Does the text OCR'd on the sheet row mention this place's road or building?
// Uses a small edit-distance tolerance because OCR misreads letters too.
export function rowMatchesPlace(rowText, place) {
  if (!rowText || !place) return false;
  const rowWords = tokens(rowText);
  const placeWords = tokens(`${place.road} ${place.building}`).filter((w) => w.length >= 4 && !GENERIC.has(w));
  return placeWords.some((pw) => rowWords.some((rw) => editDistance(rw, pw) <= (pw.length >= 7 ? 2 : 1)));
}

const GENERIC = new Set(['ROAD', 'AVENUE', 'STREET', 'DRIVE', 'CLOSE', 'CRESCENT', 'LANE', 'PARK', 'VIEW', 'HEIGHTS', 'ESTATE', 'GARDENS', 'PLACE', 'TERRACE', 'WALK', 'RISE', 'HILL', 'WEST', 'EAST', 'NORTH', 'SOUTH', 'CENTRAL']);
const tokens = (s) => String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);

export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/**
 * Floor and unit from the sheet row, e.g. "07-11". On the sheet the Flr and
 * Unit columns sit just left of the street name, so we find the street in the
 * OCR'd row text and take the two numbers right before it. "00 00" (landed
 * house) and anything unclear give "" rather than a guess.
 */
export function extractUnit(rowText, place) {
  if (!rowText || !place) return '';
  const words = String(rowText).toUpperCase().split(/\s+/).map((w) => w.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  const roadWords = tokens(place.road).filter((w) => w.length >= 4 && !GENERIC.has(w));
  const key = roadWords[0] || tokens(place.road)[0];
  if (!key) return '';
  // last occurrence: the street column is the right-most text before the postcode
  let at = -1;
  words.forEach((w, i) => { if (editDistance(w, key) <= (key.length >= 7 ? 2 : 1)) at = i; });
  if (at < 1) return '';
  const num = (w) => /^\d{2,3}[A-Z]?$/.test(w); // the sheet prints Flr/Unit with 2+ digits
  let floor, unit;
  if (at >= 2 && num(words[at - 2]) && num(words[at - 1])) { floor = words[at - 2]; unit = words[at - 1]; }
  else if (/^\d{4}$/.test(words[at - 1])) { floor = words[at - 1].slice(0, 2); unit = words[at - 1].slice(2); } // "07 11" read as "0711"
  else return '';
  if (/^0+$/.test(floor) && /^0+$/.test(unit)) return '';
  return `${floor}-${unit}`;
}

/** A Flr-Unit reading shown only when at least two independent reads agree exactly. */
export function voteUnit(reads) {
  const tally = new Map();
  for (const r of reads) if (r) tally.set(r, (tally.get(r) || 0) + 1);
  for (const [value, n] of tally) if (n >= 2) return value;
  return '';
}

/**
 * Pick the best reading for one OCR'd sheet row.
 * status: 'ok' (code exists and the row text mentions its road/building),
 *         'check' (code exists but the row text didn't confirm it),
 *         'unreadable' (no candidate is a real postal code)
 */
export async function resolveRow(row, lookup = lookupPostcode) {
  let firstFound = null, failed = false;
  for (const code of row.candidates) {
    let place;
    try { place = await lookup(code); } catch { failed = true; continue; }
    if (!place) continue;
    const unit = voteUnit([...(row.unitReads || []), extractUnit(row.rowText, place)]);
    if (rowMatchesPlace(row.rowText, place)) return { postcode: code, place, status: 'ok', unit };
    firstFound ??= { postcode: code, place, status: 'check', unit };
  }
  // 'retry': OneMap couldn't be reached, so we don't know yet whether the code is real
  return firstFound ?? { postcode: row.candidates[0] || '', place: null, status: failed ? 'retry' : 'unreadable' };
}
