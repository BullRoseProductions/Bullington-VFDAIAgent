/* USER-SUPPLIED LINKS GO THROUGH ONE SCHEME ALLOWLIST (security review M-2).

   A link somebody typed into the app — a resource's website, a donation campaign's page, a resource's email — is
   rendered into <a href>. Without a check, "javascript:…" there runs as the viewer, in the app's own origin, the moment
   anybody taps it. This is the one gate every such link passes; render sites never put a stored URL into href raw.

   ALLOWED: http, https, mailto, tel. Everything else (javascript:, data:, vbscript:, file:, blob:, sms: …) → null, and
   the caller renders no link at all.

   PARSED THE WAY THE BROWSER WILL PARSE IT. The WHATWG URL parser drops leading/trailing control characters and every
   tab/newline before reading the scheme — exactly what defeats a string-prefix check ("java\tscript:", " javascript:").
   The value returned is the PARSED href, so what was checked is byte-for-byte what is rendered.

   A BARE HOST ("www.example.org", "example.org/help") is what people type into a "Website" box. Rendered raw it is a
   relative link into the app itself; it is read as https:// instead. Nothing that does not look like a host is guessed at.

   App-built links whose scheme is fixed in code and whose payload is digits only (`tel:${telDigits(x)}`,
   `sms:${telDigits(x)}`) do not need this, and sms: is deliberately not on the user-link list. */
export const SAFE_HREF_SCHEMES = Object.freeze(["http:", "https:", "mailto:", "tel:"]);

const BARE_HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

export function safeHref(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let u = null;
  try { u = new URL(s); } catch { /* no scheme — maybe a bare host */ }
  if (!u && BARE_HOST.test(s)) { try { u = new URL(`https://${s}`); } catch { u = null; } }
  return u && SAFE_HREF_SCHEMES.includes(u.protocol) ? u.href : null;
}
