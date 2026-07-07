import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
const isOverdue = (due, status) => status === 'open' && due && new Date(due) < new Date(new Date().toDateString())

export default function ActionItems({ me }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')

  async function load() {
    try { setRows(await api.myActionItems(me.id)) } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [me.id])

  async function toggle(item) {
    setErr('')
    try { await api.setActionStatus(item.id, item.status === 'done' ? 'open' : 'done'); await load() }
    catch (e) { setErr(e.message) }
  }

  if (err) return <div className="screen pad"><div className="err">{err}</div></div>
  if (!rows) return <div className="screen pad"><div className="loading">Loading…</div></div>

  const open = rows.filter(r => r.status === 'open')
  const done = rows.filter(r => r.status === 'done')

  return (
    <div className="screen pad">
      <div className="greet" style={{ fontSize: 21 }}>My Action Items</div>
      <div className="sub">What's assigned to you across every meeting. Check one off and it's stamped on the server.</div>

      {rows.length === 0 && <div className="empty">Nothing assigned to you right now.</div>}

      {open.length > 0 && <div className="sect">Open · {open.length}</div>}
      {open.map(a => (
        <div key={a.id} className="ai">
          <button className="box" onClick={() => toggle(a)} aria-label="mark done" />
          <div className="body">
            <div className="t">{a.title}</div>
            <div className="m">{a.meetings?.title || 'General'}{a.due_date ? ` · due ${fmtDate(a.due_date)}` : ''}</div>
          </div>
          {isOverdue(a.due_date, a.status) && <span className="pill overdue">Overdue</span>}
        </div>
      ))}

      {done.length > 0 && <div className="sect">Done · {done.length}</div>}
      {done.map(a => (
        <div key={a.id} className="ai">
          <button className="box on" onClick={() => toggle(a)} aria-label="reopen">
            <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>
          </button>
          <div className="body"><div className="t struck">{a.title}</div>
            <div className="m">{a.meetings?.title || 'General'}</div></div>
        </div>
      ))}
    </div>
  )
}
