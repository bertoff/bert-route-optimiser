// UI: stops list (scan / type / check), optimise, route view with navigation.
// Everything is saved on this phone (localStorage); photos are never stored.

import { lookupPostcode, resolveRow } from './geocode.js';
import { buildPlan, toHHMM, toSec } from './plan.js';
import { providers } from './matrix.js';
import { readSheetPhoto } from './ocr-browser.js';

const STATE_KEY = 'ro.state.v1';
const $ = (id) => document.getElementById(id);

// Every run starts here unless changed in Settings.
const DEFAULT_HUB = {
  postcode: '059764',
  place: { postcode: '059764', lat: 1.287426202547999, lng: 103.8443195274642, blk: '18', road: 'HAVELOCK ROAD', building: 'MINISTRY OF MANPOWER BUILDING', address: '18 HAVELOCK ROAD MINISTRY OF MANPOWER BUILDING SINGAPORE 059764' },
};
const newRun = () => ({ stops: [], plan: null, progress: {}, departure: '', end: 'none' });

const state = load();
function load() {
  const fallback = {
    settings: { hub: DEFAULT_HUB, homes: [{ name: 'Home 1', postcode: '', place: null }, { name: 'Home 2', postcode: '', place: null }], serviceMin: 2, nav: 'google' },
    run: newRun(),
  };
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY));
    if (!s) return fallback;
    const settings = { ...fallback.settings, ...s.settings };
    settings.hub ||= DEFAULT_HUB;
    return { settings, run: { ...fallback.run, ...s.run } };
  } catch { return fallback; }
}
function save() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { toast('Could not save on this phone (storage blocked?)'); }
}

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const placeLine = (p, unit) => p
  ? `<b>${esc(p.blk)} ${esc(p.road)}</b>${unit ? ` <span class="unit-tag">Unit ${esc(unit)}</span>` : ''}${p.building ? ' · ' + esc(p.building) : ''}`
  : '';
// "7-11", "#07-11", "07 11", "0711" -> "07-11"; anything else is kept as typed
function normalizeUnit(v) {
  const t = String(v || '').trim().replace(/^#/, '');
  if (!t) return '';
  let m = /^(\d{1,3})\s*[-–\s/]\s*(\d{1,4}[A-Za-z]?)$/.exec(t) || /^(\d{2})(\d{2,3})$/.exec(t);
  return m ? `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0').toUpperCase()}` : t.toUpperCase();
}
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
  state.settings.homes.forEach((h, i) => {
    $(`home${i}Name`).value = h.name;
    $(`home${i}Code`).value = h.postcode;
    $(`home${i}Resolved`).innerHTML = h.place ? placeLine(h.place) : '';
  });
  $('serviceInput').value = state.settings.serviceMin;
  $('navInput').value = state.settings.nav;
  $('settingsDlg').showModal();
}
$('settingsBtn').onclick = openSettings;
// Show the building as soon as a 6-digit postal code is typed.
function previewPostcode(inputId, outId) {
  $(inputId).addEventListener('input', async (e) => {
    const v = e.target.value.trim();
    $(outId).textContent = '';
    if (!/^\d{6}$/.test(v)) return;
    $(outId).textContent = 'Looking up…';
    try {
      const p = await lookupPostcode(v);
      $(outId).innerHTML = p ? placeLine(p) : 'No building found for that postal code.';
    } catch { $(outId).textContent = 'No internet: could not check the postal code.'; }
  });
}
previewPostcode('hubInput', 'hubResolved');
previewPostcode('home0Code', 'home0Resolved');
previewPostcode('home1Code', 'home1Resolved');
$('saveSettings').addEventListener('click', async (e) => {
  e.preventDefault();
  const code = $('hubInput').value.trim();
  if (code && code !== state.settings.hub?.postcode) {
    const p = await lookupPostcode(code).catch(() => null);
    if (!p) { $('hubResolved').textContent = 'Please enter a valid 6-digit postal code.'; return; }
    state.settings.hub = { postcode: code, place: p };
  }
  for (const i of [0, 1]) {
    const home = state.settings.homes[i];
    const hc = $(`home${i}Code`).value.trim();
    home.name = $(`home${i}Name`).value.trim() || `Home ${i + 1}`;
    if (!hc) { home.postcode = ''; home.place = null; continue; }
    if (hc !== home.postcode) {
      const p = await lookupPostcode(hc).catch(() => null);
      if (!p) { $(`home${i}Resolved`).textContent = 'Please enter a valid 6-digit postal code.'; return; }
      home.postcode = hc; home.place = p;
    }
  }
  state.settings.serviceMin = Math.max(0, Number($('serviceInput').value) || 0);
  state.settings.nav = $('navInput').value;
  save(); renderHub(); renderEndOptions(); $('settingsDlg').close();
});

