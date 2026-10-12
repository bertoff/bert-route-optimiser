// Pure pixel helpers used before OCR. They work on plain arrays so the same
// code runs in the browser (canvas ImageData) and in Node tests.

// RGBA (canvas ImageData.data) -> grayscale Uint8Array
export function toGray(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < gray.length; i += 4, j++) {
    gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return gray;
}

// Adaptive threshold: a pixel is "ink" when it is clearly darker than its
// neighbourhood. Handles shadows and uneven lighting in phone photos.
// Returns Uint8Array with 1 = ink, 0 = paper.
export function binarize(gray, width, height, radius = 15, k = 0.85) {
  radius = Math.max(1, Math.round(radius)); // fractional radius would index between pixels
  // Uint32 halves memory on phones; fall back to Float64 if sums could overflow.
  const fits = width * height * 255 < 2 ** 32;
  const integral = fits ? new Uint32Array((width + 1) * (height + 1)) : new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + rowSum;
    }
  }
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * (width + 1) + x1 + 1] - integral[y0 * (width + 1) + x1 + 1]
        - integral[(y1 + 1) * (width + 1) + x0] + integral[y0 * (width + 1) + x0];
      ink[y * width + x] = gray[y * width + x] < (sum / area) * k ? 1 : 0;
    }
  }
  return ink;
}

// Erase long straight runs of ink (table grid lines) so digits no longer touch
// them. Text strokes are far shorter than `minRun`, so they survive.
export function removeLines(ink, width, height, minRun) {
  minRun = Math.round(minRun);
  const out = ink.slice();
  // vertical runs (allow 1px gaps so slightly broken lines still count)
  for (let x = 0; x < width; x++) {
    let start = -1, gap = 0;
    for (let y = 0; y <= height; y++) {
      const on = y < height && (ink[y * width + x] || (x > 0 && ink[y * width + x - 1]) || (x < width - 1 && ink[y * width + x + 1]));
      if (on) { if (start < 0) start = y; gap = 0; }
      else if (start >= 0 && (++gap > 1 || y === height)) {
        const end = y - gap;
        if (end - start + 1 >= minRun) for (let yy = start; yy <= end; yy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx >= 0 && xx < width) out[yy * width + xx] = 0;
        }
        start = -1; gap = 0;
      }
    }
  }
  // horizontal runs
  for (let y = 0; y < height; y++) {
    let start = -1, gap = 0;
    for (let x = 0; x <= width; x++) {
      const on = x < width && (ink[y * width + x] || (y > 0 && ink[(y - 1) * width + x]) || (y < height - 1 && ink[(y + 1) * width + x]));
      if (on) { if (start < 0) start = x; gap = 0; }
      else if (start >= 0 && (++gap > 1 || x === width)) {
        const end = x - gap;
        if (end - start + 1 >= minRun) for (let xx = start; xx <= end; xx++) for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy >= 0 && yy < height) out[yy * width + xx] = 0;
        }
        start = -1; gap = 0;
      }
    }
  }
  return out;
}

// 1/0 ink mask -> RGBA (black text on white) for handing to OCR / canvas
export function inkToRGBA(ink) {
  const rgba = new Uint8ClampedArray(ink.length * 4);
  for (let j = 0, i = 0; j < ink.length; j++, i += 4) {
    const v = ink[j] ? 0 : 255;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255;
  }
  return rgba;
}
