import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !key) {
  // Don't crash the bundle — surface a clear console message instead.
  console.warn('[B4C] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set them in .env.local and in Vercel.')
}

export const supabase = createClient(url || 'http://localhost:54321', key || 'public-anon-key')
export const hasConfig = Boolean(url && key)
