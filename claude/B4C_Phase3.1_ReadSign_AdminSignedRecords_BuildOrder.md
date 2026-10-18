# B4C Phase 3.1 · Read & Sign — Admin "Signed Records" view + download (Build Order, for CC)

**Why:** A member can pull their own signed record (receipt with their signature). An admin today sees only the **compliance view** — who signed / who's outstanding — NOT the actual signed versions. The department needs to pull **each member's signed version** (signature + attestation wording + version + date) for its own records: ISO/audit, or to show someone who disputes it. The data already exists in `document_acknowledgments` (append-only, immutable, applied to prod). This ADDS a gated admin read + UI + download. **Net-new → its own review.** Touches nothing that ships in the Read & Sign promote; rides right after it (or with it).

## DB — one new read RPC (the deliberate, gated widening)
`dept_signed_records(p_document_id uuid DEFAULT NULL) RETURNS setof (...)` — SECURITY DEFINER, `authenticated`-only, **gated to `is_canmanage()`** (Board + DA + Officer), **dept-scoped** (`department_id = my_department_id()`). Returns the department's acknowledgments: `member_id`, member `name`, `series_id`, document `title`, `version`, `content_hash`, `ack_statement`, `signature_data`, `signed_name`, `signed_at`. `p_document_id` scopes to that doc's series; NULL = all required docs in the dept.
- **Members are refused** (not `is_canmanage()`). This RPC is the ONE place a signature is exposed beyond the signer — keep it leadership-only + dept-scoped, **fail closed**.
- Read-only. Never writes `verified`. Append-only trail unchanged. Does **not** alter the existing member-only RLS on `document_acknowledgments` or the `dept_read_sign_compliance` RPC — purely additive.
- Grants: `REVOKE anon, public`; `GRANT authenticated` (the gate enforces leadership inside). Guarded + post-conditions like the other read_sign RPCs; prove anon can't execute.

## UI (DA / Officer / Board — mirror the compliance view; members never see it)
- In the compliance area (`RsCompliance` on Station Documents), per document: expand to a **signer list** — each row `member name · v{n} · {signed_at}` + **"View signature"** → shows the stored signature image + the attestation wording + version + date (the exact record).
- **Download / print** a signed record: document title + version + **content_hash (fingerprint)** + attestation wording + signature image + signer name + timestamp. Offer **per-member** (one record) and **per-document** (roster of all signers with signatures) — the station's audit copy (print-to-PDF is fine).
- Members never see this screen — they have their own receipt. The department-side view is leadership-only, dept-scoped.

## Verify (RETEST additions + live gate)
- A **member cannot** call `dept_signed_records` (refused).
- **Another department's** admin gets nothing for this dept.
- The signature returned **== what was stored** (matches the ack row byte-for-byte).
- DA / Officer / Board of the dept DO get the dept's signed records incl. signatures.
- `verified` untouched; append-only trail unchanged; member RLS + the compliance RPC byte-identical.
- **Live:** as DA, open a document's signed records, see the test member's signature, download the record.

## Fit
This is the focused precursor to **#5 — the one-click ISO/audit packet**, which rolls this up across all docs + certs + quals + expirations into one export. Build this now (department's signed-records copy); the full ISO packet is #5.