// ---------- stops ----------
// The company only offers two delivery slots.
const SLOTS = {
  am: { from: '09:00', to: '13:30', label: 'AM 9:00–1:30' },
  pm: { from: '13:00', to: '18:00', label: 'PM 1:00–6:00' },
};
const slotOf = (s) => Object.keys(SLOTS).find((k) => SLOTS[k].from === s.from && SLOTS[k].to === s.to) || '';
function setSlot(s, slot) {
  s.from = SLOTS[slot]?.from || '';
  s.to = SLOTS[slot]?.to || '';
}
const slotButtons = (current, attr) => [['', 'Any'], ['am', SLOTS.am.label], ['pm', SLOTS.pm.label]]
  .map(([k, label]) => `<button class="chip ${current === k ? 'on' : ''}" ${attr}="${k}">${label}</button>`).join('');

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
  const counts = { am: 0, pm: 0 };
  for (const s of stops) { const k = slotOf(s); if (k) counts[k]++; }
  $('slotBar').hidden = !stops.length;
  $('slotBar').innerHTML = `<span>Set all to:</span>${slotButtons(null, 'data-all-slot')}`
    + `<span class="hint" style="margin:0">${counts.am} AM · ${counts.pm} PM · ${stops.length - counts.am - counts.pm} any</span>`;
  $('stopList').innerHTML = stops.map((s) => {
    const badge = {
      ok: '<span class="badge ok">✓ matches sheet</span>',
      manual: '<span class="badge ok">✓ typed</span>',
      check: '<span class="badge check">⚠ Check against sheet</span>',
      unreadable: '<span class="badge bad">✗ Not a real postal code: fix it</span>',
      missing: '<span class="badge bad">✗ Scanner skipped this row: type the postal code</span>',
      retry: '<span class="badge check">↻ Could not check this address yet (busy or no signal)</span>',
    }[s.status] || '';
    return `<li class="stop ${s.status}" data-id="${s.id}">
      <span class="sn">#${s.sn}</span>
      <span class="codes">
        <input class="code" inputmode="numeric" maxlength="6" value="${esc(s.postcode)}" aria-label="Postal code for #${s.sn}">
        <input class="unit" maxlength="10" value="${esc(s.unit || '')}" placeholder="Flr-Unit" aria-label="Floor and unit for #${s.sn}">
      </span>
      <span class="tools">
        <button data-act="pri" class="${s.priority ? 'on' : ''}" aria-label="Priority" title="Priority">${s.priority ? '★' : '☆'}</button>
        <button data-act="del" aria-label="Remove" title="Remove">🗑</button>
      </span>
      <span class="addr">${placeLine(s.place, s.unit)} ${badge}${state.run.progress[s.id] === 'success' ? ' <span class="badge ok">· Delivered (S)</span>' : ''}${state.run.progress[s.id] === 'failed' ? ' <span class="badge bad">· Failed (F)</span>' : ''}</span>
      <span class="slots">${slotButtons(slotOf(s), 'data-slot')}</span>
    </li>`;
  }).join('');
}

