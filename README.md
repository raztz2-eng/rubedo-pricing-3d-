# RUBEDO 3D — Bid App
Pricing app for 3D-printed models (RUBEDO.3D). Built by the AI Company "Software Factory" pilot.
- Rules for AI agents: `CLAUDE.md`
- Spec: `docs/technical-brief.md`
- Agent roles: `.claude/agents/`

## Architecture (brief addendum v0.4)
- `src/` — React SPA (Vite). Talks to Google Drive directly with a short-lived access token kept in memory only.
- `api/` — Vercel Serverless Functions, auth + thumbnails only (no database):
  - `GET /api/auth/login` → Google consent (scopes `drive` + `gmail.compose` + `openid email`, offline access)
  - `GET /api/auth/callback` → checks state + allowed account, stores the refresh token in an encrypted
    (AES-256-GCM) `HttpOnly; Secure; SameSite=Lax; Path=/api` cookie
  - `POST /api/auth/token` → fresh access token + granted `scopes` for the SPA (the refresh token never reaches the browser JS)
  - `POST /api/auth/logout` → revoke + clear cookie
  - `GET /api/thumb?id=&s=` → Drive thumbnail proxy (works for iPhone HEIC photos)
- Quote e-mail (addendum v0.5): the quote screen (`/model/:id/quote`) creates a Gmail **draft** only
  (`users.drafts.create`); the Founder reviews it and presses Send in Gmail. Each draft is logged in
  `<model>/quotes/quote-YYYYMMDD-HHmm.json`. Sessions created before v0.5 lack `gmail.compose`: the quote screen offers
  "אישור הרשאה ל-Gmail" (the login popup); nothing else is blocked.
- Drive write rules: the app only creates files/folders (marked `appProperties.rubedo="1"`) and updates the
  content of marked files. It never deletes, trashes, moves, renames or changes permissions.

## Environment variables
See `.env.example`. In Vercel (Project → Settings → Environment Variables):
- `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_API_KEY`, `VITE_GOOGLE_APP_ID` (as before)
- `GOOGLE_CLIENT_SECRET` — **new, required**, mark as Sensitive. The Founder adds it; agents never handle it.
- `ALLOWED_EMAIL` — optional (default `raztz2@gmail.com`); `GOOGLE_CLIENT_ID` — optional (default `VITE_GOOGLE_CLIENT_ID`).

**Founder setup for the quote e-mail (v0.5, free — both steps are needed, in the same Google Cloud project as the
OAuth client):**
1. **Enable the Gmail API:** Google Cloud Console → APIs & Services → Library → search "Gmail API" → **Enable**.
   Without it, creating a draft fails with "Gmail API לא מופעל בפרויקט Google Cloud — יש להפעיל אותו ולנסות שוב".
2. **Add the scope:** Google Auth Platform → **Data Access** → "Add or remove scopes" → add
   `https://www.googleapis.com/auth/gmail.compose` → Save. Then, in the app, open a quote screen and click
   "אישור הרשאה ל-Gmail" once (sessions from before v0.5 do not have this permission yet).

In Google Cloud Console → the OAuth client → **Authorized redirect URIs**, add (exact match, no wildcards):
- the production domain: `https://<production-domain>/api/auth/callback`
- the **stable branch alias** of the preview branch, e.g. `https://<project>-git-<branch>-<team>.vercel.app/api/auth/callback`.
  Only this alias can be registered: every preview deployment also gets its own per-deploy URL
  (`https://<project>-<hash>-<team>.vercel.app`) that changes on each push, and Google rejects sign-in there with
  `redirect_uri_mismatch`. Always open previews through the branch alias.
- local dev: `http://localhost:3000/api/auth/callback`

Sign-in flow: the first sign-in is a full-page redirect. If the session expires while you work, "התחבר מחדש" opens a
small login popup (`/api/auth/login?popup=1`) so the open page and any unsaved form stay as they are; after signing
in, the popup closes and the app reconnects when you return to the tab (or click "המשך"). Allow popups for the site.

Security headers (`vercel.json`): a Content-Security-Policy for the app (self + the Google Picker hosts
`apis.google.com`, `accounts.google.com`, `docs.google.com`, `*.googleusercontent.com` frames; images only from self /
`data:` / `blob:`, Drive thumbnails come through `/api/thumb`), `Referrer-Policy: strict-origin-when-cross-origin` and
`X-Content-Type-Options: nosniff`. `connect-src` also allows `https://gmail.googleapis.com` (drafts, v0.5). The `/api` responses set their own CSP. After changing the CSP, check on the preview
that "בחירת תיקיית דגמים" (Google Picker) still opens — look for CSP errors in the browser console.

## Local development
- Full app with sign-in: `npx vercel dev` (runs the SPA and the `/api` functions together on port 3000).
  Put the variables in `.env.local` (git-ignored). `npm run dev` alone serves only the SPA — `/api` is not available,
  so Google sign-in will not work there.
- **Safari on localhost:** the session cookie is `Secure`. Chrome and Firefox accept `Secure` cookies on
  `http://localhost`, Safari does not — so in Safari the sign-in completes but the cookie is dropped and the app stays
  signed out. Test sign-in locally in Chrome/Firefox, or test Safari (incl. iPhone) on the HTTPS preview branch alias.
- Without Google: `npm run dev` and open `http://localhost:5173/?demo=1` (in-memory data, no backend needed).

## Checks
`npm run typecheck && npm run lint && npm test && npm run build`
