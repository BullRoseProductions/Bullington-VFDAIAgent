import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Lock, X } from "lucide-react";
import { isDeptAdmin } from "../shared/roles.js";

/* THE TYPED DELETE CONFIRMATION, for shared and department-level records.

   WHY THIS EXISTS. On 20 Sep 2026 three of North Hood's training plans were deleted
   through the Android app by a test account, in three taps across an hour. The only
   thing standing in the way was window.confirm(), which is a single OK button: the
   dialog a person dismisses without reading because ninety-nine times out of a
   hundred dismissing it is correct. The 72 sessions those plans owned survived with
   plan_id NULL, and the plans themselves were only recoverable from a nightly
   backup — the deletes straddled the backup window, so one of the three was already
   past saving by the time anyone looked.

   SO THE GUARD IS DELIBERATE FRICTION, NOT A BETTER DIALOG. The member has to read
   the record's name and type it. That cannot be done by reflex, it cannot be done
   without looking at which record is selected, and it takes long enough that
   "wait, this is the wrong department" has time to arrive.

   WHAT THIS IS NOT. This is a UI guardrail, not a security boundary. Anything that
   can get a JWT can still call PostgREST directly; the browser is not where access
   is decided. The durable fix is an RLS policy restricting DELETE on these tables to
   department admins, and that is a separate, reviewed migration. Treat this as the
   thing that stops the accident and the idle tap, which is what actually happened.

   IMPERATIVE ON PURPOSE. It replaces `if (!window.confirm(msg)) return;` with
   `if (!await confirmDestructive({...})) return;` at seventeen call sites. Turning
   each of those into modal state, an effect and a callback would have been a much
   larger diff through code that is otherwise correct, and every one of those
   rewrites is a chance to drop the early return. */

let open = null;   // set by the mounted host; null on web pages that never mount it

/* THE ADMIN GATE, registered once instead of threaded through eighteen components.

   Every one of these deletes lives in a different screen, and most of those screens
   already gate their button on some OTHER rule — canManage, canManage_ops, editMode,
   author_id. Adding "…and is a Department Admin" to eighteen JSX conditions means
   eighteen chances to write it slightly differently, and the one that gets it wrong
   is a hole nobody finds until it is used. The role is published here once, by App,
   and the gate is enforced on the single path every shared delete must pass through.

   NOT A SECURITY BOUNDARY — the same caveat as the typed phrase above. RLS is.
   `role` is members.access (the permission array), never members.role (rank). */
let gateRole = null;
export function setDeleteGateRole(role) { gateRole = role; }

/* Ask. Resolves true only if the member typed the phrase and pressed Delete.
   Resolves false for cancel, backdrop, Escape — and, deliberately, if no host is
   mounted: a missing confirmation must fail CLOSED, never wave the delete through. */
export function confirmDestructive({ noun, name, impact, phrase } = {}) {
  if (typeof open !== "function") {
    console.error("[b4c] confirmDestructive called with no <DestructiveConfirmHost/> mounted — refusing the delete");
    return Promise.resolve(false);
  }
  // Refused BEFORE the typed field is offered: someone who may not do this should not
  // be walked to the edge of doing it and then stopped. They get told who can.
  if (!isDeptAdmin(gateRole)) return open({ noun, name, denied: true });
  return open({ noun, name, impact, phrase });
}

/* What the member has to type.

   The record's own name, when it is short enough to retype without becoming a
   punishment, because typing it is what forces them to look at WHICH record is
   selected — the failure mode being guarded is deleting the right kind of thing from
   the wrong row. For long or awkward names (a pasted title, an emoji, a 60-character
   drill description) that check stops being a check and starts being an obstacle, so
   those fall back to DELETE. */
