import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, HelpCircle, MessageSquare } from "lucide-react";
import { FIRE } from "./theme.js";

/* THE SHARED INDUSTRIAL NOIR DIALOGS (b4c_dialogs_noir.html) — one confirm, one reason/text prompt.
   They replace the browser's own window.confirm / window.prompt boxes, which ignore the theme, look
   different on every OS, and on the iOS app read as a system alert rather than part of B4C.

   IMPERATIVE, like confirmDestructive: a call site goes from
       if (!window.confirm(msg)) return;
   to
       if (!(await noirConfirm({ title, body }))) return;
   so no screen grows modal state just to ask a question.

   FAIL CLOSED. With no <NoirDialogHost/> mounted, noirConfirm resolves false and noirPrompt resolves
   null — the action does not happen. A missing question must never be read as "yes".
   (Typed-phrase deletes stay on confirmDestructive; these are for everything else.) */

let open = null;
const DISPLAY = "'Oswald', system-ui, sans-serif";

/** Resolves true only on the confirm button. Cancel / backdrop / Escape -> false. */
export function noirConfirm({ title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false } = {}) {
  if (typeof open !== "function") { console.error("[b4c] noirConfirm with no <NoirDialogHost/> — refusing"); return Promise.resolve(false); }
  return open({ kind: "confirm", title, body, confirmLabel, cancelLabel, danger });
}

/** Resolves the trimmed text on confirm; null on cancel / backdrop / Escape. `required` keeps the
    confirm button disabled until something is typed. */
export function noirPrompt({ title, body, label = "Reason", placeholder = "", initial = "", confirmLabel = "Save",
                             cancelLabel = "Cancel", required = false, multiline = true, inputMode, danger = false } = {}) {
  if (typeof open !== "function") { console.error("[b4c] noirPrompt with no <NoirDialogHost/> — refusing"); return Promise.resolve(null); }
  return open({ kind: "prompt", title, body, label, placeholder, initial, confirmLabel, cancelLabel, required, multiline, inputMode, danger });
}

const para = (body) => typeof body === "string"
  ? body.split(/\n{2,}/).map((p, i) => <p key={i} style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.5, margin: i ? "8px auto 0" : "0 auto", maxWidth: 340, whiteSpace: "pre-line" }}>{p}</p>)
  : body;

export function NoirDialogHost() {
  const [req, setReq] = useState(null);
  const [text, setText] = useState("");
  const fieldRef = useRef(null);
  const okRef = useRef(null);

  useEffect(() => {
    open = (opts) => new Promise((resolve) => { setText(opts.initial || ""); setReq({ ...opts, resolve }); });
    return () => { open = null; };
  }, []);

  useEffect(() => {
    if (!req) return;
    const t = setTimeout(() => (req.kind === "prompt" ? fieldRef.current : okRef.current)?.focus(), 60);
    const onKey = (e) => { if (e.key === "Escape") finish(false); };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  function finish(ok) {
    if (!req) return;
    if (req.kind === "prompt") req.resolve(ok ? text.trim() : null);
    else req.resolve(!!ok);
    setReq(null); setText("");
  }
  if (!req) return null;

  const isPrompt = req.kind === "prompt";
  const armed = !isPrompt || !req.required || text.trim().length > 0;
  const Icon = req.danger ? AlertTriangle : isPrompt ? MessageSquare : HelpCircle;
  const btn = { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13.5, fontWeight: 700,
                borderRadius: 11, padding: "12px 16px", cursor: "pointer", border: `1px solid ${FIRE.line2Noir}`, background: FIRE.card2Noir,
                color: FIRE.textPrimary, fontFamily: "inherit" };
  const fieldStyle = { width: "100%", boxSizing: "border-box", background: FIRE.card2Noir, border: `1px solid ${FIRE.line2Noir}`, borderRadius: 10,
                       padding: "11px 13px", color: FIRE.textPrimary, fontFamily: "inherit", fontSize: 14, outline: "none", colorScheme: "dark" };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="b4c-noir-dialog-title"
      onMouseDown={(e) => { if (e.target === e.currentTarget) finish(false); }}
      style={{ position: "fixed", inset: 0, zIndex: 2147483645, background: "radial-gradient(120% 90% at 50% -10%, rgba(10,12,16,.62), rgba(4,5,7,.86))",
               backdropFilter: "blur(2px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 18 }}>
      <div style={{ width: "100%", maxWidth: 420, background: "linear-gradient(180deg, #0F1319, #0A0D12)", border: `1px solid ${FIRE.line2Noir}`,
                    borderRadius: 15, overflow: "hidden", boxShadow: "0 30px 80px rgba(0,0,0,.7)", color: FIRE.textPrimary }}>
        <div style={{ padding: "22px 22px 6px", textAlign: "center" }}>
          <div style={{ width: 50, height: 50, borderRadius: 13, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px",
                        ...(req.danger ? { background: "rgba(200,50,58,.14)", border: "1px solid rgba(200,50,58,.4)" } : { background: FIRE.card2Noir, border: `1px solid ${FIRE.line2Noir}` }) }}>
            <Icon size={24} color={FIRE.redText} />
          </div>
          <h2 id="b4c-noir-dialog-title" style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 19, margin: "0 0 7px", letterSpacing: ".01em", lineHeight: 1.2 }}>{req.title}</h2>
          {req.body && para(req.body)}
          {isPrompt && (
            <div style={{ margin: "16px 2px 4px", textAlign: "left" }}>
              <div style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: FIRE.textSecondary, marginBottom: 7 }}>
                {req.label}{req.required ? "" : " (optional)"}
              </div>
              {req.multiline
                ? <textarea ref={fieldRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.placeholder} rows={3}
                    style={{ ...fieldStyle, minHeight: 78, resize: "vertical", lineHeight: 1.45 }} />
                : <input ref={fieldRef} value={text} onChange={(e) => setText(e.target.value)} placeholder={req.placeholder} inputMode={req.inputMode}
                    onKeyDown={(e) => { if (e.key === "Enter" && armed) finish(true); }} style={fieldStyle} />}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 10, padding: "18px 22px 20px" }}>
          <button type="button" onClick={() => finish(false)} style={btn}>{req.cancelLabel}</button>
          <button type="button" ref={okRef} disabled={!armed} onClick={() => finish(true)}
            style={{ ...btn, background: FIRE.redBright, borderColor: FIRE.redBright, color: "#fff", opacity: armed ? 1 : 0.45, cursor: armed ? "pointer" : "not-allowed" }}>
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
