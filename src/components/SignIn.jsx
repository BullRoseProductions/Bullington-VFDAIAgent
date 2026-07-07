import { useState } from 'react'
import { supabase, hasConfig } from '../lib/supabase'

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    setErr(''); setBusy(true)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) setErr(error.message); else setSent(true)
  }

  return (
    <div className="signin screen">
      <div className="brand"><b>Before the Call</b><span className="badge">POA</span></div>
      <h1>Your association, in your pocket.</h1>
      <p>Sign in with your association email. We'll send you a one-tap login link — no password to remember.</p>

      {!hasConfig && <div className="err">Supabase isn't configured yet. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then reload.</div>}
      {err && <div className="err">{err}</div>}

      {sent ? (
        <div className="ok">Check your email — we sent a login link to <b>{email}</b>. Open it on this device to continue.</div>
      ) : (
        <>
          <label className="fl">Association email</label>
          <input type="email" value={email} placeholder="you@department.org"
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && email && send()} />
          <div style={{ height: 12 }} />
          <button className="btn" disabled={!email || busy} onClick={send}>
            {busy ? 'Sending…' : 'Send my login link'}
          </button>
          <div className="note">Only emails on your association's roster can sign in. If yours isn't recognized, contact your board.</div>
        </>
      )}
    </div>
  )
}
