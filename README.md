# Rider Route

A free route planner for delivery riders in Singapore. Take photos of your
tasking sheet, check the stops, tap **Optimise route**, then ride stop by stop
with Google Maps, Waze or Apple Maps.

No paid apps, no accounts, no stop limit.

## How it works

1. **Scan**: the app reads the **PostCd** column of each sheet page on your
   phone (photos never leave the phone and are never saved).
2. **Check**: each postal code is looked up on OneMap. Every building in
   Singapore has its own postal code, so this finds the exact block. The app
   compares that address with the street name printed on the same row:
   - ✓ **matches sheet**: the address matches the street printed on that row
   - ⚠ **check against sheet**: real postal code, but the row was too blurry to confirm
   - ✗ **not a real postal code**, or **scanner skipped this row**: type it in
   - ↻ **couldn't check yet**: no signal or OneMap busy; tap *Retry address checks*
3. **Optimise**: envelopes for the same building become one stop. The order
   starts at your hub, ends at the last stop, and respects any time windows (⏰)
   and priority stops (☆).
4. **Ride**: tap **Navigate**, then **✓ Done** or **Skip**. If plans change, tap
   **↻ Re-optimise remaining stops from here**.

Tips for good scans: lay the sheet flat, fill the frame, avoid shadows, and
scan pages in order (page 1 first). Always compare the envelope count with the
sheet.

## Run it on this PC

Needs [Node.js](https://nodejs.org) (already installed here). From this folder:

```bash
npm start
```

Then open http://localhost:8080. A phone on the same Wi-Fi can use the second
address it prints (the camera works; the "from here" GPS start needs https).

## Put it on your phone (free, via GitHub Pages)

1. Push this folder to a GitHub repository (it must be **public** for free
   GitHub Pages; the code holds no personal data, and photos are blocked by `.gitignore`).
2. On GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
3. Open `https://<your-username>.github.io/<repo-name>/` in Safari on your
   iPhone → **Share → Add to Home Screen**.

## Tests

```bash
npm test
```

These cover the optimiser (including a brute-force check that it finds the best
order on small cases), time windows, priority, grouping, image cleaning, row
merging and address matching.

## Limits to know

- **Travel times use car roads.** The free service has no motorbike profile,
  so arrival times are a little cautious, and there is no live traffic.
- **OCR is good, not perfect.** On the test sheets it read 33 of 33 postal codes,
  but blurry or angled photos will need more fixing. The check screen is there for that.
- **Free public services.** OneMap (address lookup, ~250 requests/minute) and
  the OSRM demo server (one request per optimisation) are free shared services
  and could change. If OSRM is down, the app falls back to straight-line estimates
  and says so.

## Credits

- Addresses and map tiles: [OneMap](https://www.onemap.gov.sg/) © Singapore Land Authority
- Travel times: [OSRM](https://project-osrm.org/), road data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Text reading: [Tesseract.js](https://github.com/naptha/tesseract.js) · Map: [Leaflet](https://leafletjs.com/)

## Code map

| File | What it does |
|---|---|
| `src/sheet-ocr.js` | Finds and reads the PostCd column (fixed sheet layout) |
| `src/imageprep.js` | Cleans the photo: black/white, removes table grid lines |
| `src/ocr-browser.js` | Rotates/enlarges the photo and runs Tesseract on the phone |
| `src/geocode.js` | OneMap lookups (rate-limited, retried, cached) and street matching |
| `src/matrix.js` | Travel-time providers (OSRM now; add Google/Mapbox here later) |
| `src/optimize.js` | Stop-order optimiser (time windows, priority, open route) |
| `src/plan.js` | Groups envelopes per building and builds the plan |
| `src/app.js` | Screens and buttons |
