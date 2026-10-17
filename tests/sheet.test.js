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

test('formatUnit turns floor and unit readings into "07-11"', async () => {
  const { formatUnit } = await import('../src/sheet-ocr.js');
  assert.equal(formatUnit(['07', '11']), '07-11');
  assert.equal(formatUnit(['12', '171']), '12-171');
  assert.equal(formatUnit(['7', '1']), '', 'single digits mean clipped numbers: never padded into a guess');
  assert.equal(formatUnit(['0711']), '07-11');
  assert.equal(formatUnit(['00', '00']), '', 'landed house: no unit');
  assert.equal(formatUnit(['07']), '', 'only one number: unsure');
  assert.equal(formatUnit(['1', '07', '11']), '', 'three numbers: unsure');
});

test('extractUnit takes the two numbers just before the street name', async () => {
  const { extractUnit } = await import('../src/geocode.js');
  const place = { road: 'EMPRESS ROAD', building: 'FARRER GARDENS' };
  assert.equal(extractUnit('2 S****123A AA SAMPLE PTE 8 FARRER GARDENS 07 11 EMPRESS ROAD', place), '07-11');
  assert.equal(extractUnit('31 S****1A SAMPLE 19 04 50 EMPRESS ROAD', place), '04-50', 'block number before floor/unit is ignored');
  assert.equal(extractUnit('7 S****8B SAMPLE 90 EMPRESS ROAD', place), '', 'block number alone is not a unit');
  assert.equal(extractUnit('9 SAMPLE 7A 00 00 EMPRESS ROAD', place), '', 'landed');
});

test('voteUnit needs two matching reads', async () => {
  const { voteUnit } = await import('../src/geocode.js');
  assert.equal(voteUnit(['07-11', '07-11', '']), '07-11');
  assert.equal(voteUnit(['07-11', '', '07-11']), '07-11');
  assert.equal(voteUnit(['07-11', '07-01', '']), '', 'disagreement: blank, not a guess');
  assert.equal(voteUnit(['07-11', '', '']), '', 'a single read is not enough');
  assert.equal(voteUnit([]), '');
});

test('formatUnit accepts 4-digit units like 23-3005', async () => {
  const { formatUnit } = await import('../src/sheet-ocr.js');
  assert.equal(formatUnit(['23', '3005']), '23-3005');
  assert.equal(formatUnit(['01', '288']), '01-288');
  assert.equal(formatUnit(['', '288']), '', 'missing floor: blank');
});

test('columnEdges finds vertical grid lines (even slightly slanted) but not text', async () => {
  const { columnEdges } = await import('../src/sheet-ocr.js');
  const W = 200, H = 120, ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) { ink[y * W + 40] = 1; ink[y * W + 120 + Math.floor(y / 60)] = 1; } // straight + slanted line
  for (let y = 50; y < 70; y++) for (let x = 70; x < 74; x++) ink[y * W + x] = 1;                 // a 20px "digit" stroke
  const edges = columnEdges(ink, W, H, 60, 40);
  assert.equal(edges.length, 2);
  assert.ok(Math.abs(edges[0] - 40) <= 2 && Math.abs(edges[1] - 120.5) <= 3);
});

test('chooseLongSide scales the photo so digits are ~28px tall', async () => {
  const { chooseLongSide } = await import('../src/sheet-ocr.js');
  const word = (h) => ({ text: '260008', bbox: { x0: 0, x1: h * 4, y0: 0, y1: h } });
  assert.equal(chooseLongSide([word(14), word(14)], 1600), 3200, 'small text: enlarge');
  assert.equal(chooseLongSide([word(28), word(28)], 1600), 1600, 'already the right size');
  assert.equal(chooseLongSide([word(14)], 1600), null, 'too little evidence: let the caller decide');
});

test('phones: numbers split on |, Singapore numbers only, in order', async () => {
  const { parsePhones } = await import('../src/sheet-ocr.js');
  assert.deepEqual(parsePhones(['91110001||']), ['91110001']);
  assert.deepEqual(parsePhones(['91110002|', '81110003|']), ['91110002', '81110003']);
  assert.deepEqual(parsePhones(['8111000491110005']), ['81110004', '91110005'], 'two numbers run together');
  assert.deepEqual(parsePhones(['1234567|', '12345678']), [], 'not Singapore numbers');
});

