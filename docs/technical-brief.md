# RUBEDO 3D Bid App — Technical Brief v0.2 (approved by Founder, Checkpoint 2, 29 Sep 2026)

## 1. Goal
Single-user web app for the Founder (RUBEDO.3D): enter a 3D model's print data, materials and packaging →
get a price bid using the Founder's method → save the bid with its files in Google Drive → browse saved bids.

Out of scope (v1): client accounts, sending quotes, payments, inventory, multiple users, sending prints to printers,
any backend or database.

## 2. Screens
1. **Home** — two big buttons: "ספרייה" (Library), "דגם חדש" (New model). Header shows sign-in state and a Settings link.
2. **New model** (same form is used for Edit):
   - Name (required), description, revision (default "V1"), material (select from Settings materials; sets ₪/kg, editable).
   - **Parts** (1..N): each part has name, quantity (default 1), grams, hours, source (`3mf` | `manual`).
     - "Upload sliced .3mf" button: parses the file; every plate becomes one part (name = object name(s), grams =
       plate weight, hours = prediction / 3600). Values stay editable (source switches to `manual` if edited).
       Material type from the file pre-selects the material if it exists in Settings.
       The plate picture (`Metadata/plate_N.png`) is offered as a model picture (checkbox, default on).
       The sliced .3mf file itself is attached to the bid.
     - "Add part manually" button.
     - If a file cannot be read: clear Hebrew error, nothing filled in, manual entry stays available.
   - Labor minutes.
   - Hardware (purchased materials) list: name, quantity, unit cost; add/remove rows.
   - "Includes packaging & shipping" toggle (default off). When on: packaging list (name, qty, unit cost) + shipping cost.
     When off: section hidden and contributes ₪0.
   - Pictures (jpg/png/webp, multiple), model file(s) (.stl / .3mf / .step, optional).
   - Live price panel: filament, hardware, labor, packaging, machine, landed cost, 50/60/70% prices; 70% highlighted.
   - Save button (disabled until name + at least one part with grams > 0 or hours > 0).
3. **Library** — grid of cards: cover picture (or placeholder), name, 70% price. Search by name. Sorted newest first.
   "Refresh library" button rebuilds the index from bid.json files.
4. **Model page** — name, revision, date, description, pictures gallery, parts table, hardware/packaging tables,
   cost breakdown, 50/60/70 prices (70% highlighted), link "Open folder in Drive",
   button "Download for Bambu Studio" (downloads the sliced .3mf; shown only if one exists; tooltip: double-click
   the downloaded file to open it in Bambu Studio), button "Edit".
5. **Settings** — all advanced inputs (see pricing defaults in CLAUDE.md), materials price list (name, ₪/kg; add/edit/remove),
   "Models folder" picker (Google Picker, pick `3d › models` once), computed printer ₪/hour shown read-only.

## 3. Auth & Drive
- Google Identity Services token client, scope `https://www.googleapis.com/auth/drive.file` only. Token in memory;
  on expiry, request a new one (silent prompt if possible). Sign-out clears it.
- Env vars (Vite): `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY` (Picker), `VITE_GOOGLE_APP_ID` (Picker; the Cloud
  project number). Provide `.env.example`.
- The chosen models folder ID is stored in the browser (localStorage key `rubedo.modelsFolderId`) — this is a pointer
  only, not data. If missing → the app asks to pick the folder (Settings) before saving/loading.
- The app can only see files it created or the folder the Founder picked (drive.file). That is expected.

## 4. Drive layout
```
<models folder picked by Founder>/
  _rubedo-settings.json   settings + materials (created with defaults on first run)
  _rubedo-index.json      cache: [{id(folderId), name, revision, price70, landed, coverFileId, updatedAt}]
  <model name>/            (if the name exists: "<model name> V2", V3 …)
    bid.json               source of truth (schema below)
    <pictures>, <stl/3mf/step>, <sliced .gcode.3mf>, plate picture "<name>-plate-1.png"
```
`bid.json` (schemaVersion 1):
```
{ schemaVersion, id(uuid), name, revision, description, createdAt, updatedAt,
  material: { name, pricePerKg },
  parts: [{ name, qty, grams, hours, source, slicedFileId? }],
  laborMinutes,
  hardware: [{ name, qty, unitCost }],
  hasShipping, packaging: [{ name, qty, unitCost }], shippingCost,
  settingsSnapshot: { efficiency, laborRate, printerCost, upgrades, maintenancePerYear, lifeYears, uptime, powerW, kwhPrice, buffer },
  result: { printerRate, filament, hardware, labor, packaging, machine, landed, price50, price60, price70 },
  files: [{ id, name, kind: "image"|"model"|"sliced", mimeType }], coverFileId? }
```

