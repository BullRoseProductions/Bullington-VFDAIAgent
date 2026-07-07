import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const CAN = ['Board', 'DeptAdmin', 'Officer', 'ProjectAdmin']
const canManage = me => (me.access || []).some(r => CAN.includes(r))
const money = n => (n || n === 0) ? '$' + Number(n).toLocaleString() : null
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const KINDS = [['contribution', 'Contribution'], ['participation', 'Participation'], ['outcome', 'Outcome'], ['update', 'Update']]

export default function CauseDetail({ id, me, back }) {
  const [c, setC] = useState(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(false)
  const [ef, setEf] = useState({})
  const [addingEntry, setAddingEntry] = useState(false)
  const [en, setEn] = useState({ kind: 'contribution', label: '', amount: '', occurred_on: '', note: '' })
  const manage = canManage(me)

  async function load() {
    try { const data = await api.getCause(id); setC(data); setEf({
      name: data.name, tagline: data.tagline || '', description: data.description || '',
      external_url: data.external_url || '', goal_amount: data.goal_amount ?? '', status: data.status,
    }) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [id])

  async function saveCause() {
    setErr('')
    try {
      await api.updateCause(id, {
        name: ef.name.trim(), tagline: ef.tagline.trim() || null,
        description: ef.description.trim() || null, external_url: ef.external_url.trim() || null,
        goal_amount: ef.goal_amount === '' ? null : Number(ef.goal_amount), status: ef.status,
      })
      setEditing(false); await load()
    } catch (e) { setErr(e.message) }
  }
  async function removeCause() {
    if (!confirm('Delete this cause and everything inside it? This can\'t be undone.')) return
    try { await api.deleteCause(id); back() } catch (e) { setErr(e.message) }
  }
  async function addEntry() {
    if (!en.label.trim()) return
    setErr('')
    try {
      await api.addCauseEntry({
        cause_id: id, department_id: me.department_id, kind: en.kind, label: en.label.trim(),
        amount: en.amount === '' ? null : Number(en.amount),
        occurred_on: en.occurred_on || null, note: en.note.trim() || null,
      })
      setEn({ kind: 'contribution', label: '', amount: '', occurred_on: '', note: '' })
      setAddingEntry(false); await load()
    } catch (e) { setErr(e.message) }
  }
  async function removeEntry(eid) {
    try { await api.deleteCauseEntry(eid); await load() } catch (e) { setErr(e.message) }
  }

  if (err && !c) return <div className="screen pad"><button className="back" onClick={back}><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>Causes</button><div className="err">{err}</div></div>
  if (!c) return <div className="screen pad"><div className="loading">Loading…</div></div>

  const entries = c.cause_entries || []
  const raised = entries.filter(e => e.kind === 'contribution' && e.amount).reduce((s, e) => s + Number(e.amount), 0)

  return (
    <div className="screen pad">
      <button className="back" onClick={back}><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>Causes</button>
      {err && <div className="err">{err}</div>}

      {editing ? (
        <div className="card">
          <label className="fl">Name</label>
          <input value={ef.name} onChange={e => setEf({ ...ef, name: e.target.value })} />
          <div style={{ height: 9 }} />
          <label className="fl">Tagline</label>
          <input value={ef.tagline} onChange={e => setEf({ ...ef, tagline: e.target.value })} />
          <div style={{ height: 9 }} />
          <label className="fl">Description</label>
          <textarea style={{ minHeight: 90 }} value={ef.description} onChange={e => setEf({ ...ef, description: e.target.value })} />
          <div style={{ height: 9 }} />
          <label className="fl">Donate / sign-up link</label>
          <input value={ef.external_url} onChange={e => setEf({ ...ef, external_url: e.target.value })} placeholder="https://…" />
          <div style={{ height: 9 }} />
          <label className="fl">Goal amount</label>
          <input value={ef.goal_amount} onChange={e => setEf({ ...ef, goal_amount: e.target.value })} inputMode="numeric" />
          <div style={{ height: 9 }} />
          <label className="fl">Status</label>
          <select value={ef.status} onChange={e => setEf({ ...ef, status: e.target.value })}
            style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 11, color: 'var(--text)', padding: '12px 13px', fontSize: 14 }}>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </select>
          <div className="btnrow">
            <button className="btn" onClick={saveCause}>Save changes</button>
            <button className="btn ghost sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          <div style={{ height: 8 }} />
          <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={removeCause}>Delete cause</button>
        </div>
      ) : (
        <>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div className="greet" style={{ fontSize: 20 }}>{c.name}</div>
              {c.tagline && <div className="sub" style={{ marginBottom: 6 }}>{c.tagline}</div>}
            </div>
            {c.status === 'archived' && <span className="pill kind" style={{ marginTop: 4 }}>Archived</span>}
          </div>
          {c.description && <div className="card"><p style={{ marginTop: 0 }}>{c.description}</p></div>}

          {(money(c.goal_amount) || raised > 0) && (
            <div className="tiles">
              <div className="tile"><div className="n" style={{ fontSize: 20 }}>{money(raised) || '$0'}</div><div className="l">Raised (tracked)</div></div>
              <div className="tile"><div className="n" style={{ fontSize: 20 }}>{money(c.goal_amount) || '—'}</div><div className="l">Goal</div></div>
            </div>
          )}

          {c.external_url && (
            <a className="btn" href={c.external_url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', marginTop: 4 }}>
              Support this cause ↗
            </a>
          )}
          {c.external_url && <div className="note">We plan and prove — we don't process. Giving happens on the linked platform.</div>}

          {manage && <button className="btn ghost sm" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>Edit cause</button>}
        </>
      )}

      <div className="row" style={{ margin: '20px 2px 9px', alignItems: 'center' }}>
        <div className="sect" style={{ margin: 0, flex: 1 }}>Activity</div>
        {manage && !addingEntry && <button className="btn sm" onClick={() => setAddingEntry(true)}>+ Add</button>}
      </div>

      {addingEntry && (
        <div className="card">
          <label className="fl">Type</label>
          <select value={en.kind} onChange={e => setEn({ ...en, kind: e.target.value })}
            style={{ width: '100%', background: 'var(--surface)', border: '1px solid var(--line2)', borderRadius: 11, color: 'var(--text)', padding: '12px 13px', fontSize: 14 }}>
            {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div style={{ height: 9 }} />
          <label className="fl">What happened</label>
          <input value={en.label} onChange={e => setEn({ ...en, label: e.target.value })} placeholder="e.g. Toy drive at Station 4" />
          <div style={{ height: 9 }} />
          <label className="fl">Amount (for contributions)</label>
          <input value={en.amount} onChange={e => setEn({ ...en, amount: e.target.value })} inputMode="numeric" placeholder="Leave blank if N/A" />
          <div style={{ height: 9 }} />
          <label className="fl">Date</label>
          <input type="date" value={en.occurred_on} onChange={e => setEn({ ...en, occurred_on: e.target.value })} />
          <div className="btnrow">
            <button className="btn" onClick={addEntry}>Save entry</button>
            <button className="btn ghost sm" onClick={() => setAddingEntry(false)}>Cancel</button>
          </div>
          <div className="note">Countable and honest — record what actually happened, not a fabricated total.</div>
        </div>
      )}

      {entries.length === 0 && !addingEntry && <div className="card"><div className="meta">No activity recorded yet.</div></div>}
      {entries.map(e => (
        <div key={e.id} className="ai">
          <div className="body">
            <div className="t">{e.label}{e.amount ? ` · ${money(e.amount)}` : ''}</div>
            <div className="m">{KINDS.find(k => k[0] === e.kind)?.[1] || e.kind}{e.occurred_on ? ` · ${fmtDate(e.occurred_on)}` : ''}</div>
          </div>
          {manage && <button className="btn ghost sm" style={{ color: 'var(--muted2)' }} onClick={() => removeEntry(e.id)}>Remove</button>}
        </div>
      ))}
    </div>
  )
}
