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

---
# Addendum v0.3 — Existing models & manual photos (Founder decisions, 30 Sep 2026)

## Decisions
- D-A **Drive access:** scopes = `drive.file` + `drive.readonly`. The app may READ everything (to see existing model
  folders and photos the Founder adds directly in Drive) but WRITES only files it created (bid.json, index, settings,
  new model folders, uploads). Still never deletes, never modifies/moves files it did not create.
- D-B **Models without a sliced file** appear in the library as "דורש סלייס" (needs slicing): no price, but name,
  cover picture and files.
- D-C Models folder = `3D › models` (the Founder re-picks it in Settings; the earlier pick was the parent `3D`).

## New behaviour
N1 **Library = every direct subfolder of the models folder** (skip names starting with `_` and the folder "Models photo").
   - Has `bid.json` → normal priced card (as today).
   - No `bid.json` → "needs slicing" card: folder name, cover, badge "דורש סלייס". If the folder contains a sliced
     `.gcode.3mf`, the badge is "נמצא קובץ סלייס — צור הצעה" instead.
N2 **Create bid from an existing folder:** from a needs-slicing card/page, button "צור הצעת מחיר" opens the bid form
   prefilled: name = folder name; if a sliced .gcode.3mf is in the folder it is parsed and becomes the part(s) (source
   3mf, slicedFileId = that existing file — not re-uploaded). Saving writes `bid.json` (+ any newly added uploads) INTO
   THAT EXISTING FOLDER — no new folder, no name-conflict dialog for that folder.
N3 **Photos from Drive:** a model page shows ALL images in its folder (not only those listed in bid.json), incl. photos
   added manually later. Cover = bid.coverFileId if set, else the first image in the folder (by name), else plate picture.
   Use Drive `thumbnailLink` (sized, e.g. `=s800`) for display so HEIC photos from iPhone render; full image via link.
N4 **Model files list** on the model page = all non-image files in the folder (STL/3MF/STEP/ZIP/…), each with a Drive
   link; sliced files get the "Download for Bambu Studio" button.
N5 Index cache stores both kinds (`status: "priced" | "needs-slicing"`) and is rebuilt by "רענון ספרייה"; the library
   also auto-refreshes once on open if the index is older than 10 minutes.
N6 Nothing in N1–N5 may modify or move files the app did not create.

## Acceptance criteria (additional)
AC14 A models-folder subfolder without bid.json appears as a needs-slicing card with its name.
AC15 Such a folder containing `tests/fixtures/rooting-stand.gcode.3mf` shows the "sliced file found" badge; "create bid"
     prefills 55.94 g / 2.587 h; saving writes bid.json into the SAME folder, uploads nothing already present, and the
     card becomes priced (₪23.17 at defaults).
AC16 An image added to a priced model's folder after saving (not in bid.json) appears on its model page.
AC17 Requested scopes are exactly drive.file + drive.readonly; no write/delete call targets a file not created by the app.

---
# Addendum v0.4 — Stay signed in + write into existing folders (Founder decision, 30 Sep 2026)
Supersedes v0.3 D-A (scopes) and the "no backend" rule. Reason: Founder wants to sign in once and stay signed in;
v0.3 validation showed drive.file cannot write bid.json into the Founder's existing folders (C1) and thumbnail
fetches are blocked by CORS so iPhone HEIC photos never render (C2).

## Decisions
- D-E **Small backend = Vercel Serverless Functions in `/api` only** (Node, free tier). No database, no other services.
- D-F **Scope:** `https://www.googleapis.com/auth/drive` (full). Needed to create bid.json inside existing folders.
  The app's own write rules stay strict (N6+): the ONLY writes allowed are (a) creating new files/folders,
  (b) updating content of files that carry `appProperties.rubedo = "1"` (set on everything the app creates).
  Never delete, trash, move, rename, or change permissions of anything. Enforced in code + tests.
- D-G **Sessions:** OAuth authorization-code flow with `access_type=offline`. The refresh token lives ONLY in an
  encrypted (AES-256-GCM), `HttpOnly; Secure; SameSite=Lax; Path=/api` cookie, max-age 180 days. Encryption key =
  HKDF-SHA256(GOOGLE_CLIENT_SECRET, info "rubedo-session-v1") — no extra secret to manage.
  Access tokens: minted by the backend, returned to the SPA, kept in memory only (never storage/cookies in JS).
