# Cert catalog — Step 0, item 6: the app's cert read (from the repo, `origin/main` @ `7279705`)

## How a cert row is created and edited today
- **The app never INSERTs into `certs`.** Every cert starts as a **`cert_submissions`** row and becomes a cert through **`approve_cert_submission(submission_id)`**:
  - member self-propose — `CertProposals` (`src/App.jsx` ~4651): `cert_submissions.insert({ department_id, member_id, name, exp, status: "pending", source: "self", note, proof_path })`, proof uploaded first to `station-documents/{dept}/cert-proofs/{member}/…`;
  - leader adds for a member — `ProposeCert` (~12031): `cert_submissions.insert({ …, source: "manual", note, proposed_by, proof_path })`, status defaults `pending`;
  - DA approves / rejects — `RosterPending` (~12337 / ~12346): `rpc("approve_cert_submission", { submission_id })`, `rpc("reject_cert_submission", { submission_id, reason })`. Approval copies the submission's proof onto the cert (the loaders' comment: "proof_path: approve_cert_submission copies the submission's proof onto the cert").
- **Edit / delete on the member file** — `MemberDetail` (~11652 / ~11633): `rpc("update_cert", { cert_id, new_name, new_exp })` with `new_exp` validated client-side as `^\d{4}-\d{2}$` or null; `rpc("delete_cert", { cert_id })`.
- **Reads** — the App loader selects `certs (id, member_id, name, exp, proof_path)` dept-wide (~2391) and the caller's own (~2478). No cert read RPC on the client.

**So the additive type link lands in three places:** `cert_submissions` (pick a type when proposing), `approve_cert_submission` (carry it onto the cert), and `update_cert` (set / change it on the member file).

## The client bucket rule — `certStatus(exp)` (~10916)
```js
if (typeof exp !== "string" || !/^\d{4}-\d{2}$/.test(exp)) return { label: "NO DATE", rank: 3 };
const diff = (y * 12 + m) - nowYM();              // calendar months, today = this month
if (diff < 0)                return { label: "EXPIRED",  rank: 0 };
if (diff <= EXPIRING_MONTHS) return { label: "EXPIRING", rank: 1 };   // shared/expiry.js, = 3
return                              { label: "CURRENT",  rank: 2 };
```
Its comment says the rule is replicated in SQL **`dept_cert_readiness()`** (included in the live Step 0), and the Expirations dashboard re-buckets `expiration_rows` through `shared/expiry.js` `expiryBucket()` (same window). **A never-expires type has to change all three in step** — `certStatus`, `expiryBucket` / `expiration_rows`, `dept_cert_readiness` — or one cert reads two ways.

## Where certs render (every `certStatus` caller — each would read a never-expires cert as NO DATE today)
| component | what |
|---|---|
| `NeedsAttention` (~3270) | dashboard attention list (expired / expiring / no date) |
| `PersonalView` (~3330) | the member's own "My certifications" |
| `DeptAdminDashboard` (~4053) | the DA's flagged-certs list |
| `certCoverage` (~10973) | roster coverage headline (compliance %) |
| `RosterMembers` (~11317) | per-member compliance % |
| `MemberDetail` (~11554) | the member file's cert list (edit / delete) |
| `RosterCerts` (~12072, 12122, 12147) | the Certifications tab — per-cert rows, compliant count, by-cert grouping |
| `RosterReports` (~12654, 12721) | roster reports |
| `Minutes` (~19596) | cert rows fed to the minutes / report drafter |
| `DeptHealthCharts` (~26909) | expired-cert count on the DA charts |
| Expirations (`expRank` → `expiryBucket`) | the #4 dashboard + `api/expiration-reminders.js` (no reminder for `no_date`) |

Note: `MemberDetail`'s edit accepts only `YYYY-MM` or blank — a never-expires cert would be saved blank and is distinguished only by its type.
