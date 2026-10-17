// Reads the PostCd column of a tasking sheet photo.
//
// The sheet layout is fixed, so instead of trusting a whole-page OCR we:
//   1. clean the image (remove table grid lines),
//   2. OCR the whole page once to find some postal codes and where they sit,
//   3. fit a (possibly tilted) line through them = the PostCd column,
//   4. re-read that column in short overlapping pieces with digits-only OCR,
//   5. merge both passes row by row, keeping every candidate reading so the
//      address lookup can pick the one that matches the street on that row.
//
// `recognize(image, opts)` is injected so this runs in the browser and in Node:
//   image = { data: Uint8Array ink mask (1 = ink), width, height }
//   opts  = { digitsOnly?: boolean, chars?: string (allowed characters), upscale?: number
//             (enlarge before reading; boxes come back in original pixels) }
//
// Privacy: the FIN and RcptIDs columns are never cut out or read on their own,
// and any ID-looking text the whole-page pass happens to see is thrown away.
//   returns [{ text, bbox: { x0, y0, x1, y1 } }]

import { binarize, removeLines } from './imageprep.js';

const SIX = /^\d{6}$/;

export function postcodeOf(text) {
  const digits = String(text).replace(/[^0-9]/g, '');
  return digits.length === 6 ? digits : null;
}

const centre = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Theil–Sen line x = a*y + b: robust to a few misplaced detections.
export function fitColumn(points) {
  if (points.length === 0) return null;
  if (points.length === 1) return { a: 0, b: points[0].x };
  const slopes = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const dy = points[j].y - points[i].y;
    if (Math.abs(dy) > 1) slopes.push((points[j].x - points[i].x) / dy);
  }
  const a = slopes.length ? median(slopes) : 0;
  const b = median(points.map((p) => p.x - a * p.y));
  return { a, b };
}

function cropMask(mask, W, H, left, top, width, height) {
  left = Math.max(0, Math.round(left)); top = Math.max(0, Math.round(top));
  width = Math.min(W - left, Math.round(width)); height = Math.min(H - top, Math.round(height));
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(mask.subarray((top + y) * W + left, (top + y) * W + left + width), y * width);
  return { data: out, width, height, left, top };
}

// Group detections whose vertical centres are close into rows.
export function clusterRows(detections, rowGap) {
  const sorted = [...detections].sort((p, q) => p.y - q.y);
  const rows = [];
  for (const d of sorted) {
    const last = rows[rows.length - 1];
    if (last && d.y - last.y < rowGap) { last.items.push(d); last.y = median(last.items.map((i) => i.y)); }
    else rows.push({ y: d.y, items: [d] });
  }
  return rows.map((r) => {
    const tally = new Map();
    for (const it of r.items) tally.set(it.code, (tally.get(it.code) || 0) + (it.weight || 1));
    const candidates = [...tally.entries()].sort((p, q) => q[1] - p[1]).map(([code]) => code);
    return { y: r.y, candidates };
  });
}

/**
 * @param gray  grayscale Uint8Array of an upright (already rotated) photo
 * @param scale how much the photo was enlarged (pixel sizes below assume ~1449px-tall sheets at scale 1)
 */