- D-H **Single user:** callback rejects any Google account other than `ALLOWED_EMAIL` (env, default raztz2@gmail.com)
  with a Hebrew error page; no cookie is set.

## Endpoints
- `GET /api/auth/login` → 302 to Google (client_id from `GOOGLE_CLIENT_ID` or `VITE_GOOGLE_CLIENT_ID`, redirect_uri =
  `${origin}/api/auth/callback`, scope drive + openid email, access_type=offline, prompt=consent, `state` = random,
  stored in a short-lived HttpOnly cookie, include_granted_scopes=false).
- `GET /api/auth/callback` → verify state; exchange code; verify email (id_token / userinfo) == ALLOWED_EMAIL;
  require a refresh_token and the drive scope; set session cookie; 302 to `/`.
- `POST /api/auth/token` → decrypt cookie, refresh → `{access_token, expires_in, email}`; 401 JSON if no/invalid
  session (cookie cleared). Reject if `Origin` header present and ≠ request origin (CSRF). `Cache-Control: no-store`.
- `POST /api/auth/logout` → revoke refresh token at Google (best effort), clear cookie, 204.
- `GET /api/thumb?id=<fileId>&s=<px>` → requires valid session; fetch file metadata `thumbnailLink` with the token,
  download it server-side, stream image back (`Cache-Control: private, max-age=3600`). 404 if no thumbnail.
  `id` must match `^[A-Za-z0-9_-]{10,}$`; `s` clamped 64–1600. Only googleusercontent.com / google.com thumbnail
  hosts are fetched (no SSRF).
- Secrets needed in Vercel env (Founder adds; agents never handle them): `GOOGLE_CLIENT_SECRET` (sensitive).
  Optional `ALLOWED_EMAIL`.

## Front-end changes
- Sign-in button → navigate to `/api/auth/login` (full redirect, no popup → works on mobile Safari).
- On app start: `POST /api/auth/token`; 200 → signed in silently (no click). 401 → signed-out state.
- Before expiry (≈5 min early) and on any Drive 401: refresh via `/api/auth/token` (shared in-flight promise).
  If the session is gone → existing "needs reconnect" banner (form stays mounted).
- Remove GIS token client. Keep Google Picker (setOAuthToken with the access token) for choosing the models folder.
- Images: `<img src="/api/thumb?id=…&s=…">` for all Drive images incl. HEIC; concurrency no longer needed for thumbs.
- Everything the app creates gets `appProperties: { rubedo: "1" }`; library "failed-save" hiding (v0.3) uses this
  marker instead of `isAppAuthorized`.
- Local dev: `vercel dev` or a Vite proxy note in README; demo mode (`?demo=1`) unchanged, no backend needed.

## Also fix (validator findings on v0.3)
- I3 edit of an N2 bid must not force a plate picture as permanent cover (use folder photos first).
- I4 `/model/:id/create` must verify the folder is a direct child of the models folder and not skipped.
- I2 when Settings are freshly created in a folder, show a one-time Hebrew notice.
- M2 hide the download button for native Google files (`application/vnd.google-apps.*`).
- M3 prefer the `bid.json` that has the app marker. M4 error-box retry must re-run the refresh.

## Acceptance criteria (additional)
AC18 With a valid session cookie, opening the app signs in with NO click; reload keeps the user signed in.
AC19 A non-allowed Google account is rejected at callback; no session cookie is set.
AC20 `/api/auth/token` without cookie → 401; with tampered cookie → 401 and cookie cleared; cross-origin Origin → 403.
AC21 bid.json can be created inside an existing Founder folder (N2) — in tests via memory drive with realistic
     permissions (drive scope = write allowed to create children anywhere).
AC22 No code path can delete/trash/move/rename, or update content of a file lacking `appProperties.rubedo="1"`.
AC23 `/api/thumb` returns an image for a HEIC file's thumbnail, rejects invalid ids and non-Google hosts.
AC24 No secret or refresh token is ever sent to the browser JS, logged, or committed.

---
# Addendum v0.5 — Optional hardware + quote email as Gmail draft (Founder decisions, 1 Oct 2026)

## Decisions
- D-I **Optional hardware, chosen per quote:** a model stores its full hardware list; each line has
  `included: boolean` (default true; missing = true for old bids). Only included lines count in the price.
  Example: "RootLab — 5-Tube Plant Propagation Station" sold with or without a plant.