const phraseFor = (name, override) => {
  if (override) return override;
  const n = String(name || "").trim();
  return n && n.length <= 32 && /^[\w\s'’&.,()/-]+$/u.test(n) ? n : "DELETE";
};

export function DestructiveConfirmHost() {
  const [req, setReq] = useState(null);   // { noun, name, impact, phrase, resolve }
  const [typed, setTyped] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    open = (opts) => new Promise((resolve) => { setTyped(""); setReq({ ...opts, resolve }); });
    return () => { open = null; };
  }, []);

  // Focus the field, and let Escape cancel. The field is focused rather than the
  // Delete button deliberately: nothing destructive should ever be one Return away.
  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    const onKey = (e) => { if (e.key === "Escape") finish(false); };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  function finish(ok) {
    if (!req) return;
    req.resolve(ok);
    setReq(null);
    setTyped("");
  }

  if (!req) return null;

  if (req.denied) {
    return createPortal(
      <div
        role="dialog" aria-modal="true" aria-labelledby="b4c-confirm-title"
        onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}
        style={{ position: "fixed", inset: 0, zIndex: 2147483646, background: "rgba(4,5,7,.72)", backdropFilter: "blur(2px)",
                 display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
        <div style={{ width: "100%", maxWidth: 420, background: "#13161B", border: "0.5px solid rgba(255,255,255,.08)",
                      borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,.6)", padding: "20px 20px 18px",
                      fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#F7F8FA" }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
            <div style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, background: "rgba(255,255,255,.06)",
                          display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Lock size={17} color="#9AA1AC" />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div id="b4c-confirm-title" style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.3 }}>
                Only a Department Admin can delete this
              </div>
              <div style={{ fontSize: 13.5, color: "#B6BDC8", marginTop: 4, lineHeight: 1.5 }}>
                Deleting a {req.noun || "shared record"} affects the whole department, so it&rsquo;s limited to
                Department Admins. Ask one of yours to remove{req.name ? ` “${req.name}”` : " it"}.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={() => finish(false)}
                    style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "#E7EAEF",
                             borderRadius: 9, padding: "9px 17px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
              OK
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  const want = phraseFor(req.name, req.phrase);
  // Trim only. Case and interior spacing must match: a guard that accepts "delete"
  // for "DELETE" is most of the way back to a single OK button.
  const armed = typed.trim() === want;

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-labelledby="b4c-confirm-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}
      style={{ position: "fixed", inset: 0, zIndex: 2147483646, background: "rgba(4,5,7,.72)", backdropFilter: "blur(2px)",
               display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
      <div style={{ width: "100%", maxWidth: 440, background: "#13161B", border: "0.5px solid rgba(255,255,255,.08)",
                    borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,.6)", padding: "20px 20px 18px",
                    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif", color: "#F7F8FA" }}>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
          <div style={{ flexShrink: 0, width: 34, height: 34, borderRadius: 9, background: "rgba(200,50,58,.14)",
                        display: "flex", alignItems: "center", justifyContent: "center" }}>
            <AlertTriangle size={18} color="#E58A90" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id="b4c-confirm-title" style={{ fontSize: 16, fontWeight: 800, lineHeight: 1.3 }}>
              Delete this {req.noun || "record"}?
            </div>
            <div style={{ fontSize: 13.5, color: "#B6BDC8", marginTop: 3, wordBreak: "break-word" }}>{req.name}</div>
          </div>
          <button onClick={() => finish(false)} aria-label="Cancel"
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "#7E8794", flexShrink: 0 }}>
            <X size={17} />
          </button>
        </div>

        {req.impact && (
          <div style={{ fontSize: 13, color: "#D6A95E", background: "rgba(214,169,94,.09)", border: "0.5px solid rgba(214,169,94,.2)",
                        borderRadius: 9, padding: "9px 11px", lineHeight: 1.5, marginBottom: 13 }}>
            {req.impact}
          </div>
        )}

        <div style={{ fontSize: 12.5, color: "#9AA1AC", lineHeight: 1.5, marginBottom: 7 }}>
          This can&rsquo;t be undone. Type <strong style={{ color: "#F0F2F5", fontWeight: 700 }}>{want}</strong> to confirm.
        </div>

        <input
          ref={inputRef} value={typed} onChange={(e) => setTyped(e.target.value)}
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          onKeyDown={(e) => { if (e.key === "Enter" && armed) finish(true); }}
          placeholder={want}
          style={{ width: "100%", boxSizing: "border-box", background: "rgba(255,255,255,.04)",
                   border: `1px solid ${armed ? "#3FB860" : "rgba(255,255,255,.12)"}`, borderRadius: 9,
                   padding: "10px 12px", fontSize: 15, color: "#F7F8FA", outline: "none", marginBottom: 15 }} />

        <div style={{ display: "flex", gap: 9, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button onClick={() => finish(false)}
                  style={{ background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "#E7EAEF",
                           borderRadius: 9, padding: "9px 15px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}>
            Cancel
          </button>
          <button onClick={() => finish(true)} disabled={!armed}
                  style={{ background: armed ? "#C8323A" : "rgba(200,50,58,.25)", border: "none",
                           color: armed ? "#fff" : "rgba(255,255,255,.45)", borderRadius: 9, padding: "9px 17px",
                           fontSize: 14, fontWeight: 700, cursor: armed ? "pointer" : "not-allowed" }}>
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
