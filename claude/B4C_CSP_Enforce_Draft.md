# B4C — CSP enforce (M-3 tail): pre-flight audit + enforce diff — DRAFT. NOT deployed.

**Branch:** `draft/csp-enforce`, off live main `d377999` (industrial-noir-54).
**Changed:** `vercel.json`: one key, `Content-Security-Policy-Report-Only` → `Content-Security-Policy`, with the value
byte-identical. Also new: `docs/review/csp_enforce_test.mjs` and this note.
**Unchanged:** every other header, the crons, the rewrites, `src/`, `api/`, SQL and native.
**Ships** only on Ashlea's sign-off.

## Part 1: audit result: clean. Nothing would break under enforce.
The policy is enforced as is: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' fonts.googleapis;
font-src 'self' data: fonts.gstatic; img-src 'self' data: blob: <supabase>; connect-src 'self' <supabase>
app.b4thecall.com; worker-src 'self' blob:; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self';
form-action 'self'; frame-ancestors 'none'`.

### Static (built `dist/` + source)
| area | finding | verdict |
|---|---|---|
| `dist/index.html` inline script | none: one `<script type="module" src="/assets/index-*.js">`; the two inline `<style>` blocks fall under `style-src 'unsafe-inline'` | OK, no hash needed |
| iframe / embed / object | none in our source. In the bundle: jsPDF's `pdfobjectnewwindow` / `pdfjsnewwindow` / `dataurlnewwindow` outputs (iframe + a cdnjs script) are **never called**, because every export is `doc.output("blob")` → `saveOrShare`. html2canvas clones into an about:blank iframe, which `frame-src` doesn't govern (proven at runtime below). The rest are React/DOMPurify tag-name tables | OK |
| document previews | DocViewer `src/App.jsx:6563` fetches the Supabase signed URL, then renders pdf.js to a **canvas**, mammoth to HTML, or a plain `<img>`; no iframe | OK |
| eval / `new Function` | mammoth (bluebird codegen only when `navigator` is undefined; underscore `_.template` never called); jsPDF/core-js `Function("return this")` after `window` short-circuits; pdf.js `isEvalSupported` try/catch → interpreted fallback | OK (no `unsafe-eval` needed) |
| workers | pdf.js `/assets/pdf.worker.min-*.mjs` (self). The supabase-js realtime worker is unused | OK |
| connect-src | `supabaseClient` (project host), `apiFetch` → `VITE_APP_URL` / `https://app.b4thecall.com`, `/version.json`, DocViewer and logo fetches of Supabase URLs. **No other host anywhere** | OK |
| WebSocket | supabase-js realtime is bundled but **never subscribed** (no `.channel(`). *Latent:* if realtime is ever added, `connect-src` needs `wss://ifeptqnlucmvhlvadcpj.supabase.co` (CSP3: an `https:` source does not match `wss:`) | OK today; note for later |
| images | logos are stored as PNG **data URIs** (`App.jsx:26620`; live: 0 departments have `logo_url` set, read-only check); AI graphics come back from `/api/image` as `data:image/png;base64` and are composed on a canvas; doc images are Supabase signed URLs; the rest are static `/…png` | OK |
| audio / video | none (bundle hits are React/DOMPurify tag tables) | OK |
| fonts | the two `@import`s of fonts.googleapis.com (style-src) → fonts.gstatic.com (font-src) | OK |
| service worker / web push | none on the web (push is native FCM) | OK |
| CDN loads | none executed (cdnjs only inside the uncalled jsPDF branch) | OK |
| print window | `printHTML` (`App.jsx:11630`) `window.open("")` + `document.write`: inline `<style>` and data-URI `<img>` only, **no script**; `print()` is called from the opener | OK |
| `/api/*` | JSON only: no HTML bodies, no redirects | OK |
| `.well-known` | JSON read server-side by Apple/Google; CSP is irrelevant to them; their own header blocks are unchanged | OK |
| Vercel-injected | no `@vercel/analytics` / speed-insights. Preview deploys' vercel.live toolbar would be blocked; production doesn't load it | OK (previews only) |
| native | Capacitor loads the local bundle, and Vercel headers never reach it | unaffected |

### Runtime: built `dist/`, CSP **enforced** (exact value from `vercel.json`), localhost
- **Control:** an injected inline `<script>` was **blocked** (`script-src-elem`), so enforcement was real.
- **Boot:** the app renders the sign-in screen with no `Refused…` console errors and no `securitypolicyviolation` events.
- **Under enforce, 0 violations:**
  - jsPDF `buildPrintPdf` produced a 4,110 B `application/pdf` blob;
  - pdf.js `getDocument` + `getPage` + `getTextContent` ran through the real module worker;
  - mammoth `convertToHtml` gave `<p>CSP probe docx OK</p>`;
  - html2canvas gave a 2746×1570 canvas.
- **pdf.js canvas `render()` stalled in the background tab.** The identical call with **no CSP** stalled the same way, so it's
  the hidden tab (paused animation frames), not the policy.
- **Not exercised at runtime** (signed-in only): Supabase reads, `/api/*`, and the print window. They're covered statically
  above.

## Part 2: the diff
```diff
-          "key": "Content-Security-Policy-Report-Only",
+          "key": "Content-Security-Policy",
```
**`docs/review/csp_enforce_test.mjs`, 11/0:**
- one enforced CSP, with no Report-Only left;
- the value is byte-identical to main's;
- `script-src 'self'` only;
- `frame-src` / `object-src` / `frame-ancestors` are `'none'`;
- the rest of `vercel.json` is identical;
- no inline script in `index.html`;
- **fences:** only `vercel.json` (+ the test and this note) changed; verified counts 132/32/14; Notify held.

## Optional: a Report-Only copy with a reporting endpoint for an observation window
**Not recommended.** It's possible: keep both headers, and add `report-to` / `Report-To` to the Report-Only copy only. But
it costs a new public `/api/csp-report` function:
- unauthenticated by nature, so anyone can POST to it: rate-limit and size-cap it;
- log noise from extensions;
- ~1 KB more header on every response;
- one more thing to remove afterwards.

The runtime audit already covers the paths where a violation would show. A cheaper watch: after the deploy, open the
deployed site signed in and walk Documents (PDF + DOCX), print, exports and the graphics maker with DevTools open. Any
`Refused to…` line names the directive. Rollback is the same one-line key rename.