## 5. Save flow
1. Validate. Check name against index and folder listing. If taken → dialog: "Save as new revision" (folder "<name> V2",
   revision V2) or "Choose another name". Never overwrite another bid.
2. Create the model folder. Upload all files. 3. Write `bid.json` LAST. 4. Update `_rubedo-index.json`.
5. Any failure → Hebrew error, form data kept, retry reuses the created folder and skips already-uploaded files.
   A folder without `bid.json` never appears in the library.
Edit flow: update `bid.json` (keep id, createdAt; new updatedAt; settingsSnapshot kept unless user clicks
"Recalculate with current settings"), upload newly added files, update index.

## 6. Acceptance criteria
AC1  T0: with labor rate 20 and Example Part 1 inputs, results equal the spreadsheet (landed 15.01; 30.02/37.53/50.04).
AC2  T1–T3 with default settings produce exactly the table below (2-decimal display).
AC3  A model with several parts: totals = sum of parts × quantities.
AC4  Uploading `tests/fixtures/rooting-stand.gcode.3mf` creates one part: 55.94 g, 2.587 h (9312 s), material PLA,
     name contains "Rooting stand"; values remain editable.
AC5  An invalid/unsliced file shows an error and fills nothing (no silent 0).
AC6  Shipping toggle off → packaging section hidden and packaging cost ₪0; on → counted.
AC7  Save creates `<models>/<name>/` with bid.json + all uploaded files; bid.json written last.
AC8  Saving an existing name never overwrites; offers new revision (V2) or rename.
AC9  Library lists every saved model with cover picture, name, 70% price; folders without bid.json are ignored.
AC10 Model page shows description, breakdown, 50/60/70 prices, pictures, Drive folder link, and a download button for the
     sliced .3mf (only if present).
AC11 Changing Settings affects new bids only; an existing bid keeps its snapshot values.
AC12 The app requests only the drive.file scope and never persists the access token.
AC13 UI is Hebrew RTL and usable at 375 px width.

## 7. Test cases (default settings unless noted; printerRate = 0.66498)
| Case | grams | hours | labor min | Filament | Labor | Machine | Landed | 50% | 60% | 70% |
|---|---|---|---|---|---|---|---|---|---|---|
| T0 (laborRate 20) | 100 | 3.5 | 10 | 9.35 | 3.33 | 2.33 | 15.01 | 30.02 | 37.53 | 50.04 |
| T1 | 100 | 3.5 | 10 | 9.35 | 13.33 | 2.33 | 25.01 | 50.02 | 62.53 | 83.37 |
| T2 rooting-stand.3mf | 55.94 | 9312 s | 0 | 5.23 | 0.00 | 1.72 | 6.95 | 13.90 | 17.38 | 23.17 |
| T3 untitled.3mf | 123.22 | 19282 s | 0 | 11.52 | 0.00 | 3.56 | 15.08 | 30.17 | 37.71 | 50.28 |
All at ₪85/kg, no hardware, no packaging.

## 8. .3mf facts (verified on the Founder's files, Bambu Studio 02.08.02.61)
`Metadata/slice_info.config` (XML) → `<plate>` elements, each with `<metadata key="index">`, `key="prediction"` (seconds,
total estimated time), `key="weight"` (grams), `<object name="…">` children, `<filament type="PLA" used_g="…">`.
Plate picture: `Metadata/plate_<index>.png`. Unsliced project files have no `slice_info.config` → error
"This is not a sliced file — in Bambu Studio use File → Export → Export plate sliced file".
Read only these small entries with JSZip; never decompress the large `.gcode` entry.

## 9. Known limitations (accepted)
- "Open in Bambu Studio" links are blocked by Bambu for non-MakerWorld sites → download button instead.
- drive.file scope: the app only sees files it created (old models in the folder are not listed unless saved via the app).
- Google OAuth app stays in "Testing" mode (single user, free); sign-in shows an "unverified app" notice.