export async function readSheet(gray, W, H, recognize, { scale = 2, onProgress = () => {}, unitScales = [2, 3] } = {}) {
  onProgress('Cleaning image');
  const ink = binarize(gray, W, H, 12 * scale);         // with grid lines: used to find the columns
  const mask = removeLines(ink, W, H, 40 * scale);       // without grid lines: used for reading

  onProgress('Reading page');
  const words = await recognize({ data: mask, width: W, height: H }, { digitsOnly: false });
  let found = words.filter((w) => SIX.test(w.text.trim())).map((w) => ({ code: w.text.trim(), ...centre(w.bbox), w: w.bbox.x1 - w.bbox.x0 }));

  let line = null, codeWidth = 55 * scale;
  if (found.length >= 2) {
    line = fitColumn(found);
    // drop detections far from the fitted column (e.g. a 6-digit number elsewhere)
    codeWidth = median(found.map((f) => f.w));
    found = found.filter((f) => Math.abs(f.x - (line.a * f.y + line.b)) < codeWidth);
    if (found.length >= 2) line = fitColumn(found);
  }
  if (!line) {
    const header = words.find((w) => /POSTC/i.test(w.text));
    if (header) line = { a: 0, b: centre(header.bbox).x };
  }
  if (!line) return { rows: [], possibleMissing: 0, error: 'Could not find the PostCd column. Retake the photo flat, filling the frame.' };

  const ys = found.map((f) => f.y).sort((p, q) => p - q);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter((g) => g > 20 * scale);
  const rowH = gaps.length ? Math.min(median(gaps), 120 * scale) : 75 * scale;
  const header = words.find((w) => /POSTC/i.test(w.text));
  const top = header ? header.bbox.y1 : Math.max(0, (ys[0] ?? 0) - 2 * rowH);

  onProgress('Reading postal codes');
  const detections = found.map((f) => ({ code: f.code, y: f.y, weight: 1 }));
  const chunkH = Math.round(6 * rowH), step = Math.round(5 * rowH);
  for (let y0 = top; y0 < H; y0 += step) {
    const mid = y0 + chunkH / 2;
    const xc = line.a * mid + line.b, half = codeWidth * 0.95;
    const piece = cropMask(mask, W, H, xc - half, y0, 2 * half, chunkH);
    if (piece.width < 10 || piece.height < 10) continue;
    const ws = await recognize(piece, { digitsOnly: true });
    for (const w of ws) {
      const code = postcodeOf(w.text);
      if (code) detections.push({ code, y: piece.top + centre(w.bbox).y, weight: 1.5 });
    }
  }

  const codeRows = clusterRows(detections, rowH * 0.5);

  // Rows come from the table's horizontal grid lines when they can be found,
  // so a crossed-out or unreadable row still keeps its place (and S/N).
  const rows = tableRows(ink, W, H, line, codeWidth, rowH, codeRows, words);
  const IDLIKE = /\*/; // FIN / RcptIDs are printed masked ("M****123A"): never kept
  for (const r of rows) {
    const xc = line.a * r.y + line.b;
    r.rowText = words
      .filter((w) => Math.abs(centre(w.bbox).y - r.y) < rowH * 0.6 && w.bbox.x1 < xc - codeWidth * 0.4 && !IDLIKE.test(w.text))
      .sort((p, q) => p.bbox.x0 - q.bbox.x0)
      .map((w) => w.text).join(' ');
  }

  // Each row's vertical grid lines, counted outwards from PostCd, give every
  // column: S/N | FIN | PT | Worker | Blk | Building | Flr | Unit | Street | PostCd
  // | (new sheet:) RcptIDs | Name | Name | Name | RcptHPNo | DWindow | DT
  const newLayout = words.some((w) => /DWIN|HPN/i.test(w.text));
  for (const r of rows) {
    const xp = line.a * r.y + line.b;
    const edges = columnEdges(ink, W, H, r.y, (r.bottom - r.top) * 0.3);
    const left = edges.filter((x) => x < xp - codeWidth * 0.3).sort((p, q) => q - p);
    const right = edges.filter((x) => x > xp + codeWidth * 0.3).sort((p, q) => p - q);
    r.cells = {};
    // strike check spans the printed cells from the FIN column's left border (or
    // as far as this row's grid goes) to PostCd: never the paper edge or clipboard
    r.strikeX0 = left.length ? left[Math.min(8, left.length - 1)] : null;
    // follow this row's own top and bottom grid lines across the table, so cells
    // and the strike check stay inside the row even in angled photos
    const xLeft = r.strikeX0 ?? xp - codeWidth * 18, xRight = right.length ? right[right.length - 1] : xp + codeWidth * 14;
    const topLine = traceLine(ink, W, H, xp, r.top, xLeft, xRight, codeWidth);
    const botLine = traceLine(ink, W, H, xp, r.bottom, xLeft, xRight, codeWidth);
    r.gridded = !!(topLine && botLine);
    // without visible grid lines, assume rows run at right angles to the PostCd column
    r.topLine = topLine && botLine ? topLine : (x) => r.top - line.a * (x - xp);
    r.botLine = topLine && botLine ? botLine : (x) => r.bottom - line.a * (x - xp);
    if (left.length >= 4) {
      const [ePost, eUnitR, eFlrR, eFlrL] = left;
      const street = ePost - eUnitR, unitW = eUnitR - eFlrR, flrW = eFlrR - eFlrL;
      if (street >= codeWidth * 1.2 && unitW >= codeWidth * 0.3 && unitW <= codeWidth * 2.2 && flrW >= codeWidth * 0.3 && flrW <= codeWidth * 2.2) {
        r.cells.flr = [eFlrL, eFlrR]; r.cells.unit = [eFlrR, eUnitR];
      }
    }
    if (left.length >= 10) {
      const snW = left[8] - left[9], finW = left[7] - left[8];
      if (snW >= codeWidth * 0.3 && snW <= codeWidth * 1.6 && finW > snW) r.cells.sn = [left[9], left[8]];
    }
    if (newLayout && right.length >= 8) {
      // widths: wd(0) RcptIDs (skipped on purpose), wd(1..3) names, wd(4) phones, wd(5) DWindow, wd(6) DT
      const wd = (i) => right[i + 1] - right[i];
      if (wd(6) <= codeWidth * 1.3 && wd(5) >= codeWidth * 0.8 && wd(5) <= codeWidth * 3 && wd(4) >= codeWidth) {
        r.cells.names = [[right[1], right[2]], [right[2], right[3]], [right[3], right[4]]];
        r.cells.phones = [right[4], right[5]];
        r.cells.window = [right[5], right[6]];
        r.cells.dt = [right[6], right[7]];
      }
    }
  }

  // Flr and Unit: each cell read on its own, at two sizes. Both reads are kept;
  // the final vote (with the row-text read) happens in resolveRow, and a unit is
  // only shown when two readings agree: a wrong unit is worse than a blank.
  onProgress('Reading floor and unit');
  const fuCells = rows.map((r) => r.cells.flr && { flr: r.cells.flr, unit: r.cells.unit, y: r.y });
  const [readA, readB] = [await readCells(mask, W, H, fuCells, rowH, codeWidth, recognize, unitScales[0]),
    await readCells(mask, W, H, fuCells, rowH, codeWidth, recognize, unitScales[1])];
  rows.forEach((r, i) => { r.unitReads = [readA[i], readB[i]]; });

  // S/N: printed numbers run 1, 2, 3... so trust the sequence, not single reads.
  onProgress('Reading row numbers');
  const geo = { line, codeWidth, rowH };
  const snText = await readGrid(mask, W, H, rows, ['sn'], geo, recognize, { digitsOnly: true, upscale: 2 });
  assignSerials(rows, snText.map((t) => parseInt((t.sn || []).join('').replace(/\D/g, ''), 10)));

  if (newLayout) {
    onProgress('Reading recipients');
    // one name column per read: side-by-side cells with different line counts confuse the reader
    const nameOpts = { chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ -'@/.&()" };
    const nameCols = [];
    for (const key of ['name0', 'name1', 'name2']) nameCols.push(await readGrid(mask, W, H, rows, [key], geo, recognize, nameOpts));
    const names = rows.map((_, i) => ({ name0: nameCols[0][i].name0, name1: nameCols[1][i].name1, name2: nameCols[2][i].name2 }));
    const phoneA = await readGrid(mask, W, H, rows, ['phones'], geo, recognize, { chars: '0123456789|', upscale: 1 });
    const phoneB = await readGrid(mask, W, H, rows, ['phones'], geo, recognize, { chars: '0123456789|', upscale: 2 });
    const extra = await readGrid(mask, W, H, rows, ['window', 'dt'], geo, recognize, { digitsOnly: true, upscale: 2 });
    rows.forEach((r, i) => {
      const nameList = ['name0', 'name1', 'name2'].map((k) => cleanName((names[i][k] || []).join(' '))).filter(Boolean);
      r.recipients = pairRecipients(nameList, parsePhones(phoneA[i].phones), parsePhones(phoneB[i].phones));
      r.window = parseWindow((extra[i].window || []).join(''));
      r.dt = parseAttempt((extra[i].dt || []).join(''));
    });
  }

  // Rows struck through by hand are skipped (the app lists them with "Add back").
  for (const r of rows) r.struck = isStruckThrough(ink, W, H, r, line, codeWidth);
  // An extra row at the top or bottom without a postcode only counts if it has
  // the table's own grid (it may be paper edge or shadow otherwise).
  while (rows.length && !rows[rows.length - 1].candidates.length && !rows[rows.length - 1].cells.flr) rows.pop();
  while (rows.length && !rows[0].candidates.length && !rows[0].cells.flr) rows.shift();

  const possibleMissing = rows.filter((r) => !r.candidates.length && !r.struck).length;
  return { rows, possibleMissing };
}

// y positions of horizontal grid lines in a band around the (tilted) PostCd
// column: pixel rows where (almost) every x in the band has ink within ±2px.
export function rowLines(ink, W, H, line, halfWidth) {
  const ys = [];
  for (let y = 2; y < H - 2; y++) {
    const xc = line.a * y + line.b, x0 = Math.max(0, Math.round(xc - halfWidth)), x1 = Math.min(W - 1, Math.round(xc + halfWidth));
    let hit = 0;
    for (let x = x0; x <= x1; x++) {
      if (ink[(y - 2) * W + x] | ink[(y - 1) * W + x] | ink[y * W + x] | ink[(y + 1) * W + x] | ink[(y + 2) * W + x]) hit++;
    }
    if (hit >= (x1 - x0 + 1) * 0.9) ys.push(y);
  }
  const lines = [];
  for (let i = 0; i < ys.length; ) {
    let j = i; while (j + 1 < ys.length && ys[j + 1] - ys[j] <= 2) j++;
    lines.push((ys[i] + ys[j]) / 2); i = j + 1;
  }
  return lines;
}

// Table body rows = spaces between horizontal grid lines, each with the postcode
// readings that fall inside it. Falls back to the postcode readings alone when
// the grid lines can't be found.
function tableRows(ink, W, H, line, codeWidth, rowH, codeRows, words) {
  const fallback = () => codeRows.map((r, i) => ({
    ...r, top: r.y - rowH / 2, bottom: r.y + rowH / 2,
    missingBefore: i === 0 ? 0 : Math.max(0, Math.round((r.y - codeRows[i - 1].y) / rowH) - 1),
  }));
  let ys = rowLines(ink, W, H, line, codeWidth * 0.6);
  // A pen line through a row can look like a grid line and split the row in
  // two thin halves; drop "lines" with an unusually thin row on both sides.
  const typical = median(ys.slice(1).map((y, i) => y - ys[i]).filter((h) => h >= rowH * 0.6 && h <= rowH * 3)) || rowH;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 1; i < ys.length - 1; i++) {
      if (ys[i] - ys[i - 1] < typical * 0.7 && ys[i + 1] - ys[i] < typical * 0.7 && ys[i + 1] - ys[i - 1] < typical * 1.5) {
        ys = ys.slice(0, i).concat(ys.slice(i + 1)); changed = true; break;
      }
    }
  }
  const spans = [];
  for (let i = 1; i < ys.length; i++) {
    const h = ys[i] - ys[i - 1];
    if (h >= rowH * 0.4 && h <= rowH * 3) spans.push({ top: ys[i - 1], bottom: ys[i] });
  }
  const holding = spans.filter((sp) => codeRows.some((r) => r.y > sp.top && r.y < sp.bottom));
  if (holding.length < Math.max(2, codeRows.length * 0.7)) return fallback();
  const hRow = median(holding.map((sp) => sp.bottom - sp.top));
  const header = words.find((w) => /POSTC/i.test(w.text));
  const firstIdx = spans.indexOf(holding[0]), lastIdx = spans.indexOf(holding[holding.length - 1]);
  let from = firstIdx, to = lastIdx;
  // a crossed-out / unreadable row can be first or last: include row-sized
  // neighbours that aren't the header row
  const rowSized = (sp) => sp && sp.bottom - sp.top >= hRow * 0.6 && sp.bottom - sp.top <= hRow * 1.8;
  while (from > 0 && rowSized(spans[from - 1]) && spans[from - 1].bottom - spans[from].top >= -2
    && !(header && centre(header.bbox).y > spans[from - 1].top - 2)) from--;
  while (to < spans.length - 1 && rowSized(spans[to + 1]) && Math.abs(spans[to + 1].top - spans[to].bottom) <= 2) to++;
  const rows = [];
  for (let i = from; i <= to; i++) {
    const sp = spans[i];
    const inside = codeRows.filter((r) => r.y > sp.top && r.y < sp.bottom);
    const candidates = [...new Set(inside.flatMap((r) => r.candidates))];
    rows.push({ y: (sp.top + sp.bottom) / 2, top: sp.top, bottom: sp.bottom, candidates, missingBefore: 0 });
  }
  return rows;
}

