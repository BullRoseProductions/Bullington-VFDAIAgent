import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
const isOverdue = (due, status) => status === 'open' && due && new Date(due) < new Date(new Date().toDateString())

// Board (canmanage) roles — mirrors is_canmanage() on the server
const CAN_MANAGE = ['Board', 'DeptAdmin', 'Officer', 'ProjectAdmin']
const canManage = me => (me.access || []).some(r => CAN_MANAGE.includes(r))

export default function MeetingDetail({ id, me, back }) {
  const [m, setM] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  const manage = canManage(me)

  async function load() {
    try { const data = await api.getMeeting(id); setM(data); setDraft(data.minutes_body || '') }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [id])

  async function toggle(item) {
    setErr('')
    try { await api.setActionStatus(item.id, item.status === 'done' ? 'open' : 'done'); await load() }
    catch (e) { setErr(e.message) }
  }
  async function save() {
    setBusy(true); setErr('')
    try { await api.fileMinutes(id, draft); setEditing(false); await load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function complete() {
    if (!confirm('Mark this meeting completed? This starts the 14-day archive grace period.')) return
    setBusy(true); setErr('')
    try { await api.completeMeeting(id); await load() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  async function aiDraft() {
    setAiBusy(true); setErr('')
    try {
      const text = await api.draftMinutes({
        title: m.title,
        agenda: (m.agenda_items || []).map(a => a.title),
        notes: draft,
      })
      setDraft(prev => (prev ? prev + '\n\n' : '') + text)
    } catch (e) { setErr('AI drafting isn\'t configured yet — add ANTHROPIC_API_KEY in Vercel to enable it.') }
    finally { setAiBusy(false) }
  }

  if (err && !m) return <div className="screen pad"><button className="back" onClick={back}><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>Meetings</button><div className="err">{err}</div></div>
  if (!m) return <div className="screen pad"><div className="loading">Loading…</div></div>

  const actions = m.action_items || []
  return (
    <div className="screen pad">
      <button className="back" onClick={back}><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg>Meetings</button>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div className="greet" style={{ fontSize: 20 }}>{m.title}</div>
          <div className="sub" style={{ marginBottom: 8 }}>
            {fmtDate(m.scheduled_at)}{m.location ? ` · ${m.location}` : ''}
          </div>
        </div>
        <span className={`pill ${m.status}`} style={{ marginTop: 4 }}>{m.status}</span>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="sect">Agenda</div>
      {(m.agenda_items || []).length === 0 && <div className="card"><div className="meta">No agenda items yet.</div></div>}
      {(m.agenda_items || []).map(a => (
        <div key={a.id} className="card">
          <h4>{a.position}. {a.title}</h4>
          {a.notes && <p>{a.notes}</p>}
        </div>
      ))}

      <div className="sect">Minutes</div>
      {editing ? (
        <>
          <textarea value={draft} onChange={e => setDraft(e.target.value)} placeholder="Type or paste rough notes, then file them as the minutes of record…" />
          <div className="btnrow">
            <button className="btn" disabled={busy} onClick={save}>{busy ? 'Filing…' : 'File minutes'}</button>
            <button className="btn ghost sm" disabled={aiBusy} onClick={aiDraft}>{aiBusy ? 'Drafting…' : '✨ Draft with AI'}</button>
          </div>
          <div className="note">Filing bumps the version and re-stamps the time on the server. AI drafts; a human files.</div>
        </>
      ) : m.minutes_body ? (
        <>
          <div className="minutes">{m.minutes_body}</div>
          <div className="row" style={{ marginTop: 8, gap: 10 }}>
            <span className="vtag">v{m.minutes_version} · filed {fmtDate(m.minutes_filed_at)}</span>
            {manage && <button className="btn ghost sm" onClick={() => setEditing(true)} style={{ marginLeft: 'auto' }}>Revise</button>}
          </div>
        </>
      ) : manage ? (
        <button className="btn ghost" onClick={() => setEditing(true)}>File the minutes</button>
      ) : (
        <div className="card"><div className="meta">Minutes haven't been filed yet.</div></div>
      )}

      <div className="sect">Action items</div>
      {actions.length === 0 && <div className="card"><div className="meta">No action items from this meeting.</div></div>}
      {actions.map(a => {
        const mine = a.owner_member_id === me.id
        const editable = mine || manage
        const owner = a.members?.full_name || 'Unassigned'
        return (
          <div key={a.id} className="ai">
            <button className={`box ${a.status === 'done' ? 'on' : ''}`} disabled={!editable}
              onClick={() => editable && toggle(a)} aria-label="toggle done"
              style={{ cursor: editable ? 'pointer' : 'default' }}>
              {a.status === 'done' && <svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" /></svg>}
            </button>
            <div className="body">
              <div className={`t ${a.status === 'done' ? 'struck' : ''}`}>{a.title}</div>
              <div className="m">
                {owner}{mine ? ' (you)' : ''}{a.due_date ? ` · due ${fmtDate(a.due_date)}` : ''}
                {isOverdue(a.due_date, a.status) ? ' · ' : ''}
              </div>
            </div>
            {isOverdue(a.due_date, a.status) && <span className="pill overdue">Overdue</span>}
          </div>
        )
      })}

      {manage && m.status === 'open' && (
        <div className="btnrow" style={{ marginTop: 16 }}>
          <button className="btn" disabled={busy} onClick={complete}>Complete meeting</button>
        </div>
      )}
      {manage && m.status === 'completed' && m.archive_after && (
        <div className="note">Completed — archives permanently after {fmtDate(m.archive_after)} (14-day grace).</div>
      )}
    </div>
  )
}
