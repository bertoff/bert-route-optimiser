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
  const mask = removeLines(binarize(gray, W, H, 12 * scale), W, H, 40 * scale);

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
  // Flr and Unit: two narrow columns a fixed distance left of PostCd (about 4
  // postcode-widths on this sheet; the printed "Flr"/"Unit" headers refine it
  // when they're readable). Read that strip in pieces, like the postcodes.
  onProgress('Reading floor and unit');
  const flrH = words.find((w) => /^Flr$/i.test(w.text.trim()));
  const unitH = words.find((w) => /^Unit$/i.test(w.text.trim()));
  let offset = 4.1 * codeWidth;
  if (flrH && unitH && Math.abs(centre(flrH.bbox).y - centre(unitH.bbox).y) < rowH * 0.5) {
    const cy = centre(flrH.bbox).y, measured = line.a * cy + line.b - (flrH.bbox.x0 + unitH.bbox.x1) / 2;
    if (measured > 2.5 * codeWidth && measured < 6 * codeWidth) offset = measured;
  }
  // Read the strip at two sizes. Together with the row-text read that makes
  // three independent readings; a unit is only shown when two of them agree
  // exactly, because a wrong unit is worse than a blank.
  const readUnits = async (upscale) => {
    const found = [];
    for (let y0 = top; y0 < H; y0 += step) {
      const mid = y0 + chunkH / 2;
      const xc = line.a * mid + line.b - offset, half = codeWidth * 0.95;
      const piece = cropMask(mask, W, H, xc - half, y0, 2 * half, chunkH);
      if (piece.width < 10 || piece.height < 10) continue;
      for (const w of await recognize(piece, { digitsOnly: true, upscale })) {
        const t = w.text.replace(/[^0-9]/g, '');
        if (!/^\d{2,4}$/.test(t)) continue;
        // a number touching the crop edge may be cut off ("11" -> "1"), so don't trust it
        if (w.bbox.x0 <= 2 || w.bbox.x1 >= piece.width - 2) continue;
        const c = centre(w.bbox);
        // rows run at right angles to the (possibly tilted) column, so shift y back to the PostCd row
        found.push({ t, x: piece.left + c.x, y: piece.top + c.y - line.a * offset });
      }
    }
    return rows.map((r) => {
      const near = found.filter((u) => Math.abs(u.y - r.y) < rowH * 0.45).sort((p, q) => p.x - q.x);
      const uniq = near.filter((u, i) => !near.slice(0, i).some((v) => Math.abs(v.x - u.x) < codeWidth * 0.3)); // overlapping pieces
      return formatUnit(uniq.map((u) => u.t));
    });
  };
  const [readA, readB] = [await readUnits(unitScales[0]), await readUnits(unitScales[1])];
  // both reads are kept; the final vote (with the row-text read) happens in resolveRow
  rows.forEach((r, i) => { r.unitReads = [readA[i], readB[i]]; });

  // A gap of ~2 row-heights between readings means the scanner skipped a row there.
  let possibleMissing = 0;
  rows.forEach((r, i) => {
    r.missingBefore = i === 0 ? 0 : Math.max(0, Math.round((r.y - rows[i - 1].y) / rowH) - 1);
    possibleMissing += r.missingBefore;
  });
  return { rows, possibleMissing };
}

// ["07", "11"] -> "07-11"; landed houses ("00 00") and unclear readings -> "".
// The sheet always prints at least 2 digits for each, so a 1-digit reading
// means a clipped or misread number: rejected, never padded into a guess.
export function formatUnit(parts) {
  let floor, unit;
  if (parts.length === 2) [floor, unit] = parts;
  else if (parts.length === 1 && /^\d{4}$/.test(parts[0])) { floor = parts[0].slice(0, 2); unit = parts[0].slice(2); }
  else return '';
  if (!/^\d{2,3}$/.test(floor) || !/^\d{2,3}[A-Z]?$/.test(unit)) return '';
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
