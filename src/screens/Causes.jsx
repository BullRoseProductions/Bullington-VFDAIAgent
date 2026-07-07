import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const CAN = ['Board', 'DeptAdmin', 'Officer', 'ProjectAdmin']
const canManage = me => (me.access || []).some(r => CAN.includes(r))
const money = n => (n || n === 0) ? '$' + Number(n).toLocaleString() : null

export default function Causes({ me, onOpen }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ name: '', tagline: '', external_url: '', goal_amount: '' })
  const manage = canManage(me)

  async function load() {
    try { setRows(await api.listCauses()) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [])

  async function add() {
    if (!f.name.trim()) return
    setErr('')
    try {
      await api.createCause({
        department_id: me.department_id,
        name: f.name.trim(),
        tagline: f.tagline.trim() || null,
        external_url: f.external_url.trim() || null,
        goal_amount: f.goal_amount ? Number(f.goal_amount) : null,
      })
      setF({ name: '', tagline: '', external_url: '', goal_amount: '' })
      setAdding(false)
      await load()
    } catch (e) { setErr(e.message) }
  }

  if (!rows) return <div className="screen pad"><div className="loading">Loading…</div></div>

  return (
    <div className="screen pad">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="greet" style={{ fontSize: 21 }}>Causes</div>
          <div className="sub">The initiatives your association stands behind.</div>
        </div>
        {manage && !adding && <button className="btn sm" onClick={() => setAdding(true)}>+ Add</button>}
      </div>

      {err && <div className="err">{err}</div>}

      {adding && (
        <div className="card">
          <label className="fl">Cause name</label>
          <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. Scholarship Fund" />
          <div style={{ height: 9 }} />
          <label className="fl">Tagline (optional)</label>
          <input value={f.tagline} onChange={e => setF({ ...f, tagline: e.target.value })} placeholder="One line about it" />
          <div style={{ height: 9 }} />
          <label className="fl">Link to donate / sign up (optional)</label>
          <input value={f.external_url} onChange={e => setF({ ...f, external_url: e.target.value })} placeholder="https://…" />
          <div style={{ height: 9 }} />
          <label className="fl">Fundraising goal (optional)</label>
          <input value={f.goal_amount} onChange={e => setF({ ...f, goal_amount: e.target.value })} placeholder="10000" inputMode="numeric" />
          <div className="btnrow">
            <button className="btn" onClick={add}>Save cause</button>
            <button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          <div className="note">This lives in your association's data — every POA adds their own.</div>
        </div>
      )}

      {rows.length === 0 && !adding && (
        <div className="empty">
          No causes yet.<br />
          {manage ? "Add your association's first initiative — it lives in your data, not the code."
                  : 'Your board hasn\'t added any yet.'}
        </div>
      )}

      {rows.map(c => (
        <div key={c.id} className="card tap row" role="button" tabIndex={0}
          onClick={() => onOpen(c.id)} onKeyDown={e => e.key === 'Enter' && onOpen(c.id)}>
          <div style={{ flex: 1 }}>
            <h4>{c.name}</h4>
            {c.tagline && <div className="meta">{c.tagline}</div>}
            {money(c.goal_amount) && <div className="meta" style={{ marginTop: 3 }}>Goal {money(c.goal_amount)}</div>}
          </div>
          {c.status === 'archived' && <span className="pill kind">Archived</span>}
          <span className="arw">›</span>
        </div>
      ))}
    </div>
  )
}