// Cut the named cells out of every row, stack them into one image (one OCR call
// for the page) and return, per row, each cell's text lines (top to bottom).
async function readGrid(mask, W, H, rows, keys, geo, recognize, opts) {
  const { line, codeWidth } = geo;
  const inset = Math.max(4, Math.round(codeWidth * 0.08));
  const cellOf = (r, key) => {
    const c = key.startsWith('name') ? r.cells.names?.[Number(key.slice(4))] : r.cells[key];
    if (!c) return null;
    const xm = (c[0] + c[1]) / 2;
    return { x0: c[0] + inset, x1: c[1] - inset, y0: r.topLine(xm) + inset, y1: r.botLine(xm) - inset };
  };
  const grid = rows.map((r) => keys.map((k) => cellOf(r, k)));
  const colW = keys.map((_, k) => Math.max(0, ...grid.map((g) => (g[k] ? g[k].x1 - g[k].x0 : 0))));
  const slotH = Math.max(0, ...grid.flat().filter(Boolean).map((c) => c.y1 - c.y0));
  const result = rows.map(() => ({}));
  if (!slotH || !colW.some((w) => w > 0)) return result;
  const pad = Math.round(codeWidth * 0.6), gap = Math.round(codeWidth);
  const colX = []; let x = pad;
  for (const w of colW) { colX.push(x); x += Math.round(w) + gap; }
  const outW = Math.round(x - gap + pad), slot = Math.round(slotH) + pad, outH = pad + rows.length * slot;
  const out = new Uint8Array(outW * outH);
  grid.forEach((g, ri) => g.forEach((c, k) => {
    if (!c) return;
    const dx = colX[k], dy = pad + ri * slot;
    for (let y = Math.round(c.y0); y < Math.round(c.y1); y++) {
      if (y < 0 || y >= H) continue;
      for (let xx = Math.round(c.x0); xx < Math.round(c.x1); xx++) {
        if (xx >= 0 && xx < W && mask[y * W + xx]) out[(dy + y - Math.round(c.y0)) * outW + dx + xx - Math.round(c.x0)] = 1;
      }
    }
  }));
  const words = await recognize({ data: out, width: outW, height: outH }, opts);
  const bins = rows.map(() => keys.map(() => []));
  for (const w of words) {
    const c = centre(w.bbox), ri = Math.floor((c.y - pad / 2) / slot);
    if (ri < 0 || ri >= rows.length) continue;
    let k = colX.length - 1; while (k > 0 && c.x < colX[k] - gap / 2) k--;
    bins[ri][k].push({ text: w.text, x: c.x, y: c.y, h: w.bbox.y1 - w.bbox.y0 });
  }
  bins.forEach((cols, ri) => cols.forEach((ws, k) => {
    if (!ws.length) return;
    ws.sort((p, q) => p.y - q.y);
    const lines = [];
    for (const w of ws) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(w.y - last.y) < Math.max(w.h, 8) * 0.6) last.ws.push(w); else lines.push({ y: w.y, ws: [w] });
    }
    result[ri][keys[k]] = lines.map((l) => l.ws.sort((p, q) => p.x - q.x).map((w) => w.text).join(' '));
  }));
  return result;
}

