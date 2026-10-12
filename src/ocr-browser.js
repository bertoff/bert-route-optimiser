// Browser glue for reading a sheet photo: decode, find which way up it is,
// enlarge, then hand pixels to the shared sheet reader. OCR runs on the phone
// with Tesseract.js (loaded from a CDN in index.html); photos never leave it.

import { toGray, inkToRGBA } from './imageprep.js';
import { readSheet, orientationScore, chooseLongSide, TARGET_DIGIT_PX } from './sheet-ocr.js';

const BASE_LONG_SIDE = 2576; // readSheet's pixel sizes were tuned at this size x scale

let workerPromise = null;
function getWorker(onProgress) {
  if (!workerPromise) {
    onProgress?.('Loading text reader (first time only)…');
    // global Tesseract comes from the <script> tag
    workerPromise = Tesseract.createWorker('eng');
  }
  return workerPromise;
}

function drawRotated(bitmap, degrees, longSide) {
  const s = longSide / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * s), h = Math.round(bitmap.height * s);
  const swap = degrees % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w; canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
  return canvas;
}

function maskToCanvas({ data, width, height }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(inkToRGBA(data), width, height), 0, 0);
  return canvas;
}

function enlarge(canvas, k) {
  const big = document.createElement('canvas');
  big.width = canvas.width * k; big.height = canvas.height * k;
  const ctx = big.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, big.width, big.height);
  return big;
}

async function recognizeWords(worker, image, { digitsOnly, upscale = 1 }) {
  await worker.setParameters(digitsOnly
    ? { tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '6' }
    : { tessedit_char_whitelist: '', tessedit_pageseg_mode: '3' });
  const { data } = await worker.recognize(upscale > 1 ? enlarge(image, upscale) : image);
  const k = upscale;
  return data.words.map((w) => ({ text: w.text, bbox: { x0: w.bbox.x0 / k, y0: w.bbox.y0 / k, x1: w.bbox.x1 / k, y1: w.bbox.y1 / k } }));
}

/** @returns {Promise<{rows, possibleMissing, error?}>} */
export async function readSheetPhoto(file, onProgress = () => {}) {
  const worker = await getWorker(onProgress);
  const bitmap = await createImageBitmap(file); // browsers apply the photo's EXIF rotation

  // 1. Which way up? A landscape sheet shot in portrait is usually turned 90°.
  onProgress('Finding which way up the sheet is…');
  const tries = bitmap.height > bitmap.width ? [270, 90, 0, 180] : [0, 180, 270, 90];
  let best = { deg: tries[0], score: -1, words: [] };
  for (const deg of tries) {
    const words = await recognizeWords(worker, drawRotated(bitmap, deg, 1600), { digitsOnly: false });
    const score = orientationScore(words);
    if (score > best.score) best = { deg, score, words };
    if (score >= 3) break; // wrong orientations score ~0, so 3 is already clear
  }

  // 2. Resize so the text is a standard size however close the photo was taken
  //    (small text reads far better enlarged), then read the sheet.
  const auto = chooseLongSide(best.words, 1600);
  const longSide = auto ?? Math.min(4600, Math.max(4000, Math.max(bitmap.width, bitmap.height)));
  const scale = auto ? TARGET_DIGIT_PX / 14 : longSide / BASE_LONG_SIDE;
  const canvas = drawRotated(bitmap, best.deg, longSide);
  bitmap.close?.();
  const { width, height } = canvas;
  const gray = toGray(canvas.getContext('2d').getImageData(0, 0, width, height).data, width, height);
  canvas.width = canvas.height = 0; // free memory early on phones

  return readSheet(gray, width, height,
    (img, opts) => recognizeWords(worker, maskToCanvas(img), opts),
    { scale, onProgress });
}