- D-J **Quote email = Gmail DRAFT.** The app creates a draft in the Founder's Gmail (text + selected photos
  attached); the Founder reviews and clicks Send in Gmail. The app NEVER sends email itself.
  Scope added: `https://www.googleapis.com/auth/gmail.compose`. Only `users.drafts.create` may be called —
  no messages.send, drafts.send, modify, delete, or reading mail. Enforced in code + static test.

## Behaviour
Q1 **Bid form:** each hardware row gets a checkbox "כלול במחיר" (default on). Live price uses included rows only.
   Saved bid.json keeps all rows with their `included` flag (schemaVersion 2; v1 read as included=true).
Q2 **Pricing:** `hardware = Σ(qty × unitCost) for included rows`. Formula otherwise unchanged (CLAUDE.md updated).
Q3 **"שליחת הצעת מחיר" screen** (from a priced model page), route `/model/:id/quote`:
   - Hardware checklist (pre-ticked from the bid) → price recalculated live with the bid's settingsSnapshot.
   - Price shown to the customer: editable field, default = 70% price rounded UP to the whole shekel.
   - Customer name, customer email (validated), optional delivery-time text, optional note.
   - Photo picker: all images in the model folder as thumbnails with checkboxes (default: cover only).
   - Hebrew email preview (RTL HTML + plain-text alternative), subject and body editable before creating the draft:
     subject `הצעת מחיר — {model} | RUBEDO.3D`; body: greeting with name, description, "מה כלול" (included
     hardware names; if none, omit section), price line `מחיר: ₪{price}`, delivery time if filled, note if filled,
     signature `RUBEDO.3D — הדפסות תלת-ממד בהתאמה אישית` + Founder email. No internal costs/margins ever appear.
   - Button "צור טיוטה ב-Gmail" → creates the draft → success box with a link to open Gmail drafts
     (`https://mail.google.com/mail/#drafts`).
   - Photos are attached as JPEG via the thumb proxy at 1600 px (so HEIC works); total attachments capped at
     20 MB with a clear Hebrew error if exceeded.
Q4 **Quote log:** after a draft is created, the app writes `quotes/quote-YYYYMMDD-HHmm.json` inside the model folder
   (app-created subfolder `quotes`, marked) with: date, customer name+email, included hardware, price shown,
   the bid's landed cost & 70% price, draft id. (Business memory for later analysis.)
Q5 **Scope handling:** login requests drive + gmail.compose. `/api/auth/token` also returns `scopes`. If gmail.compose
   is missing (sessions created before v0.5), the quote screen shows "נדרש אישור נוסף ל-Gmail" with a button that runs
   the popup reconnect; nothing else in the app is blocked.

## Acceptance criteria
AC25 Unticking a hardware row removes exactly its qty×unitCost from landed cost; saved bid keeps the row with included=false.
AC26 Old bid.json (no `included`) prices identically to before.
AC27 Quote screen: toggling hardware updates price live; default customer price = ceil(price70 of current selection).
AC28 Draft MIME is valid (multipart/mixed with multipart/alternative text+html, UTF-8 Hebrew subject RFC 2047-encoded,
     attachments base64 image/jpeg); created via drafts.create only.
AC29 Static test: no Gmail endpoint other than drafts.create appears in src/ or api/; no internal cost fields in the email.
AC30 Quote log file is written (marked) in `<model>/quotes/` after a successful draft; nothing written if draft fails.
AC31 Session without gmail.compose → quote screen shows the extra-permission prompt; rest of app works.

---
# Addendum v0.6 — Editing, model cover, description, customers list (Founder request, 2 Oct 2026)

## Founder request
"I want to be able to edit bids, add a profile picture to the model, edit the description, and have a customers
list so I can send another quote to an existing customer quickly."

## Behaviour
E1 **Edit is obvious and complete.** Model page shows a prominent "עריכת הצעה" button. Edit covers every bid field:
   name, description, material/price per kg, parts (add/remove/edit, replace sliced file), labor, hardware rows
   (add/remove/edit, included flag), packaging/shipping, add photos/files. Saving rewrites the marked bid.json only.
   Edit offers "חשב מחדש לפי ההגדרות הנוכחיות" (existing behaviour) and keeps the snapshot otherwise.
   Pre-v0.4 (unmarked) bids: the read-only notice offers "המר להצעה ניתנת לעריכה" = the existing "create again"
   flow, prefilled with ALL old values, writing a new marked bid.json beside the old one; afterwards it edits normally.