// Printed S/Ns go up by one per row; find the offset most reads agree on.
export function assignSerials(rows, reads) {
  const votes = new Map();
  reads.forEach((n, i) => { if (Number.isFinite(n) && n > 0 && n < 1000) votes.set(n - i, (votes.get(n - i) || 0) + 1); });
  const valid = reads.filter((n) => Number.isFinite(n)).length;
  let best = null, count = 0;
  for (const [off, c] of votes) if (c > count) { best = off; count = c; }
  const ok = count >= 2 && count >= valid * 0.4;
  rows.forEach((r, i) => { r.sn = ok ? best + i : null; });
}

// "91110001||" / "91110002| 81110003|" -> ["91110001", ...]; Singapore numbers only
export function parsePhones(lines = []) {
  const out = [];
  for (const line of lines) for (const tok of String(line).split(/[^0-9]+/)) {
    if (/^[3689]\d{7}$/.test(tok)) out.push(tok);
    else if (/^[3689]\d{15}$/.test(tok) && /^[3689]/.test(tok.slice(8))) out.push(tok.slice(0, 8), tok.slice(8));
  }
  return out;
}

// 1st name goes with the 1st number, and so on. A number both reads agree on
// is marked sure; otherwise it's shown for checking.
export function pairRecipients(names, phonesA, phonesB) {
  const best = phonesB.length >= phonesA.length ? phonesB : phonesA, other = best === phonesB ? phonesA : phonesB;
  const n = Math.max(names.length, best.length);
  const list = [];
  for (let i = 0; i < n; i++) list.push({ name: names[i] || '', phone: best[i] || '', sure: !!best[i] && best[i] === other[i] });
  return list;
}

