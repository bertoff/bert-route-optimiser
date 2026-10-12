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
//   opts  = { digitsOnly: boolean, upscale?: number (enlarge before reading; boxes come back in original pixels) }
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

  const rows = clusterRows(detections, rowH * 0.5);
  // Text on the same row, left of the postcode: street/building names used later to confirm the right code.
  for (const r of rows) {
    const xc = line.a * r.y + line.b;
    r.rowText = words
      .filter((w) => Math.abs(centre(w.bbox).y - r.y) < rowH * 0.6 && w.bbox.x1 < xc - codeWidth * 0.4)
      .sort((p, q) => p.bbox.x0 - q.bbox.x0)
      .map((w) => w.text).join(' ');
  }
  // Flr and Unit. On each row, the table's vertical grid lines left of the
  // postcode mark (right to left) PostCd | Street | Unit | Flr. Finding them
  // per row copes with photos taken closer, further or at an angle. Each Flr
  // and Unit cell is cut out between its lines and read on its own.
  onProgress('Reading floor and unit');
  const cells = rows.map((r) => {
    const xp = line.a * r.y + line.b;
    const edges = columnEdges(ink, W, H, r.y, rowH * 0.32).filter((x) => x < xp - codeWidth * 0.3).sort((p, q) => q - p);
    if (edges.length < 4) return null;
    const [ePost, eUnitR, eFlrR, eFlrL] = edges;
    const street = ePost - eUnitR, unitW = eUnitR - eFlrR, flrW = eFlrR - eFlrL;
    // sanity: the street cell is wide; Flr and Unit cells are narrow
    if (street < codeWidth * 1.2 || unitW < codeWidth * 0.3 || unitW > codeWidth * 2.2 || flrW < codeWidth * 0.3 || flrW > codeWidth * 2.2) return null;
    return { flr: [eFlrL, eFlrR], unit: [eFlrR, eUnitR], y: r.y };
  });
  const [readA, readB] = [await readCells(mask, W, H, cells, rowH, codeWidth, recognize, unitScales[0]),
    await readCells(mask, W, H, cells, rowH, codeWidth, recognize, unitScales[1])];
  // both reads are kept; the final vote (with the row-text read) happens in resolveRow,
  // and a unit is only shown when two readings agree: a wrong unit is worse than a blank
  rows.forEach((r, i) => { r.unitReads = [readA[i], readB[i]]; });

  // A gap of ~2 row-heights between readings means the scanner skipped a row there.
  let possibleMissing = 0;
  rows.forEach((r, i) => {
    r.missingBefore = i === 0 ? 0 : Math.max(0, Math.round((r.y - rows[i - 1].y) / rowH) - 1);
    possibleMissing += r.missingBefore;
  });
  return { rows, possibleMissing };
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
