// UI: stops list (scan / type / check), optimise, route view with navigation.
// Everything is saved on this phone (localStorage); photos are never stored.

import { lookupPostcode, resolveRow } from './geocode.js';
import { buildPlan, toHHMM, toSec } from './plan.js';
import { providers } from './matrix.js';
import { readSheetPhoto } from './ocr-browser.js';

const STATE_KEY = 'ro.state.v1';
const $ = (id) => document.getElementById(id);

const state = load();
function load() {
  const fallback = { settings: { hub: null, serviceMin: 2, nav: 'google' }, run: { stops: [], plan: null, progress: {}, departure: '' } };
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    return s ? { settings: { ...fallback.settings, ...s.settings }, run: { ...fallback.run, ...s.run } } : fallback;
  } catch { return fallback; }
}
function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { toast('Could not save on this phone (storage blocked?)'); }
}

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const placeLine = (p) => p ? `<b>${esc(p.blk)} ${esc(p.road)}</b>${p.building ? ' · ' + esc(p.building) : ''}` : '';
function toast(msg) { const el = $('progress'); el.hidden = false; el.textContent = msg; }

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('tab-stops').hidden = name !== 'stops';
  $('tab-route').hidden = name !== 'route';
  document.querySelector('.optimise-bar').hidden = name !== 'stops';
  window.scrollTo(0, 0);
  if (name === 'route') renderRoute();
}

// ---------- hub & settings ----------
function renderHub() {
  const hub = state.settings.hub, el = $('hubBanner');
  el.classList.toggle('missing', !hub);
  el.innerHTML = hub
    ? `<div><div class="hint" style="margin:0">Start (hub)</div>${placeLine(hub.place)} <span class="hint">${esc(hub.postcode)}</span></div><button class="btn small" data-act="hub">Change</button>`
    : `<div>Set your hub postal code first, so routes start there.</div><button class="btn small primary" data-act="hub">Set hub</button>`;
  el.querySelector('[data-act=hub]').onclick = openSettings;
}

function openSettings() {
  $('hubInput').value = state.settings.hub?.postcode || '';
  $('hubResolved').innerHTML = state.settings.hub ? placeLine(state.settings.hub.place) : '';
  $('serviceInput').value = state.settings.serviceMin;
  $('navInput').value = state.settings.nav;
  $('settingsDlg').showModal();
}
$('settingsBtn').onclick = openSettings;
$('hubInput').addEventListener('input', async (e) => {
  const v = e.target.value.trim();
  $('hubResolved').textContent = '';
  if (!/^\d{6}$/.test(v)) return;
  $('hubResolved').textContent = 'Looking up…';
  try {
    const p = await lookupPostcode(v);
    $('hubResolved').innerHTML = p ? placeLine(p) : 'No building found for that postal code.';
  } catch { $('hubResolved').textContent = 'No internet: could not check the postal code.'; }
});
$('saveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  const code = $('hubInput').value.trim();
  if (code && code !== state.settings.hub?.postcode) {
    const p = await lookupPostcode(code).catch(() => null);
    if (!p) { $('hubResolved').textContent = 'Please enter a valid 6-digit postal code.'; return; }
    state.settings.hub = { postcode: code, place: p };
  }
  state.settings.serviceMin = Math.max(0, Number($('serviceInput').value) || 0);
  state.settings.nav = $('navInput').value;
  save(); renderHub(); $('settingsDlg').close();
});

// ---------- stops ----------
function renumber() { state.run.stops.forEach((s, i) => { s.sn = i + 1; }); }

