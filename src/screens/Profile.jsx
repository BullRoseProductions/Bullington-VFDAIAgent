import { supabase } from '../lib/supabase'

export default function Profile({ me }) {
  return (
    <div className="screen pad">
      <div className="greet" style={{ fontSize: 21 }}>Profile</div>
      <div className="sub">Your membership details.</div>

      <div className="card">
        <h4>{me.full_name}</h4>
        <div className="meta">{me.email}</div>
      </div>

      <div className="tiles">
        <div className="tile"><div className="n" style={{ fontSize: 18 }}>{me.badge || '—'}</div><div className="l">Badge</div></div>
        <div className="tile"><div className="n" style={{ fontSize: 18 }}>{me.district || '—'}</div><div className="l">District</div></div>
      </div>

      <div className="sect">Role</div>
      <div className="card">
        <div className="meta" style={{ lineHeight: 1.7 }}>{(me.access || ['Member']).join(' · ')}</div>
      </div>

      <div style={{ height: 18 }} />
      <button className="btn ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
  )
}