E2 **Model cover ("profile picture").** On the model page every image has "קבע כתמונה ראשית". Sets `coverFileId`
   in bid.json (marked bid) — used in library card and model page header. For folders WITHOUT bid.json
   (needs-slicing), the choice is stored in a small marked file `<folder>/_rubedo-model.json` `{coverFileId, description}`
   so the library shows it too. Upload-a-new-photo-as-cover also available (uploads image into the folder, then sets it).
E3 **Description edit inline.** On the model page, the description has an edit (pencil) action → textarea → save
   without opening the full form. Priced: writes bid.json; needs-slicing: writes `_rubedo-model.json`. Max 2000 chars.
   When a bid is later created from a needs-slicing folder, cover + description from `_rubedo-model.json` prefill it.
E4 **Customers list.**
   - Store: `<models folder>/_rubedo-customers.json` (marked, app-owned):
     `[{id, name, email, phone?, notes?, createdAt, updatedAt}]`. Email unique (case-insensitive).
   - New page "לקוחות" (header nav): search by name/email, list with last quote date and number of quotes,
     add/edit customer (name, email, phone, notes). No delete in v0.6 (consistent with no-delete policy); "הסתר"
     flag instead (hidden customers excluded from pickers, shown under a toggle).
   - Customer page: all quotes sent to them (from every model's quote logs, newest first: date, model, price shown,
     link to the model) + button "שליחת הצעה חדשה" → choose model → quote screen prefilled with this customer.
   - Quote screen: customer picker (type-ahead on name/email) above the name/email fields; picking fills them.
     A new name+email typed in the quote screen is added to the customer list automatically after the draft succeeds
     (never before). If the email exists with a different name, keep the stored name and show a small notice.
   - Quote logs (Q4) gain `customerId`. Old logs without it are matched by email.
   - Customer history is built by scanning `quotes/quote-*.json` across model folders (concurrency-limited), cached
     in `_rubedo-index.json` (add a `customers` summary) and refreshed with "רענון ספרייה".

## Acceptance criteria
AC32 Editing a marked bid changes only that bid.json (marker kept); every field listed in E1 round-trips.
AC33 Converting a pre-v0.4 bid creates a new marked bid.json with all old values; the old file is untouched.
AC34 Setting a cover on a priced model updates coverFileId; on a needs-slicing folder writes `_rubedo-model.json`;
     library card shows the chosen cover in both cases.
AC35 Inline description edit persists for priced and needs-slicing models; 2000-char limit enforced.
AC36 Customers: add/edit/hide/search; email uniqueness; nothing is ever deleted.
AC37 Quote screen picker fills name+email; a new customer is saved only after a successful draft; failed draft saves nothing.
AC38 Customer page lists quotes from all models (incl. old logs matched by email) newest first, and "new quote"
     opens the quote screen prefilled.

---
# Addendum v0.7 — Remove model from library = archive (Founder decision, 3 Oct 2026)
Founder asked for "delete a model from the library" and chose **remove from library only** (no Drive deletion).

A1 Model page (priced and needs-slicing) gets "הסר מהספרייה" → confirm dialog ("המודל יוסתר מהספרייה. הקבצים נשארים
   ב-Drive ואפשר לשחזר מהארכיון.") → sets `archived: true` + `archivedAt`:
   priced (marked bid.json) → in bid.json via the existing stale-safe update path;
   needs-slicing or pre-v0.4 bid → in `<folder>/_rubedo-model.json` (marked, create or update).
A2 Library hides archived models by default. A toggle/link "ארכיון (N)" shows only archived models, each with
   "שחזר לספרייה" (sets archived:false). Search works in both views.
A3 Archived models: excluded from the customer-page model chooser; their quote history stays visible on customer pages.
   Opening an archived model's page directly works and shows a banner "המודל בארכיון" + restore button.
A4 Index stores `archived` per entry (index schemaVersion bump; old index = stale).
A5 Still NO delete/trash/move/rename anywhere; static safety test unchanged.

AC39 Archiving a priced model writes only its bid.json (marker kept); a needs-slicing model writes only _rubedo-model.json;
     card disappears from the main library and appears under the archive; no other Drive change.
AC40 Restore brings it back; data identical apart from archived/archivedAt/updatedAt.
AC41 Archived models are absent from the "new quote" model chooser but their quotes remain on customer pages.