function renderStops() {
  const stops = state.run.stops;
  const visits = new Set(stops.filter((s) => s.place).map((s) => s.postcode)).size;
  const problems = stops.filter((s) => s.status !== 'ok' && s.status !== 'manual').length;
  $('stopCount').textContent = stops.length || '';
  const retries = stops.filter((s) => s.status === 'retry').length;
  $('stopsSummary').innerHTML = stops.length
    ? `${stops.length} envelopes · ${visits} addresses${problems ? ` · ${problems} to check` : ' · all confirmed'}`
      + (retries ? ` <button id="retryBtn" class="btn small">↻ Retry address checks (${retries})</button>` : '')
    : '';
  $('retryBtn')?.addEventListener('click', retryLookups);
  $('stopList').innerHTML = stops.map((s) => {
    const badge = {
      ok: '<span class="badge ok">✓ matches sheet</span>',
      manual: '<span class="badge ok">✓ typed</span>',
      check: '<span class="badge check">⚠ Check against sheet</span>',
      unreadable: '<span class="badge bad">✗ Not a real postal code: fix it</span>',
      missing: '<span class="badge bad">✗ Scanner skipped this row: type the postal code</span>',
      retry: '<span class="badge check">↻ Could not check this address yet (busy or no signal)</span>',
    }[s.status] || '';
    const showWin = s.from || s.to || s.showWindow;
    return `<li class="stop ${s.status}" data-id="${s.id}">
      <span class="sn">#${s.sn}</span>
      <input class="code" inputmode="numeric" maxlength="6" value="${esc(s.postcode)}" aria-label="Postal code for #${s.sn}">
      <span class="tools">
        <button data-act="pri" class="${s.priority ? 'on' : ''}" aria-label="Priority" title="Priority">${s.priority ? '★' : '☆'}</button>
        <button data-act="win" aria-label="Time window" title="Time window">⏰</button>
        <button data-act="del" aria-label="Remove" title="Remove">🗑</button>
      </span>
      <span class="addr">${placeLine(s.place)} ${badge}</span>
      ${showWin ? `<span class="window">Deliver between <input type="time" data-act="from" value="${esc(s.from)}"> and <input type="time" data-act="to" value="${esc(s.to)}"></span>` : ''}
    </li>`;
  }).join('');
}

$('stopList').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const li = btn.closest('.stop'), s = state.run.stops.find((x) => x.id === li.dataset.id);
  if (btn.dataset.act === 'pri') s.priority = !s.priority;
  if (btn.dataset.act === 'win') s.showWindow = !s.showWindow;
  if (btn.dataset.act === 'del') { state.run.stops = state.run.stops.filter((x) => x !== s); renumber(); }
  save(); renderStops();
});
$('stopList').addEventListener('change', async (e) => {
  const li = e.target.closest('.stop'); if (!li) return;
  const s = state.run.stops.find((x) => x.id === li.dataset.id);
  if (e.target.dataset.act === 'from') s.from = e.target.value;
  else if (e.target.dataset.act === 'to') s.to = e.target.value;
  else if (e.target.classList.contains('code')) {
    const v = e.target.value.trim();
    s.postcode = v; s.place = null; s.status = 'unreadable'; s.candidates = [v];
    if (/^\d{6}$/.test(v)) {
      try {
        const p = await lookupPostcode(v);
        if (p) { s.place = p; s.status = 'manual'; }
      } catch { s.status = 'retry'; }
    }
    renderStops();
  }
  save();
});

$('addManualBtn').onclick = () => {
  state.run.stops.push({ id: uid(), postcode: '', place: null, status: 'missing', priority: false, from: '', to: '' });
  renumber(); save(); renderStops();
  const inputs = document.querySelectorAll('.stop .code');
  inputs[inputs.length - 1]?.focus();
};

async function handlePhotos(files) {
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const label = list.length > 1 ? `Photo ${i + 1}/${list.length}: ` : '';
    try {
      const result = await readSheetPhoto(list[i], (msg) => toast(label + msg));
      if (result.error) { toast(label + result.error); continue; }
      toast(label + 'Checking addresses…');
      const added = [];
      for (const row of result.rows) {
        for (let m = 0; m < row.missingBefore; m++) added.push({ id: uid(), postcode: '', place: null, status: 'missing', priority: false, from: '', to: '' });
        const r = await resolveRow(row).catch(() => ({ postcode: row.candidates[0] || '', place: null, status: 'unreadable' }));
        // row text (names etc.) is used only for the check above and not kept
        added.push({ id: uid(), postcode: r.postcode, place: r.place, status: r.status, candidates: row.candidates, priority: false, from: '', to: '' });
      }
      state.run.stops.push(...added);
      renumber(); save(); renderStops();
      const bad = added.filter((s) => s.status !== 'ok').length;
      toast(`${label}Added ${added.length} rows.${bad ? ` ${bad} need a look (highlighted).` : ' All matched the sheet.'} Compare the count with your sheet.`);
    } catch (err) {
      console.error(err);
      toast(`${label}Could not read this photo (${err.message}). Try again, or type the postal codes.`);
    }
  }
}
async function retryLookups() {
  const btn = $('retryBtn'); if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  for (const s of state.run.stops.filter((x) => x.status === 'retry')) {
    // the sheet text isn't kept, so a found code can only be marked "check against sheet"
    const r = await resolveRow({ candidates: s.candidates?.length ? s.candidates : [s.postcode], rowText: '' });
    Object.assign(s, { postcode: r.postcode, place: r.place, status: r.status });
  }
  save(); renderStops();
}

