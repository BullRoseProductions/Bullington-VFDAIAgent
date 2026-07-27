# B4C — Equipment Slice 6 UI Build Brief (Recover / Mark-lost)

**For Claude Code, driven by Ashlea. `recover_equipment` and `mark_equipment_lost` are LIVE and
verified in the DB (both SECURITY DEFINER, manager/DA-gated, authenticated-only). This brief wires the
manager-facing UI in `src/App.jsx`. Nothing here touches the database.**

Decisions (already made): both actions are **manager/DA only**, and they live **on the held item's row**
in the manager ledger, revealed in **edit mode**, next to the existing Edit/Remove.

## Ground rules (unchanged)
- One step at a time; compile between steps.
- **Show Ashlea the diff before applying** — real diff, readable pieces. Never apply without showing.
- Branch → commit → merge --no-ff → push, git commands one at a time.
- Test on the LIVE DEPLOY. It's the live North Hood pilot — nothing here deletes data, but stay careful.
- Reuse what exists: `ConfirmReturnModal` is the near-exact template for `RecoverModal`; the "LOST" badge
  already exists in the status ladder (~line 8032); the `(isManager || isDA)` gate already used by the
  PENDING RETURNS section (~line 7956) is the same gate these actions use.

Design note: recovery closes a holder's custody as a **manager reconciliation** (found in station / holder
unreachable) — it's deliberately distinct from a clean member return. Mark-lost records gear as gone and
keeps, on the now-closed row, who held it. Both are attributed to the acting manager. Keep that honesty.

---

## STEP 1 — Add the RecoverModal component

Self-contained; nothing opens it yet, so it compiles inertly.

**Anchor:** immediately AFTER the whole `function ConfirmReturnModal(...) { ... }` block (ends ~line 7664,
just before the `// My Equipment —` comment / `function MyEquipment(`).
**Add:**
```jsx
// Manager/DA recovery — reclaim a HELD item the holder didn't return (found in station, holder
// unreachable). Twin of ConfirmReturnModal, but calls recover_equipment (stamps close_action
// 'manager_recovery'). `unit` = { equipment_id, label, holder_name }.
function RecoverModal({ S, unit, meId, notify, onClose, onRecovered }) {
  const [cond, setCond] = useState("Needs attention");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    let path = null;
    try {
      if (file) {
        const { data: deptId } = await supabase.rpc("my_department_id");
        if (!deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
        const small = await downscaleImage(file);
        const safe = (small.name || "photo.jpg").replace(/[^a-zA-Z0-9._-]/g, "_");
        path = `${deptId}/equipment/${Date.now()}-${safe}`;   // deptId FIRST — storage policy gates on first folder = dept
        const { error: upErr } = await supabase.storage.from("station-documents").upload(path, small);
        if (upErr) { notify({ kind: "error", title: "Upload failed", text: upErr.message || "Please try again." }); return; }
      }
      const { error } = await supabase.rpc("recover_equipment", {
        p_equipment_id: unit.equipment_id,
        p_condition: cond,
        p_photo_path: path,
      });
      if (error) {
        if (path) await supabase.storage.from("station-documents").remove([path]).catch(() => {});   // orphan cleanup
        notify({ kind: "error", title: "Couldn't recover the item", text: error.message || "Please try again." }); return;
      }
      notify({ kind: "success", title: "Item recovered", text: `${unit.label} is back in inventory.` });
      onRecovered();
    } finally { setBusy(false); }
  }
  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(8,10,16,.66)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, width: "100%", maxWidth: 420, padding: 20, margin: "24px 0" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
          <div style={FS.kicker}>RECOVER ITEM</div>
          <button onClick={onClose} style={{ marginLeft: "auto", ...FS.btn, padding: "5px 8px" }}><X size={14} color={FIRE.textSecondary} /></button>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: FIRE.textPrimary }}>{unit.label}</div>
        <div style={{ fontSize: 12, color: FIRE.textMuted, marginBottom: 8 }}>{unit.holder_name ? `Currently signed to ${unit.holder_name}` : "Currently checked out"}</div>
        <div style={{ fontSize: 12, color: FIRE.textSecondary, marginBottom: 14, lineHeight: 1.45 }}>Reclaiming without a member return — this closes their custody as a manager recovery and puts the item back in inventory.</div>
        <label style={{ ...S.field, marginBottom: 12 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Condition on recovery</span>
          <select style={FS.input} value={cond} onChange={(e) => setCond(e.target.value)}>
            <option value="Needs attention">Needs attention</option>
            <option value="Serviceable">Serviceable</option>
            <option value="Out of service">Out of service</option>
          </select>
        </label>
        <label style={{ ...S.field, marginBottom: 16 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Condition photo (optional)</span>
          <input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ fontSize: 13, color: FIRE.textSecondary }} />
        </label>
        <div style={{ display: "flex", gap: 10 }}>
          <button disabled={busy} onClick={submit} style={{ ...FS.btnPrimary, flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Recovering…" : "Recover to inventory"}</button>
          <button disabled={busy} onClick={onClose} style={FS.btn}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```
