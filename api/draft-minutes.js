// Optional Vercel serverless function: turns an agenda + rough notes into
// draft minutes. Grounded in what was actually on the agenda — no fabrication.
// Enable by setting ANTHROPIC_API_KEY in Vercel. If it's unset, the app's
// "Draft with AI" button simply shows a friendly "not configured yet" message.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method not allowed')
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return res.status(501).send('ANTHROPIC_API_KEY is not set')

  const { title = 'Meeting', agenda = [], notes = '' } = req.body || {}
  const prompt =
    `You are drafting the minutes of record for a police association meeting titled "${title}".\n` +
    `Agenda items:\n${agenda.map((a, i) => `${i + 1}. ${a}`).join('\n') || '(none provided)'}\n\n` +
    `Rough notes from the meeting:\n${notes || '(none provided)'}\n\n` +
    `Write clean, factual minutes organized by the agenda above. Only state what the notes support — ` +
    `do not invent motions, votes, names, or numbers. Where the notes are silent, write "No discussion recorded." ` +
    `A human will review and file this. Return only the minutes text.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!r.ok) return res.status(502).send(await r.text())
    const data = await r.json()
    const minutes = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    return res.status(200).json({ minutes })
  } catch (e) {
    return res.status(500).send(String(e))
  }
}
