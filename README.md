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

   **Flr-Unit** (e.g. `07-11`, `23-3005`) is read from each row's own Flr and
   Unit cells, found using the table's grid lines, so it works whether the photo
   is taken close up or further away. It's only filled in when two of three
   separate readings agree. Otherwise it's left blank rather than guessed (on
   the test photos: 27 of 28 filled, none wrong). Type any missing ones in the box next to the postal code
   (`7 11`, `#07-11` and `0711` all become `07-11`). Landed houses (`00-00`) show no unit.

   From the current sheet layout the scanner also reads:
   - **S/N**: from the sheet's own numbers (checked as a sequence)
   - **DWindow**: `09001330` becomes AM and `13001800` becomes PM; anything unclear is left for you
   - **Recipients**: RcptNames paired in order with the RcptHPNo numbers (split on `|`).
     Tap 👤 on a stop to see or edit them. Numbers the two reads disagree on are
     highlighted "check number".
   - **DT** (attempt 1 or 2): shown quietly in the 👤 details only; it never changes the route
   - **Crossed-out rows** (a pen line through the row): skipped and listed at the top
     with an **Add back** button. Other handwriting is ignored.

   The FIN and RcptIDs columns are never read or kept.
3. **Optimise**: envelopes for the same building become one stop. The order
   starts at your hub, ends at the last stop, and respects each envelope's
   delivery slot (**AM 9:00–1:30** or **PM 1:00–6:00**, or **Any**) and
   priority stops (☆). Use **Set all to** for the common slot, then change the
   few that differ.
   - **Early PM delivery**: a PM stop is delivered during the AM run when it's
     within 500 m (straight line; change it in ⚙︎ Settings) of a stop being
     delivered on time in the AM run. This is measured from that on-time stop, never
     chained through another early stop, and it never makes an AM stop late. Far PM stops wait for 13:00.
   - **Stable**: the same stops and settings always give the same route.
     Optimising again only replaces the order on screen if the new one is
     genuinely faster (at least 1 minute), and a message says which happened.
   - **Condos**: blocks of the same condo are planned as a short hop through its
     carpark, never a lap of the roads outside. Each building is attached to its
     own street from the address (not just the nearest road), so one-way loops
     come out the right way round.
   - **Entrances**: Navigate sends Google/Apple Maps the full address so they can use
     the condo's entrance. If they still get it wrong, tap **📍 Gate here** at the
     right entrance once: it's saved for every block of that condo and used for
     Navigate and planning from then on.
   - **Edit order**: on the Route screen, tap **✎ Edit order** and use ▲/▼;
     arrival times update as you move stops.
4. **Choose the finish**: every run starts at the hub (059764, changeable in ⚙︎).
   **Finish at** can be *Last stop (decide later)*, *Back to hub*, or one of two
   homes saved in ⚙︎ Settings. The order changes to suit: with a home picked,
   the last stops lead towards it.
5. **Ride**: tap **Navigate**, **📞 Call** or **WhatsApp** for a recipient, then mark **✓ Success**, **✗ Failed** or **Skip**.
   Buildings with several envelopes get ✓/✗ per envelope number (plus *All success* /
   *All failed*), and the Stops list shows S/F next to each envelope, so the
   sheet's Status column is easy to fill in. Tap an active button again to undo. Running late? Change
   **Finish at** on the Route screen and the remaining stops re-plan. Or tap
   **↻ Re-optimise remaining stops from here**.

Tips for good scans: keep the header row and columns in the photo, lay the
sheet flat, avoid shadows and glare, and scan pages in order (page 1 first).
Close-up or whole page both work. Always compare the envelope count with the
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

## Privacy

Photos are read on the phone and never saved or uploaded. Recipient names and
phone numbers are stored only on your phone (cleared with *Clear today's run*).
Only postal codes go to OneMap; only coordinates go to the travel-time service.

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