(`createPortal`, `X`, `FIRE`, `FS`, `downscaleImage`, `supabase` are all already in use by `ConfirmReturnModal` — this mirrors it.)

**Step 1 verify:** clean `npm run build`. Commit.

---

## STEP 2 — Wire Recover / Mark-lost into the manager ledger

### 2a. State + the mark-lost handler
**Anchor:** inside `function Equipment(...)`, right after
```jsx
  const [confirming, setConfirming] = useState(null); // pending row being confirmed (modal)
```
**Add:**
```jsx
  const [recovering, setRecovering] = useState(null); // held unit being recovered (modal)
  const [lostId, setLostId] = useState(null);         // equipment_id mid mark-lost
  async function markLost(u, idLabel) {
    if (!window.confirm(`Mark ${idLabel} lost? This records it as missing and closes ${u.holderName || "the holder"}'s custody. It can't be undone in the app.`)) return;
    setLostId(u.id);
    const { error } = await supabase.rpc("mark_equipment_lost", { p_equipment_id: u.id });
    setLostId(null);
    if (error) { notify({ kind: "error", title: "Couldn't mark it lost", text: error.message || "Please try again." }); return; }
    notify({ kind: "success", title: "Marked lost", text: `${idLabel} is recorded as lost.` });
    loadEquipment(); loadPending();
  }
```
(If CC finds `isManager` isn't in scope where Step 2b needs it, it IS defined near the top of `Equipment`
— it's the same variable the PENDING RETURNS section uses at `(isManager || isDA)`. Reuse it; don't invent a new one.)

### 2b. The two row actions (held items only, manager/DA, edit mode)
**Anchor:** the existing "Remove" button on a unit row (~line 8044):
```jsx
                            {canManage && editMode && <button title="Remove" style={{ ...FS.btn, padding: "5px 7px" }} onClick={() => removeUnit(u.id, idLabel)}><X size={13} color={FIRE.deleteRed} /></button>}
```
**Add immediately AFTER it (still inside the same row `<div>`):**
```jsx
                            {(isManager || isDA) && editMode && u.status === "held" && <button title="Recover to inventory" style={{ ...FS.btn, padding: "5px 8px", fontSize: 11.5 }} onClick={() => setRecovering({ equipment_id: u.id, label: `${t.name} · ${idLabel}`, holder_name: u.holderName })}>Recover</button>}
                            {(isManager || isDA) && editMode && u.status === "held" && <button title="Mark lost" disabled={lostId === u.id} style={{ ...FS.btn, padding: "5px 8px", fontSize: 11.5, color: FIRE.deleteRed, opacity: lostId === u.id ? 0.6 : 1 }} onClick={() => markLost(u, idLabel)}>Lost</button>}
```
(`t.name`, `idLabel`, `u.holderName`, `editMode`, `isDA` are all in scope here; `isManager` per the note above.)

### 2c. Mount the RecoverModal
**Anchor:** the existing `ConfirmReturnModal` mount block near the end of `Equipment`'s return (~line 8106-8112):
```jsx
      {confirming && (
        <ConfirmReturnModal
          S={S} row={confirming} meId={meId} notify={notify}
          onClose={() => setConfirming(null)}
          onConfirmed={() => { setConfirming(null); loadEquipment(); loadPending(); }}
        />
      )}
```
**Add immediately AFTER that block:**
```jsx
      {recovering && (
        <RecoverModal
          S={S} unit={recovering} meId={meId} notify={notify}
          onClose={() => setRecovering(null)}
          onRecovered={() => { setRecovering(null); loadEquipment(); loadPending(); }}
        />
      )}
```

**Step 2 verify:** clean `npm run build`, then commit Steps 1+2, push, deploy.

---

## The live test (manager/DA — you can do this as yourself; PA passes the DA gate)
Set up: as a manager/DA, **Issue** a test item to a real Active member so there's something held.
Then on the Equipment page, turn on **edit mode** (the "Edit"/edit-checklist toggle) and, on that held unit's row:

1. **Recover** → modal → pick a condition → "Recover to inventory." The unit's badge flips from **Checked out** to its condition (in inventory), and the holder is cleared. The member's My Equipment drops it.
2. Issue another test item, then **Lost** → confirm the dialog → the unit's badge becomes **LOST** and the holder is cleared.
3. **Guards to confirm** (proof not promises): the buttons only appear for held items, in edit mode, to a manager/DA. And — read-only, via the runner or a quick query — confirm the two closed rows carry the right stamps:
   ```sql
   select equipment_name, close_action, closed_by_name, condition_at_close
   from equipment_custody where close_action in ('manager_recovery','marked_lost')
   order by closed_at desc limit 5;
   ```
   Expect one `manager_recovery` and one `marked_lost`, each attributed to you.

Commit, merge --no-ff, push, confirm the Build-ID footer. Then step 6 is done — leaving step 7 (exit turn-in), the last one.

## Non-scope (deliberate)
- **Un-losing** a found item (status `lost` → back to inventory) isn't in this slice — a manager can edit the unit if needed. Add a dedicated action later only if it's actually wanted.
- Orphaned periods (equipment_id null) are still out of scope per your call earlier tonight.
