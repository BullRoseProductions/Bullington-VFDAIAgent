/* THE DOCX PREVIEW'S HTML IS SANITIZED BEFORE IT IS RENDERED (security review M-1).

   mammoth turns an uploaded Word file into HTML, and DocViewer renders that HTML with dangerouslySetInnerHTML. A Word
   hyperlink can carry any target — "javascript:…", "data:text/html,…" — and mammoth passes it through, so without this
   one tap on a link in a previewed document runs script in the app's origin as whoever opened it.

   DOMPurify (pinned, bundled — never a CDN) strips every event-handler attribute, script and embedding tag, and any URL
   outside the allowlist. Links additionally go through safeHref — the same gate as every other user-supplied link — so
   there is one definition of a safe link, not two. In-document anchors ("#_Toc…", mammoth's footnote links) are kept.
   Embedded images stay: mammoth inlines them as data:image/… on <img>, which DOMPurify permits on <img src> only.
   A surviving external link opens in a new tab (noopener) rather than navigating the app — on a phone that would
   replace the app's own web view.

   FAILS CLOSED: with no usable DOM (DOMPurify unsupported) this returns "" and the viewer falls back to Download. */
import createDOMPurify from "dompurify";
import { safeHref } from "./safeHref.js";

const CONFIG = {
  USE_PROFILES: { html: true },                       // HTML only: no SVG, no MathML
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link"],
  FORBID_ATTR: ["style", "srcset", "action", "formaction", "ping", "xlink:href"],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#)/i,
};

let purifier = null, boundTo = null;
function purifierFor(win) {
  if (purifier && boundTo === win) return purifier;
  const p = createDOMPurify(win);
  p.addHook("afterSanitizeAttributes", (node) => {
    if (!node.hasAttribute || !node.hasAttribute("href")) return;
    const v = node.getAttribute("href") || "";
    if (v.startsWith("#")) return;                      // in-document anchor
    const safe = safeHref(v);
    if (!safe) { node.removeAttribute("href"); return; }
    node.setAttribute("href", safe);
    if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
  });
  purifier = p; boundTo = win;
  return p;
}

export function sanitizeDocxHtml(html, win = typeof window !== "undefined" ? window : undefined) {
  if (!win) return "";
  const p = purifierFor(win);
  if (!p.isSupported) return "";
  return p.sanitize(String(html ?? ""), CONFIG);
}