export function cleanName(text) {
  return String(text).toUpperCase().replace(/[^A-Z\-'@/.&() ]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^[^A-Z]+|[^A-Z)]+$/g, '');
}

// The sheet's DWindow: only the two real slots are accepted.
export function parseWindow(digits) {
  const d = String(digits).replace(/\D/g, '');
  return d === '09001330' ? 'am' : d === '13001800' ? 'pm' : '';
}
export function parseAttempt(digits) {
  const d = String(digits).replace(/\D/g, '');
  return d === '1' ? 1 : d === '2' ? 2 : null;
}

// Follow a horizontal grid line from (xStart, yStart) left to xLeft and right to
// xRight in steps, each time looking a few pixels up/down for where the line
// continues. Returns y(x) (straight between samples; flat beyond the ends).
export function traceLine(ink, W, H, xStart, yStart, xLeft, xRight, codeWidth) {
  const step = Math.max(10, Math.round(codeWidth * 0.8)), reach = Math.max(3, Math.round(step * 0.15));
  // ink hits along a straight piece from (xa, ya) to (xb, ya + dy), ±1px
  const along = (xa, xb, ya, dy) => {
    let hit = 0;
    for (let xx = Math.max(0, Math.round(xa)); xx < Math.min(W, Math.round(xb)); xx++) {
      const yy = Math.round(ya + dy * (xx - xa) / (xb - xa));
      if (yy >= 1 && yy < H - 1 && (ink[(yy - 1) * W + xx] | ink[yy * W + xx] | ink[(yy + 1) * W + xx])) hit++;
    }
    return hit;
  };
  // best next piece from the line point (x, y) going dir (-1 left, +1 right):
  // tries each slope; returns the hits and the line's y at the far end
  const nextPiece = (x, y, dir) => {
    let best = { hit: -1, y: y, dy: 0 };
    for (let dy = -reach; dy <= reach; dy++) {
      const hit = dir > 0 ? along(x, x + step, y, dy) : along(x - step, x, y - dy, dy);
      if (hit > best.hit || (hit === best.hit && Math.abs(dy) < Math.abs(best.dy))) best = { hit, dy, y: dir > 0 ? y + dy : y - dy };
    }
    return best;
  };
  // only trace from a real grid line: otherwise there's nothing to follow
  let start = { hit: -1 };
  for (let oy = -2; oy <= 2; oy++) {
    for (let dy = -reach; dy <= reach; dy++) {
      const ya = yStart + oy - dy / 2, hit = along(xStart - step / 2, xStart + step / 2, ya, dy);
      if (hit > start.hit) start = { hit, y: ya + dy / 2, dy };
    }
  }
  if (start.hit < step * 0.8) return null;
  const pts = [{ x: xStart, y: start.y }];
  for (const dir of [-1, 1]) {
    let x = xStart, y = start.y, lastDy = start.dy;
    const end = dir < 0 ? xLeft : xRight;
    while (dir < 0 ? x - step > end : x + step < end) {
      const p = nextPiece(x, y, dir);
      if (p.hit >= step * 0.6) { y = p.y; lastDy = p.dy; }
      else y += dir * lastDy; // line hidden here (pen, glare): carry on at the same slope
      x += dir * step;
      pts.push({ x, y });
    }
  }
  pts.sort((p, q) => p.x - q.x);
  return (x) => {
    if (x <= pts[0].x) return pts[0].y;
    for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) {
      const t = (x - pts[i - 1].x) / (pts[i].x - pts[i - 1].x);
      return pts[i - 1].y + t * (pts[i].y - pts[i - 1].y);
    }
    return pts[pts.length - 1].y;
  };
}

// A hand-drawn line through a row: a long, roughly horizontal stroke in the
// middle of the row (away from the printed grid lines) that runs across many
// cells. Printed text never forms a run that long. Only the printed columns
// (S/N .. PostCd) are checked, so signatures and ticks elsewhere don't count.
export function isStruckThrough(ink, W, H, r, line, codeWidth) {
  const h = r.bottom - r.top, K = Math.max(2, Math.round(h * 0.3));
  const xp = line.a * r.y + line.b;
  // no visible grid on this row: can't tell a strike from the table, so keep the row
  if (r.strikeX0 == null || !r.gridded) return false;
  const x0 = Math.max(1, Math.round(r.strikeX0 + 3)), x1 = Math.min(W - 2, Math.round(xp + codeWidth * 0.6));
  let prev = new Int32Array(2 * K + 1), cur = new Int32Array(2 * K + 1), best = 0;
  for (let x = x0; x <= x1; x++) {
    const yc = Math.round((r.topLine(x) + r.botLine(x)) / 2);
    for (let k = -K; k <= K; k++) {
      const y = yc + k;
      let on = 0;
      if (y >= 0 && y < H) on = ink[y * W + x - 1] | ink[y * W + x] | ink[y * W + x + 1];
      if (!on) { cur[k + K] = 0; continue; }
      const a = k > -K ? prev[k + K - 1] : 0, b = prev[k + K], c = k < K ? prev[k + K + 1] : 0;
      cur[k + K] = 1 + Math.max(a, b, c);
      if (cur[k + K] > best) { best = cur[k + K]; r.strikeAt = [x, y]; }
    }
    [prev, cur] = [cur, prev];
  }
  r.strikeRun = best;
  return best >= codeWidth * 6;
}

// x positions of vertical grid lines crossing the band y±halfBand: columns
// where (almost) every pixel row has ink within ±2px. Slight slant is fine.
export function columnEdges(ink, W, H, y, halfBand) {
  const y0 = Math.max(0, Math.round(y - halfBand)), y1 = Math.min(H - 1, Math.round(y + halfBand));
  const rowsInBand = y1 - y0 + 1, hits = new Uint16Array(W), prefix = new Int32Array(W + 1), win = 2;
  for (let yy = y0; yy <= y1; yy++) {
    const off = yy * W;
    for (let x = 0; x < W; x++) prefix[x + 1] = prefix[x] + ink[off + x];
    for (let x = 0; x < W; x++) {
      const a = Math.max(0, x - win), b = Math.min(W, x + win + 1);
      if (prefix[b] - prefix[a] > 0) hits[x]++;
    }
  }
  const edges = [];
  for (let x = 0; x < W; ) {
    if (hits[x] >= rowsInBand * 0.9) {
      let x2 = x; while (x2 + 1 < W && hits[x2 + 1] >= rowsInBand * 0.9) x2++;
      edges.push((x + x2) / 2); x = x2 + 1;
    } else x++;
  }
  return edges;
}

// Cut out every row's Flr and Unit cells, stack them into one image (one OCR
// call per page) and read the digits. Returns "07-11" style values per row.
async function readCells(mask, W, H, cells, rowH, codeWidth, recognize, upscale) {
  const inset = Math.max(4, Math.round(codeWidth * 0.08));
  const cellH = Math.round(rowH * 0.8), pad = Math.round(rowH * 0.3), gap = Math.round(codeWidth);
  const valid = cells.map((c, i) => c && { ...c, i }).filter(Boolean);
  if (!valid.length) return cells.map(() => '');
  const flrMax = Math.max(...valid.map((c) => c.flr[1] - c.flr[0])), unitMax = Math.max(...valid.map((c) => c.unit[1] - c.unit[0]));
  const outW = Math.round(pad + flrMax + gap + unitMax + pad), slot = cellH + pad, outH = pad + valid.length * slot;
  const out = new Uint8Array(outW * outH);
  const paste = (x0, x1, yc, dx, dy) => {
    const left = Math.round(x0 + inset), right = Math.round(x1 - inset), top = Math.round(yc - cellH / 2);
    for (let y = 0; y < cellH; y++) {
      const sy = top + y; if (sy < 0 || sy >= H) continue;
      for (let x = left; x < right; x++) if (x >= 0 && x < W && mask[sy * W + x]) out[(dy + y) * outW + dx + (x - left)] = 1;
    }
  };
  const flrX = pad, unitX = Math.round(pad + flrMax + gap);
  valid.forEach((c, k) => {
    const dy = pad + k * slot;
    paste(c.flr[0], c.flr[1], c.y, flrX, dy);
    paste(c.unit[0], c.unit[1], c.y, unitX, dy);
  });
  const words = await recognize({ data: out, width: outW, height: outH }, { digitsOnly: true, upscale });
  const parts = valid.map(() => ({ flr: [], unit: [] }));
  for (const w of words) {
    const t = w.text.replace(/[^0-9]/g, ''); if (!t) continue;
    const c = centre(w.bbox), k = Math.floor((c.y - pad / 2) / slot);
    if (k < 0 || k >= valid.length) continue;
    (c.x < unitX - gap / 2 ? parts[k].flr : parts[k].unit).push({ t, x: c.x });
  }
  const result = cells.map(() => '');
  valid.forEach((c, k) => {
    const join = (arr) => arr.sort((p, q) => p.x - q.x).map((a) => a.t).join('');
    result[c.i] = formatUnit([join(parts[k].flr), join(parts[k].unit)]);
  });
  return result;
}

// Make the photo just big enough that postcode digits are ~TARGET_DIGIT_PX
// tall, whatever distance it was taken from. `words` come from a quick read of
// the photo at `measuredLongSide`; returns the long side to resize to, or null.
export const TARGET_DIGIT_PX = 28;
export function chooseLongSide(words, measuredLongSide) {
  const heights = words
    .filter((w) => SIX.test(w.text.trim()) && w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0)
    .map((w) => w.bbox.y1 - w.bbox.y0);
  if (heights.length < 2) return null;
  return Math.round(Math.min(5200, Math.max(1600, measuredLongSide * TARGET_DIGIT_PX / median(heights))));
}

// ["07", "11"] -> "07-11"; landed houses ("00 00") and unclear readings -> "".
// The sheet always prints at least 2 digits for each, so a 1-digit reading
// means a clipped or misread number: rejected, never padded into a guess.
export function formatUnit(parts) {
  let floor, unit;
  if (parts.length === 2) [floor, unit] = parts;
  else if (parts.length === 1 && /^\d{4}$/.test(parts[0])) { floor = parts[0].slice(0, 2); unit = parts[0].slice(2); }
  else return '';
  if (!/^\d{2,3}$/.test(floor) || !/^\d{2,4}[A-Z]?$/.test(unit)) return ''; // units can be 4 digits (23-3005)
  if (/^0+$/.test(floor) && /^0+$/.test(unit)) return '';
  return `${floor}-${unit}`;
}

// Header words used to pick which way up the photo is.
const ORIENTATION_KEYS = ['PLEASE', 'ENVELOPES', 'POSTCD', 'SCH', 'DATE', 'ROUTE', 'BUILDINGNAME', 'LOCALSTREETNAME', 'STATUS', 'TIME'];
export function orientationScore(words) {
  // Tesseract can partly read sideways text, but those words come out taller
  // than wide. Only words laid out horizontally count as evidence.
  const flat = words.filter((w) => !w.bbox || w.bbox.x1 - w.bbox.x0 > w.bbox.y1 - w.bbox.y0);
  const seen = new Set(flat.map((w) => w.text.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  let score = 0;
  for (const k of ORIENTATION_KEYS) for (const s of seen) if (s.includes(k)) { score++; break; }
  return score + flat.filter((w) => SIX.test(w.text.trim())).length * 0.5;
}
