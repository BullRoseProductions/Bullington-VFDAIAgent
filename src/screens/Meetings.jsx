import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const fmt = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Date TBD'

export default function Meetings({ onOpen }) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState('')
  useEffect(() => { api.listMeetings().then(setRows).catch(e => setErr(e.message)) }, [])

  if (err) return <div className="screen pad"><div className="err">{err}</div></div>
  if (!rows) return <div className="screen pad"><div className="loading">Loading…</div></div>

  return (
    <div className="screen pad">
      <div className="greet" style={{ fontSize: 21 }}>Meetings & Minutes</div>
      <div className="sub">Agendas, filed minutes, and the action items that come out of them.</div>
      {rows.length === 0 && <div className="empty">No meetings yet.<br />When your board schedules one, it shows up here.</div>}
      {rows.map(m => (
        <div key={m.id} className="card tap row" role="button" tabIndex={0}
          onClick={() => onOpen(m.id)} onKeyDown={e => e.key === 'Enter' && onOpen(m.id)}>
          <div style={{ flex: 1 }}>
            <h4>{m.title}</h4>
            <div className="meta">{fmt(m.scheduled_at)}{m.location ? ` · ${m.location}` : ''}</div>
          </div>
          <span className={`pill ${m.status}`}>{m.status}</span>
          <span className="arw">›</span>
        </div>
      ))}
    </div>
  )
}
