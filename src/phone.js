/* Phone numbers for DISPLAY. Numbers were typed by people over the years — "8175550199", "817.555.0199",
   "(817)555-0199", "+1 817 555 0199" — and each screen printed whatever was stored. One formatter, used
   everywhere a number is shown, so the same person's number looks the same on every screen.

   Display only: the stored value is never rewritten, and tel: links keep using telDigits. A US number
   (10 digits, or 11 with a leading 1) reads "(817) 555-0199"; anything else — an extension, an
   international number, a typo — comes back exactly as stored (trimmed), never dropped or guessed at. */
export function fmtPhone(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (/[a-wyz]/i.test(s)) return s;                 // words in it (an extension spelled out, a note) — leave it alone; x is "ext"
  const d = s.replace(/\D/g, "");
  const ten = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (ten.length !== 10 || /x/i.test(s)) return s;   // not a plain US number (or has an extension) — as stored
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}