$('stopList').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const li = btn.closest('.stop'), s = state.run.stops.find((x) => x.id === li.dataset.id);
  if (btn.dataset.act === 'pri') s.priority = !s.priority;
  if ('slot' in btn.dataset) setSlot(s, btn.dataset.slot);
  if (btn.dataset.act === 'del') { state.run.stops = state.run.stops.filter((x) => x !== s); renumber(); }
  save(); renderStops();
});
$('stopList').addEventListener('change', async (e) => {
  const li = e.target.closest('.stop'); if (!li) return;
  const s = state.run.stops.find((x) => x.id === li.dataset.id);
  if (e.target.classList.contains('unit')) {
    s.unit = normalizeUnit(e.target.value);
    e.target.value = s.unit;
  } else if (e.target.classList.contains('code')) {
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

$('slotBar').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-all-slot]'); if (!btn) return;
  for (const s of state.run.stops) setSlot(s, btn.dataset.allSlot);
  save(); renderStops();
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
        added.push({ id: uid(), postcode: r.postcode, place: r.place, status: r.status, unit: r.unit || '', candidates: row.candidates, priority: false, from: '', to: '' });
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
  state.run = newRun();
  save(); renderStops(); renderEndOptions(); $('progress').hidden = true;
};

// ---------- optimise ----------
function defaultDeparture() {
  const d = new Date(); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
$('departInput').value = state.run.departure || defaultDeparture();
$('departInput').addEventListener('change', (e) => { state.run.departure = e.target.value; save(); });

// Where the run finishes: open (last stop), back at the hub, or one of the homes.
function endChoice(key = state.run.end) {
  if (key === 'hub') return { key, label: 'Hub', place: state.settings.hub.place };
  const m = /^home(\d)$/.exec(key || '');
  const home = m && state.settings.homes[Number(m[1])];
  return home?.place ? { key, label: home.name, place: home.place } : null;
}
function renderEndOptions() {
  const opts = [['none', 'Last stop (decide later)'], ['hub', 'Back to hub']];
  state.settings.homes.forEach((h, i) => opts.push([`home${i}`, h.place ? h.name : `${h.name} (set in ⚙︎ Settings)`, !h.place]));
  if (!endChoice() && state.run.end !== 'none') state.run.end = 'none';
  const html = opts.map(([v, label, disabled]) => `<option value="${v}" ${disabled ? 'disabled' : ''}>${esc(label)}</option>`).join('');
  for (const id of ['endInput', 'routeEndInput']) { $(id).innerHTML = html; $(id).value = state.run.end; }
}
$('endInput').addEventListener('change', (e) => { state.run.end = e.target.value; save(); renderEndOptions(); });

$('optimiseBtn').onclick = async () => {
  if (!state.settings.hub) { openSettings(); return; }
  // envelopes already marked success/failed are finished, so they're not routed again
  const usable = state.run.stops.filter((s) => s.place && !isFinished(state.run.progress[s.id]));
  if (!usable.length) { toast(state.run.stops.length ? 'Every envelope is already marked success or failed.' : 'Add some stops first.'); return; }
  const unresolved = state.run.stops.length - usable.length;
  if (unresolved && !confirm(`${unresolved} row(s) have no valid postal code and will be left out. Continue?`)) return;
  try {
    await optimise({ start: state.settings.hub.place, end: endChoice(), stops: usable, departureSec: toSec($('departInput').value) ?? nowSec() });
  } catch { return; /* message already shown */ }
  for (const id of Object.keys(state.run.progress)) if (state.run.progress[id] === 'skipped') delete state.run.progress[id];
  save(); showTab('route');
};

const nowSec = () => { const d = new Date(); return d.getHours() * 3600 + d.getMinutes() * 60; };

async function optimise({ start, end, stops, departureSec }) {
  const btn = $('optimiseBtn'); btn.disabled = true; btn.textContent = 'Optimising…';
  try {
    const plan = await buildPlan({ start, end, stops, departureSec, serviceMin: state.settings.serviceMin });
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
      window: v.window, priority: v.priority, envelopes: v.envelopes.map((e) => e.sn), units: v.envelopes.map((e) => e.unit || ''),
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

// Delivery results are kept per envelope (like the sheet's S/F column):
// progress[stopId] = 'success' | 'failed' | 'skipped'
const isFinished = (st) => st === 'success' || st === 'failed';
function visitState(v) {
  const st = v.stopIds.map((id) => state.run.progress[id]);
  if (st.every(isFinished)) return st.includes('failed') ? (st.includes('success') ? 'done mixed' : 'done failed') : 'done';
  if (st.every((x) => x === 'skipped')) return 'skipped';
  return '';
}
function tally() {
  const ids = state.run.stops.map((s) => s.id), prog = state.run.progress;
  return { success: ids.filter((id) => prog[id] === 'success').length, failed: ids.filter((id) => prog[id] === 'failed').length };
}

function renderRoute() {
  const plan = state.run.plan;
  $('routeEmpty').hidden = !!plan; $('routeView').hidden = !plan;
  if (!plan) return;
  const prog = state.run.progress;
  const remaining = plan.visits.filter((v) => !visitState(v));
  const t = tally();
  const over = plan.end?.arrive ?? plan.finish;
  const dur = over - plan.departure;
  $('routeSummary').innerHTML = `
    <div><div class="hint" style="margin:0">Last drop about</div><div class="big">${toHHMM(plan.finish)}</div></div>
    ${plan.end?.arrive != null ? `<div><div class="hint" style="margin:0">At ${esc(plan.end.label)} about</div><div class="big">${toHHMM(plan.end.arrive)}</div></div>` : ''}
    <div><div class="hint" style="margin:0">Total</div><div class="big">${Math.floor(dur / 3600)}h ${Math.round((dur % 3600) / 60)}m</div></div>
    <div><div class="hint" style="margin:0">Distance</div><div class="big">${(plan.distance / 1000).toFixed(1)} km</div></div>
    <div><div class="hint" style="margin:0">Stops left</div><div class="big">${remaining.length}/${plan.visits.length}</div></div>
    <div><div class="hint" style="margin:0">Envelopes</div><div class="big"><span class="ok-text">✓ ${t.success}</span> <span class="bad-text">✗ ${t.failed}</span></div></div>
    ${plan.lateCount ? `<div class="warn">⚠ ${plan.lateCount} stop(s) will miss their time window.</div>` : ''}
    ${plan.matrixSource === 'estimate' ? '<div class="warn">⚠ Map service unavailable: times are rough straight-line estimates.</div>' : ''}`;

  const nextPc = remaining[0]?.postcode;
  $('visitList').innerHTML = plan.visits.map((v) => {
    const vs = visitState(v);
    const sts = v.stopIds.map((id) => prog[id]);
    const all = (want) => sts.every((x) => x === want);
    const multi = v.stopIds.length > 1;
    // units: current envelopes' units (they may have been edited after optimising)
    const units = v.stopIds.map((id, k) => state.run.stops.find((s) => s.id === id)?.unit ?? v.units?.[k] ?? '');
    const oneUnit = units.every((u) => u === units[0]) ? units[0] : '';
    const resultBtns = multi
      ? `<button class="btn small ok ${all('success') ? 'on' : ''}" data-act="success">✓ All success</button>
         <button class="btn small bad ${all('failed') ? 'on' : ''}" data-act="failed">✗ All failed</button>`
      : `<button class="btn small ok ${all('success') ? 'on' : ''}" data-act="success">✓ Success</button>
         <button class="btn small bad ${all('failed') ? 'on' : ''}" data-act="failed">✗ Failed</button>`;
    const perEnvelope = multi ? `<div class="env-list">${v.stopIds.map((id, k) => `
        <span class="env"><span class="env-sn">#${v.envelopes[k]}${units[k] && !oneUnit ? ` <span class="unit-tag">${esc(units[k])}</span>` : ''}</span>
          <button class="chip ok ${prog[id] === 'success' ? 'on' : ''}" data-env="${id}" data-set="success" aria-label="Envelope ${v.envelopes[k]} success">✓</button>
          <button class="chip bad ${prog[id] === 'failed' ? 'on' : ''}" data-env="${id}" data-set="failed" aria-label="Envelope ${v.envelopes[k]} failed">✗</button></span>`).join('')}</div>` : '';
    return `<li class="visit ${vs} ${v.postcode === nextPc ? 'next' : ''}" data-pc="${v.postcode}">
      <span class="seq">${v.seq}</span>
      <div>
        <div><span class="eta">${toHHMM(v.start)}</span> ${placeLine(v.place, oneUnit)}</div>
        <div class="meta">${v.postcode} · envelope${v.envelopes.length > 1 ? 's' : ''} ${v.envelopes.map((n) => '#' + n).join(' ')}${v.priority ? ' · ★ priority' : ''}${v.window ? ` · window ${toHHMM(v.window.start)}–${toHHMM(v.window.end)}` : ''}</div>
        ${v.late > 59 ? `<div class="late">About ${Math.round(v.late / 60)} min late for its window</div>` : ''}
        ${v.wait > 59 ? `<div class="wait">Arrive ${toHHMM(v.arrive)}, wait ${Math.round(v.wait / 60)} min for window</div>` : ''}
      </div>
      <div class="row-btns">
        <a class="btn small primary" href="${navUrl(v.place, state.settings.nav)}" target="_blank" rel="noopener">Navigate</a>
        ${resultBtns}
        <button class="btn small ${all('skipped') ? 'on' : ''}" data-act="skipped">${all('skipped') ? 'Unskip' : 'Skip'}</button>
      </div>
      ${perEnvelope}
    </li>`;
  }).join('') + (plan.end ? `<li class="visit end-row">
      <span class="seq">🏁</span>
      <div><div>${plan.end.arrive != null ? `<span class="eta">${toHHMM(plan.end.arrive)}</span> ` : ''}Finish at <b>${esc(plan.end.label)}</b></div>
        <div class="meta">${placeLine(plan.end.place)}</div></div>
      <div class="row-btns"><a class="btn small primary" href="${navUrl(plan.end.place, state.settings.nav)}" target="_blank" rel="noopener">Navigate</a></div>
    </li>` : '');
  drawMap(plan);
}

$('visitList').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const prog = state.run.progress;
  const toggle = (id, want) => { if (prog[id] === want) delete prog[id]; else prog[id] = want; };
  if (btn.dataset.env) {
    toggle(btn.dataset.env, btn.dataset.set);
  } else if (btn.dataset.act) {
    const v = state.run.plan.visits.find((x) => x.postcode === btn.closest('.visit').dataset.pc);
    const want = btn.dataset.act;
    // tapping an already-active button undoes it
    if (v.stopIds.every((id) => prog[id] === want)) v.stopIds.forEach((id) => delete prog[id]);
    else v.stopIds.forEach((id) => { prog[id] = want; });
  } else return;
  save(); renderRoute(); renderStops();
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
  const pts = [plan.start, ...plan.visits.map((v) => v.place), ...(plan.end ? [plan.end.place] : [])];
  L.marker([plan.start.lat, plan.start.lng], { icon: L.divIcon({ className: 'marker-hub', html: 'H', iconSize: [26, 26] }) }).addTo(layer);
  if (plan.end && plan.end.key !== 'hub') L.marker([plan.end.place.lat, plan.end.place.lng], { icon: L.divIcon({ className: 'marker-hub', html: '🏁', iconSize: [26, 26] }) }).bindPopup(esc(plan.end.label)).addTo(layer);
  plan.visits.forEach((v) => {
    L.marker([v.place.lat, v.place.lng], {
      icon: L.divIcon({ className: `marker-num ${visitState(v)}`, html: String(v.seq), iconSize: [26, 26] }),
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
  const plan = state.run.plan;
  const doneVisits = plan.visits.filter((v) => visitState(v));
  const todo = plan.visits.filter((v) => !visitState(v));
  if (!todo.length) {
    // nothing left to order: just point the finish row at the chosen end
    const end = endChoice();
    plan.end = end ? { ...end, arrive: null } : null;
    delete plan.geometry; save(); renderRoute(); return;
  }
  const stops = state.run.stops.filter((s) => todo.some((v) => v.stopIds.includes(s.id)));
  let start = [...doneVisits].reverse().find((v) => visitState(v).startsWith('done'))?.place || plan.start;
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 60000 }));
    start = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch { /* no GPS permission or no fix: start from the last finished stop */ }
  const btn = $('reoptBtn'); btn.disabled = true; btn.textContent = 'Re-optimising…';
  try {
    const fresh = await optimise({ start, end: endChoice(), stops, departureSec: nowSec() });
    fresh.visits = [...doneVisits, ...fresh.visits.map((v, i) => ({ ...v, seq: doneVisits.length + i + 1 }))];
    fresh.start = plan.start;
    fresh.departure = plan.departure;
    delete fresh.geometry;
    state.run.plan = fresh; save(); renderRoute();
  } catch { /* message already shown */ } finally { btn.disabled = false; btn.textContent = '↻ Re-optimise remaining stops from here'; }
};

$('routeEndInput').addEventListener('change', (e) => {
  state.run.end = e.target.value; save(); renderEndOptions();
  $('reoptBtn').click(); // re-plan the remaining stops towards the new finish
});

// ---------- start ----------
renderHub();
renderStops();
renderEndOptions();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
