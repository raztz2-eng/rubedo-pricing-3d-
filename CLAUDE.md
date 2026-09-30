# CLAUDE.md — RUBEDO 3D Bid App

Rulebook for every AI agent working in this repo. Read it fully before doing anything.
Owner / final decision maker: the Founder (Raz). Company: RUBEDO.3D.

## What this app is
A single-user web app that prices 3D-printed models (bids) using the Founder's spreadsheet method,
saves each bid with its files to the Founder's Google Drive, and shows a library of saved bids.
Full spec: `docs/technical-brief.md` (source of truth for scope). If the code and the brief disagree, the brief wins
— or escalate; never silently change scope.

## Stack
- React 18 + Vite + TypeScript (strict), Tailwind CSS (via `@tailwindcss/vite`), React Router
- Vitest (+ @testing-library/react, jsdom) for unit & acceptance tests
- JSZip for reading sliced `.3mf` files in the browser
- Google Identity Services (token client) + Google Drive REST v3 via `fetch` + Google Picker (folder pick)
- Hosting: Vercel. SPA + Vercel Serverless Functions in `/api` (auth + thumbnail proxy only). No database.

## Commands
- dev: `npm run dev`
- typecheck: `npm run typecheck`
- lint: `npm run lint`
- test: `npm test` (runs once, CI mode)
- build: `npm run build`
All four of typecheck, lint, test, build must pass before any agent reports "done".

## Folder layout
- `src/lib/pricing.ts` — pure pricing function. No I/O. The only place the formula lives.
- `src/lib/threemf.ts` — sliced .3mf parser (pure, takes ArrayBuffer/Blob).
- `src/lib/drive/` — `DriveStore` interface, `googleDrive.ts` (real), `memoryDrive.ts` (fake for tests).
- `src/lib/auth/` — session client (calls /api/auth/*; access token in memory only).
- `api/` — Vercel functions: auth (login/callback/token/logout) and thumb proxy. Shared code in `api/_lib/`.
- `src/pages/` — Home, NewModel (also Edit), Library, ModelPage, Settings.
- `src/components/` — shared UI.
- `tests/unit/` — unit tests (Builder). `tests/acceptance/` — acceptance tests (Test Verifier only).
- `tests/fixtures/` — two real Bambu Studio sliced files (G-code removed to keep them small).

## Architecture rules
- Pricing formula lives ONLY in `src/lib/pricing.ts`. UI never re-implements math.
- UI talks to Drive ONLY through the `DriveStore` interface, so tests use the in-memory fake.
- `bid.json` in each model folder is the source of truth. `_rubedo-index.json` is a rebuildable cache.
- Every saved bid stores a snapshot of the settings used. Changing Settings never changes saved bids.
- Money: compute in full precision, round to 2 decimals only for display. Currency ₪, format `₪1,234.56`.
- UI language Hebrew, `dir="rtl"`, mobile-first. Numbers/units stay LTR where needed.
- Errors are shown to the user in plain Hebrew; never swallow errors; never silently substitute 0 for a value
  that failed to load or parse.

## Do not
- Do not deploy to production. Preview deployments only. Production = Founder approval.
- Do not buy, subscribe to, or enable any paid service or plan. Ever.
- Backend = Vercel functions in `/api` ONLY for auth + thumbnails (Founder decision 30 Sep, addendum v0.4). No database, Supabase, Firebase or other services.
- Drive scope: `drive` (addendum v0.4). Allowed writes: create new files/folders; update content ONLY of files with `appProperties.rubedo="1"`. NEVER delete, trash, move, rename or change permissions.
- Gmail: scope gmail.compose; ONLY users.drafts.create may be called. Never send, read, modify or delete mail. (v0.5)
- Access token: memory only in the SPA. Refresh token: ONLY inside the encrypted HttpOnly session cookie, never in JS, logs or responses. GOOGLE_CLIENT_SECRET only in Vercel env.
- Do not commit secrets, `.env*` (except `.env.example`), keys, or tokens. The pre-commit hook blocks them.
- Do not add dependencies beyond the stack above without writing why in your summary.
- Do not commit directly to `main` after the initial setup commit — work on a branch, open a PR.
- Do not delete or overwrite anything in the Founder's Drive. The app only creates; edits touch only `bid.json`
  / index / settings files it created.

## Pricing method (Founder-approved)
printerRate = ((printerCost + upgrades + maintenancePerYear × lifeYears) / (lifeYears × 8760 × uptime)
              + powerW/1000 × kwhPrice) × buffer                       // = ₪0.66498/h with defaults
filament   = Σ(part.grams × part.qty) / 1000 × pricePerKg × efficiency
hardware   = Σ(qty × unitCost) over rows with included !== false   // v0.5
labor      = laborMinutes / 60 × laborRate                              // laborRate default ₪80/h
packaging  = hasShipping ? Σ(qty × unitCost) + shippingCost : 0
machine    = Σ(part.hours × part.qty) × printerRate
landed     = filament + hardware + labor + packaging + machine
price(m)   = landed / (1 − m) for m ∈ {0.5, 0.6, 0.7}; library shows price(0.7)
Defaults: efficiency 1.1, laborRate 80, printerCost 4200, upgrades 0, maintenancePerYear 420, lifeYears 3,
uptime 0.5, powerW 150, kwhPrice 0.64, buffer 1.3, material price ₪85/kg for PLA/PETG/other.

## Deeper docs
- `docs/technical-brief.md` — scope, data layout, flows, acceptance criteria, test cases T0–T3.

## Lessons (append a rule here every time an agent makes a surprising mistake)
- Number input: Israeli users write "4,200" = 4200. Comma is ONLY a thousands separator
  (`^\d{1,3}(,\d{3})+(\.\d+)?$`); any other comma is invalid. Never treat comma as a decimal point. (pilot, round 2)
- Never use `<input type="number">` for money/quantities: malformed text reaches JS as "" → silent 0. Use text +
  inputMode="decimal" and validate. (pilot, round 1)
- Auth loss must never unmount a page with unsaved work. Use a "needs reconnect" state + banner, keep forms mounted. (round 2)
- Async state loaded "for" a key (folder, id) must be tagged with that key; render only when tag === current key. (round 3)
- Google popups: load GIS at startup and call requestAccessToken synchronously in the click handler (mobile Safari
  blocks popups opened after an await). Share one in-flight token request; never cancel parallel callers. (round 1)
- NEVER create Vercel deployments through the API/MCP (`create_deployment`). A manual API deploy of a branch was
  promoted to PRODUCTION without approval (pilot, 29 Sep). Previews come ONLY from `git push` to a non-main branch;
  production ONLY from the Founder merging to `main`. (COO incident)
- jsdom: `URL.createObjectURL` throws on JSZip blobs → use `createObjectUrlSafe`; load fixtures with
  `resolve(process.cwd(), 'tests/fixtures', …)`. Tailwind v4 custom classes need `@utility`. (builder notes)
- Static safety scans grep comments too: don't write delete/trash/move or /permissions in comments under src/ or api/. (v0.4)
- Test fixtures must never use real secret prefixes (e.g. GOCSPX-) — push protection and scanners flag them. (v0.4)
- When a Founder decision changes an asserted rule, COO has the test-verifier update affected acceptance tests right
  after the builder; the builder reports conflicts instead of editing tests/acceptance/. (v0.3/v0.4)