$('cameraInput').addEventListener('change', (e) => { handlePhotos(e.target.files); e.target.value = ''; });
$('galleryInput').addEventListener('change', (e) => { handlePhotos(e.target.files); e.target.value = ''; });

$('clearBtn').onclick = () => {
  if (!confirm('Clear all stops and the route for today?')) return;
  state.run = { stops: [], plan: null, progress: {}, departure: '' };
  save(); renderStops(); $('progress').hidden = true;
};

// ---------- optimise ----------
function defaultDeparture() {
  const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
$('departInput').value = state.run.departure || defaultDeparture();
$('departInput').addEventListener('change', (e) => { state.run.departure = e.target.value; save(); });

$('optimiseBtn').onclick = async () => {
  if (!state.settings.hub) { openSettings(); return; }
  const usable = state.run.stops.filter((s) => s.place);
  if (!usable.length) { toast('Add some stops first.'); return; }
  const unresolved = state.run.stops.length - usable.length;
  if (unresolved && !confirm(`${unresolved} row(s) have no valid postal code and will be left out. Continue?`)) return;
  try {
    await optimise({ start: state.settings.hub.place, stops: usable, departureSec: toSec($('departInput').value) ?? nowSec() });
  } catch { return; /* message already shown */ }
  state.run.progress = {};
  save(); showTab('route');
};

const nowSec = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60; };

async function optimise({ start, stops, departureSec }) {
  const btn = $('optimiseBtn'); btn.disabled = true; btn.textContent = 'Optimising…';
  try {
    const plan = await buildPlan({ start, stops, departureSec, serviceMin: state.settings.serviceMin });
    state.run.plan = slimPlan(plan);
    return state.run.plan;
  } catch (err) {
    toast(`Could not optimise: ${err.message}`);
    throw err;
  } finally { btn.disabled = false; btn.textContent = 'Optimise route'; }
}
// keep only what the route screen needs
function slimPlan(plan) {
  return {
    ...plan,
    visits: plan.visits.map((v) => ({
      postcode: v.postcode, place: v.place, seq: v.seq, arrive: v.arrive, start: v.start, wait: v.wait, late: v.late,
      window: v.window, priority: v.priority, envelopes: v.envelopes.map((e) => e.sn),
      stopIds: v.envelopes.map((e) => e.id),
    })),
  };
}

// ---------- route ----------
let map = null, layer = null;
const navUrl = (p, app) => ({
  google: `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`,
  waze: `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`,
  apple: `https://maps.apple.com/?daddr=${p.lat},${p.lng}&dirflg=d`,
}[app]);

function renderRoute() {
  const plan = state.run.plan;
  $('routeEmpty').hidden = !!plan; $('routeView').hidden = !plan;
  if (!plan) return;
  const prog = state.run.progress;
  const remaining = plan.visits.filter((v) => !prog[v.postcode]);
  const dur = plan.finish - plan.departure;
  $('routeSummary').innerHTML = `
    <div><div class="hint" style="margin:0">Finish about</div><div class="big">${toHHMM(plan.finish)}</div></div>
    <div><div class="hint" style="margin:0">Total</div><div class="big">${Math.floor(dur / 3600)}h ${Math.round((dur % 3600) / 60)}m</div></div>
    <div><div class="hint" style="margin:0">Distance</div><div class="big">${(plan.distance / 1000).toFixed(1)} km</div></div>
    <div><div class="hint" style="margin:0">Left</div><div class="big">${remaining.length}/${plan.visits.length}</div></div>
    ${plan.lateCount ? `<div class="warn">⚠ ${plan.lateCount} stop(s) will miss their time window.</div>` : ''}
    ${plan.matrixSource === 'estimate' ? '<div class="warn">⚠ Map service unavailable: times are rough straight-line estimates.</div>' : ''}`;

  const nextPc = remaining[0]?.postcode;
  $('visitList').innerHTML = plan.visits.map((v) => {
    const st = prog[v.postcode];
    return `<li class="visit ${st || ''} ${v.postcode === nextPc ? 'next' : ''}" data-pc="${v.postcode}">
      <span class="seq">${v.seq}</span>
      <div>
        <div><span class="eta">${toHHMM(v.start)}</span> ${placeLine(v.place)}</div>
        <div class="meta">${v.postcode} · envelope${v.envelopes.length > 1 ? 's' : ''} ${v.envelopes.map((n) => '#' + n).join(' ')}${v.priority ? ' · ★ priority' : ''}${v.window ? ` · window ${toHHMM(v.window.start)}–${toHHMM(v.window.end)}` : ''}</div>
        ${v.late > 59 ? `<div class="late">About ${Math.round(v.late / 60)} min late for its window</div>` : ''}
        ${v.wait > 59 ? `<div class="wait">Arrive ${toHHMM(v.arrive)}, wait ${Math.round(v.wait / 60)} min for window</div>` : ''}
      </div>
      <div class="row-btns">
        <a class="btn small primary" href="${navUrl(v.place, state.settings.nav)}" target="_blank" rel="noopener">Navigate</a>
        <button class="btn small" data-act="done">${st === 'done' ? 'Undo' : '✓ Done'}</button>
        <button class="btn small" data-act="skip">${st === 'skipped' ? 'Unskip' : 'Skip'}</button>
      </div>
    </li>`;
  }).join('');
  drawMap(plan);
}

