import { test } from 'node:test';
import assert from 'node:assert/strict';
import { postcodeOf, fitColumn, clusterRows, orientationScore } from '../src/sheet-ocr.js';
import { binarize, removeLines } from '../src/imageprep.js';
import { rowMatchesPlace, resolveRow, editDistance } from '../src/geocode.js';

test('postcodeOf keeps only clean 6-digit readings', () => {
  assert.equal(postcodeOf('260008'), '260008');
  assert.equal(postcodeOf('|260008'), '260008');
  assert.equal(postcodeOf('26000'), null);
  assert.equal(postcodeOf('2600081'), null);
});

test('fitColumn follows a tilted column and ignores an outlier', () => {
  const pts = [0, 100, 200, 300, 400].map((y) => ({ x: 500 + 0.05 * y, y }));
  pts.push({ x: 50, y: 250 }); // stray number elsewhere on the page
  const { a, b } = fitColumn(pts);
  assert.ok(Math.abs(a - 0.05) < 1e-6);
  assert.ok(Math.abs(b - 500) < 1e-6);
});

test('clusterRows merges two passes and ranks the commonest reading first', () => {
  const rows = clusterRows([
    { code: '260003', y: 100 }, { code: '260003', y: 104, weight: 1.5 },
    { code: '688001', y: 300 }, { code: '268802', y: 302, weight: 1.5 }, { code: '268802', y: 299, weight: 1.5 },
  ], 40);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].candidates, ['260003']);
  assert.deepEqual(rows[1].candidates, ['268802', '688001']);
});

test('orientationScore prefers the upright page', () => {
  const upright = [{ text: 'PLEASE' }, { text: 'ENVELOPES' }, { text: 'PostCd' }, { text: '260008' }];
  const sideways = [{ text: 'ʇ' }, { text: '3SV3Td' }];
  assert.ok(orientationScore(upright) > orientationScore(sideways));
  // same keywords, but read off sideways text: boxes are tall and thin
  const tall = [{ text: 'PLEASE', bbox: { x0: 0, y0: 0, x1: 12, y1: 80 } }, { text: 'ENVELOPES', bbox: { x0: 0, y0: 90, x1: 12, y1: 200 } }];
  const wide = [{ text: 'PLEASE', bbox: { x0: 0, y0: 0, x1: 80, y1: 12 } }];
  assert.equal(orientationScore(tall), 0);
  assert.equal(orientationScore(wide), 1);
});

test('removeLines erases a grid line but keeps a short text stroke', () => {
  const W = 60, H = 60, gray = new Uint8Array(W * H).fill(255);
  for (let y = 0; y < H; y++) gray[y * W + 10] = 0;             // long vertical grid line
  for (let y = 20; y < 32; y++) gray[y * W + 30] = 0;           // 12px digit stroke
  const out = removeLines(binarize(gray, W, H, 8), W, H, 40);
  assert.equal(out[30 * W + 10], 0, 'grid line removed');
  assert.equal(out[25 * W + 30], 1, 'text stroke kept');
});

test('rowMatchesPlace tolerates OCR typos in street names', () => {
  const place = { road: 'EMPRESS ROAD', building: 'FARRER GARDENS' };
  assert.ok(rowMatchesPlace('3 S****123A AA SAMPLE EMPLOYER PTE FARRER GARDENS 07 11 EMPRES5 ROAD', place));
  assert.ok(!rowMatchesPlace('12 S****456B DD SAMPLE PERSON GUTHRIE HOUSE FIFTH AVENUE', place));
  assert.equal(editDistance('EMPRES5', 'EMPRESS'), 1);
});

test('resolveRow skips invalid codes and prefers the one matching the row text', async () => {
  const db = {
    '268802': { road: 'FIFTH AVENUE', building: 'GUTHRIE HOUSE' },
    '268602': { road: 'SOMEWHERE ELSE', building: '' },
  };
  const lookup = async (c) => db[c] ?? null;
  const r = await resolveRow({ candidates: ['688001', '268602', '268802'], rowText: 'SAMPLE GUTHRIE HOUSE FIFTH AVENUE' }, lookup);
  assert.equal(r.postcode, '268802');
  assert.equal(r.status, 'ok');
  const unsure = await resolveRow({ candidates: ['268602'], rowText: 'GUTHRIE' }, lookup);
  assert.equal(unsure.status, 'check');
  const bad = await resolveRow({ candidates: ['111111'], rowText: '' }, lookup);
  assert.equal(bad.status, 'unreadable');
});

test('binarize works with a fractional radius (phone photos give non-integer scales)', () => {
  const W = 40, H = 40, gray = new Uint8Array(W * H).fill(255);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 13; x++) gray[y * W + x] = 0;
  const ink = binarize(gray, W, H, 18.63);
  assert.equal(ink[15 * W + 11], 1);
  assert.equal(ink[30 * W + 30], 0);
});

test('resolveRow reports "retry" (not "unreadable") when OneMap cannot be reached', async () => {
  const offline = async () => { throw new Error('Failed to fetch'); };
  const r = await resolveRow({ candidates: ['266477'], rowText: 'DUCHESS AVENUE' }, offline);
  assert.equal(r.status, 'retry');
  assert.equal(r.postcode, '266477');
});
