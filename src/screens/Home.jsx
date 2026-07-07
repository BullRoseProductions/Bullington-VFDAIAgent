import { useEffect, useState } from 'react'
import * as api from '../lib/api'

const fmt = d => d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''

export default function Home({ me, org, onOpenMeeting, go }) {
  const [nextMtg, setNextMtg] = useState(null)
  const [openCount, setOpenCount] = useState(null)

  useEffect(() => {
    api.listMeetings().then(ms => {
      const upcoming = ms.filter(m => m.status === 'open')
      setNextMtg(upcoming[0] || null)
    }).catch(() => setNextMtg(null))
    api.myActionItems(me.id).then(items =>
      setOpenCount(items.filter(i => i.status === 'open').length)
    ).catch(() => setOpenCount(0))
  }, [me.id])

  const first = me.full_name?.split(' ').slice(-1)[0] || me.full_name
  return (
    <div className="screen pad">
      <div className="stop"><div className="o">{org?.name || 'Your Association'}</div><span className="ey">Member Hub</span></div>
      <div className="greet">Good day, {first}</div>
      <div className="sub">Here's what's happening in your association.</div>

      {nextMtg ? (
        <div className="hero tap" role="button" tabIndex={0}
          onClick={() => onOpenMeeting(nextMtg.id)}
          onKeyDown={e => e.key === 'Enter' && onOpenMeeting(nextMtg.id)}>
          <div className="k">Next meeting</div>
          <h3>{nextMtg.title}</h3>
          <div className="meta">{fmt(nextMtg.scheduled_at)}{nextMtg.location ? ` · ${nextMtg.location}` : ''} · tap for agenda</div>
        </div>
      ) : (
        <div className="card"><div className="meta">No upcoming meetings scheduled.</div></div>
      )}

      <div className="tiles">
        <button className="tile" onClick={() => go('actions')}>
          <div className="n">{openCount ?? '·'}</div>
          <div className="l">Your open action items</div>
        </button>
        <button className="tile" onClick={() => go('meetings')}>
          <div className="n">›</div>
          <div className="l">Meetings & minutes</div>
        </button>
      </div>

      <div className="sect">Your standing</div>
      <div className="card">
        <div className="row">
          <div style={{ flex: 1 }}>
            <h4>{me.standing || 'Good'}</h4>
            <div className="meta">Badge {me.badge || '—'}{me.district ? ` · District ${me.district}` : ''}</div>
          </div>
          <span className="pill done">Active</span>
        </div>
      </div>
    </div>
  )
}
