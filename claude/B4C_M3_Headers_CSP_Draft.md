# Security list — M-3: security headers + report-only CSP (DRAFT — vercel.json only, nothing shipped)

Branch `feat/m3-headers-csp` from main `9cd3762` (industrial-noir-42). One file changes: `vercel.json` (+25 lines, one new rule).
No client, no `api/`, no DB. verified 132/32/14, Notify held.

## The change — one `"/(.*)"` rule, first in `headers` (every path; the existing rules are untouched)
| header | value | note |
|---|---|---|
| X-Frame-Options | `DENY` | the app is never framed |
| X-Content-Type-Options | `nosniff` | |
| Strict-Transport-Security | `max-age=63072000; includeSubDomains` | Vercel already serves `max-age=63072000` today; this makes it explicit + covers subdomains of app.b4thecall.com (none exist). **No `preload`** — that is an apex-domain commitment, separate decision |
| Referrer-Policy | `strict-origin-when-cross-origin` | |
| Content-Security-Policy-**Report-Only** | below | **observes, never blocks.** No enforcing CSP anywhere — that stays a later step, Ashlea's call |

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com;
img-src 'self' data: blob: https://ifeptqnlucmvhlvadcpj.supabase.co;
connect-src 'self' https://ifeptqnlucmvhlvadcpj.supabase.co https://app.b4thecall.com;
worker-src 'self' blob:;
manifest-src 'self';
frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```

### Derived from what the app actually loads (the test re-derives it from the source and fails on anything unclassified)
- **script**: only the Vite bundle (`index.html` has no inline script; no CDN). No `'unsafe-inline'`, no `'unsafe-eval'`.
- **style**: React `style={…}` attributes and `<style>` blocks are everywhere → `'unsafe-inline'` (styles only); Google Fonts CSS via `@import` (theme.js, App.jsx).
- **font**: fonts.gstatic.com (the files that CSS points at); `data:` for pdf.js embedded PDF fonts.
- **img**: `data:` (QR canvas, signatures, data-URI department logos, mammoth's embedded images, print crest), `blob:` (object URLs),
  the Supabase project (signed storage URLs for photos / proofs / documents).
- **connect**: same-origin `/api/*` and `/version.json`; the Supabase project (REST, auth, storage); app.b4thecall.com (the native API base — harmless on web).
  **No `wss:`** — the client opens no realtime channel; add it if one ever lands.
- **worker**: pdf.js's worker is a same-origin Vite asset (`?url`); `blob:` kept for pdf.js fallbacks.
- **navigation-only** (taps, not loads — CSP does not govern them): b4thecall.com legal links, maps.apple.com / maps.google.com
  Directions, mailto:/tel:/sms:, users' https links.

## Why it cannot break the native app
Capacitor serves the bundle from the device (`capacitor://localhost` / `https://localhost`), so **these headers never reach the
native WebView's pages** — only web. Native calls `/api/*` on app.b4thecall.com; those JSON responses will now carry the headers,
which a fetch ignores (CORS is unchanged). And the CSP is report-only.

## Checked
- `docs/review/m3_headers_test.mjs` — **22 PASS, 0 FAIL**: exact header set; no enforcing CSP; crons / rewrites / existing header rules
  byte-identical to main; CSP shape (script-src `'self'` only, no wildcard / unsafe-eval, `'none'` for object / frame / ancestors);
  every external origin in `src/` + `shared/` classified (7 found); Supabase in connect + img; no wss:; invariants; only vercel.json changed.
- **Real browser, CSP ENFORCED (stricter than what ships)**: `dist` built with the real Supabase URL, served locally with exactly
  these headers (the CSP switched to enforcing) → the login page renders fully (logo, Oswald + Public Sans from Google Fonts) with
  **zero violations**; control: an injected inline `<script>` and a fetch to an unlisted origin **were both refused** — so the policy
  was live, not silently absent. All five headers present on the response.
  Not exercisable signed-out locally: the signed-in screens — that is what the report-only phase is for.

## ⚑ For your ruling / the enforcement step later
1. **Where reports go.** As drafted there is no `report-uri` / `report-to`: violations appear in the browser console only. To collect
   them, a small `api/csp-report` (log-only, no DB) + `report-uri /api/csp-report` — a separate tiny API slice if you want it.
2. **One report is expected and benign:** opening a PDF — pdf.js probes `new Function` (its `isEvalSupported` defaults true; both
   `getDocument` calls leave it unset) → a `script-src 'unsafe-eval'` report; pdf.js catches it and renders anyway. Before enforcing:
   pass `isEvalSupported: false` to both `getDocument` calls (one-line client change) rather than adding `'unsafe-eval'`.
3. `frame-ancestors` is ignored in report-only mode by spec — X-Frame-Options DENY carries anti-framing until CSP enforces.
4. The Supabase origin is hard-coded (vercel.json is static) — a project move updates it here too (same as the VITE_APP_URL sync rule).
5. Optional, not included: `Permissions-Policy` (e.g. `camera=(), microphone=(), geolocation=(self)`) — the web app uses geolocation for station sign-in.

## Verify after promote (served)
`curl -sI https://app.b4thecall.com/` and the alias: the five headers present, no `content-security-policy` (enforcing) header;
`/version.json`, `/.well-known/*`, `/assets/*` keep their Cache-Control; then a signed-in pass in a real browser reading the console
for `[Report Only]` lines.