$('visitList').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const pc = btn.closest('.visit').dataset.pc, prog = state.run.progress;
  const want = btn.dataset.act === 'done' ? 'done' : 'skipped';
  if (prog[pc] === want) delete prog[pc]; else prog[pc] = want;
  save(); renderRoute();
});

async function drawMap(plan) {
  if (!window.L) return;
  if (!map) {
    map = L.map('map', { zoomControl: true });
    L.tileLayer('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png', {
      minZoom: 11, maxZoom: 19, detectRetina: true,
      attribution: '<img src="https://www.onemap.gov.sg/web-assets/images/logo/om_logo.png" style="height:16px;width:16px;vertical-align:middle"> <a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener">OneMap</a> © contributors | <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener">Singapore Land Authority</a>',
    }).addTo(map);
  }
  setTimeout(() => map.invalidateSize(), 0);
  if (layer) layer.remove();
  layer = L.layerGroup().addTo(map);
  const prog = state.run.progress;
  const pts = [plan.start, ...plan.visits.map((v) => v.place)];
  L.marker([plan.start.lat, plan.start.lng], { icon: L.divIcon({ className: 'marker-hub', html: 'H', iconSize: [26, 26] }) }).addTo(layer);
  plan.visits.forEach((v) => {
    L.marker([v.place.lat, v.place.lng], {
      icon: L.divIcon({ className: `marker-num ${prog[v.postcode] ? 'done' : ''}`, html: String(v.seq), iconSize: [26, 26] }),
    }).bindPopup(`${v.seq}. ${placeLine(v.place)}<br>${toHHMM(v.start)}`).addTo(layer);
  });
  const latlngs = pts.map((p) => [p.lat, p.lng]);
  map.fitBounds(L.latLngBounds(latlngs).pad(0.1));
  const line = L.polyline(latlngs, { color: '#0f766e', weight: 3, opacity: 0.5, dashArray: '4 6' }).addTo(layer);
  try {
    const geom = plan.geometry || (plan.geometry = await providers.osrm.geometry(pts));
    save();
    line.setLatLngs(geom).setStyle({ opacity: 0.85, dashArray: null });
  } catch { /* keep the straight-line sketch */ }
}

$('reoptBtn').onclick = async () => {
  const plan = state.run.plan, prog = state.run.progress;
  const doneVisits = plan.visits.filter((v) => prog[v.postcode]);
  const todo = plan.visits.filter((v) => !prog[v.postcode]);
  if (!todo.length) { alert('All stops are done or skipped.'); return; }
  const stops = state.run.stops.filter((s) => todo.some((v) => v.stopIds.includes(s.id)));
  let start = [...doneVisits].reverse().find((v) => prog[v.postcode] === 'done')?.place || plan.start;
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 60000 }));
    start = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch { /* no GPS permission or no fix: start from the last finished stop */ }
  const btn = $('reoptBtn'); btn.disabled = true; btn.textContent = 'Re-optimising…';
  try {
    const fresh = await optimise({ start, stops, departureSec: nowSec() });
    fresh.visits = [...doneVisits, ...fresh.visits.map((v, i) => ({ ...v, seq: doneVisits.length + i + 1 }))];
    fresh.start = plan.start;
    fresh.departure = plan.departure;
    delete fresh.geometry;
    state.run.plan = fresh; save(); renderRoute();
  } catch { /* message already shown */ } finally { btn.disabled = false; btn.textContent = '↻ Re-optimise remaining stops from here'; }
};

// ---------- start ----------
renderHub();
renderStops();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