test('recipients: 1st name with 1st number; agreeing reads are marked sure', async () => {
  const { pairRecipients } = await import('../src/sheet-ocr.js');
  const r = pairRecipients(['ANN TAN', 'BEN LIM'], ['91234567', '81234567'], ['91234567', '81234561']);
  assert.deepEqual(r[0], { name: 'ANN TAN', phone: '91234567', sure: true });
  assert.equal(r[1].name, 'BEN LIM');
  assert.equal(r[1].sure, false, 'reads disagree: flagged for checking');
  assert.ok(['81234567', '81234561'].includes(r[1].phone));
  assert.deepEqual(pairRecipients(['ANN TAN'], [], []), [{ name: 'ANN TAN', phone: '', sure: false }]);
});

test('names are cleaned; DWindow and DT only accept real values', async () => {
  const { cleanName, parseWindow, parseAttempt } = await import('../src/sheet-ocr.js');
  assert.equal(cleanName(' nur-ashiqin  binte | '), 'NUR-ASHIQIN BINTE');
  assert.equal(parseWindow('13001800'), 'pm');
  assert.equal(parseWindow('0900 1330'), 'am');
  assert.equal(parseWindow('1300180'), '', 'misread: left for the rider');
  assert.equal(parseAttempt('2'), 2);
  assert.equal(parseAttempt('7'), null);
});

test('S/N comes from the sequence most reads agree on', async () => {
  const { assignSerials } = await import('../src/sheet-ocr.js');
  const rows = Array.from({ length: 5 }, () => ({}));
  assignSerials(rows, [31, 32, NaN, 84, 35]); // one unread, one misread
  assert.deepEqual(rows.map((r) => r.sn), [31, 32, 33, 34, 35]);
  const few = [{}, {}];
  assignSerials(few, [7, NaN]);
  assert.deepEqual(few.map((r) => r.sn), [null, null], 'one read is not enough');
});

test('traceLine follows a tilted grid line', async () => {
  const { traceLine } = await import('../src/sheet-ocr.js');
  const W = 600, H = 200, ink = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) { const y = Math.round(150 - x * 0.07); ink[y * W + x] = 1; ink[(y + 1) * W + x] = 1; } // about 4 degrees
  const f = traceLine(ink, W, H, 500, Math.round(150 - 500 * 0.07), 0, W - 1, 60);
  assert.ok(f, 'found the line');
  assert.ok(Math.abs(f(40) - (150 - 40 * 0.07)) <= 3, `follows it to the left (got ${f(40)})`);
  assert.equal(traceLine(new Uint8Array(W * H), W, H, 300, 100, 0, W - 1, 60), null, 'no line: nothing to follow');
});

test('a hand-drawn strike through a row is detected; printed text is not', async () => {
  const { isStruckThrough, traceLine } = await import('../src/sheet-ocr.js');
  const W = 900, H = 120, cw = 50;
  const make = () => { const ink = new Uint8Array(W * H); for (let x = 0; x < W; x++) { ink[10 * W + x] = 1; ink[110 * W + x] = 1; } return ink; };
  const row = (ink) => ({ y: 60, top: 10, bottom: 110, strikeX0: 20, gridded: true,
    topLine: traceLine(ink, W, H, 850, 10, 0, W, cw), botLine: traceLine(ink, W, H, 850, 110, 0, W, cw) });
  const line = { a: 0, b: 850 };
  const text = make();
  for (let w = 0; w < 10; w++) for (let x = 40 + w * 80; x < 90 + w * 80; x++) for (let y = 50; y < 70; y += 4) text[y * W + x] = 1; // words
  assert.equal(isStruckThrough(text, W, H, row(text), line, cw), false);
  const struck = make();
  for (let x = 30; x < 860; x++) { const y = Math.round(60 + 4 * Math.sin(x / 40)); struck[y * W + x] = 1; struck[(y + 1) * W + x] = 1; }
  assert.equal(isStruckThrough(struck, W, H, row(struck), line, cw), true);
});
