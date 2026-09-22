import { Capacitor } from "@capacitor/core";

/* HANDING A FILE TO THE USER, on whichever platform they're on.

   THE BUG THIS EXISTS TO FIX: every export in the app used the browser download idiom —
   an <a download> click, or jsPDF's doc.save() which is the same thing underneath. That
   idiom is a no-op inside a Capacitor WKWebView. No error, no console warning, no file:
   the member taps "Download PDF" or "Print" on their iPhone and nothing whatsoever
   happens. iOS has no download manager and no visible filesystem for a web view to
   target, so the only real destination for a generated file on a phone is the share
   sheet, which is also how a file reaches Files, Mail, AirDrop or a printer.

   WEB IS UNCHANGED. The anchor path below is the same click the app has always done, and
   it stays the path on every desktop and mobile browser. Only a native build branches.

   The plugins are imported DYNAMICALLY so the web bundle never pulls in native shims for
   code it will not run — the same reason push.js and geofence.js do it. */

export const isNativePlatform = () => Capacitor.isNativePlatform();

/* The toast channel. share.js is imported by report.js and by module-scope helpers in
   App.jsx, none of which are inside a component and none of which can see the `notify`
   prop that gets threaded down from the toast state. Rather than thread notify through
   seven call sites for the sole purpose of reporting a failure, the app registers the
   notifier once at startup and every export path can speak.

   A SILENT FAILURE IS THE ONE OUTCOME THIS MODULE MUST NOT HAVE — silence is exactly the
   bug being fixed, and a share that fails quietly is indistinguishable from the old
   no-op. */
let notifier = null;
export function setShareNotifier(fn) { notifier = typeof fn === "function" ? fn : null; }
const say = (n) => { try { notifier?.(n); } catch { /* a toast must never break a save */ } };

/* Blob -> bare base64 (no data: prefix), which is what Filesystem.writeFile wants when
   no `encoding` is given. FileReader rather than a manual btoa over a byte string: the
   latter blows the call stack on a multi-page PDF. */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onloadend = () => {
      const s = typeof r.result === "string" ? r.result : "";
      const comma = s.indexOf(",");
      comma >= 0 ? resolve(s.slice(comma + 1)) : reject(new Error("Couldn't read the generated file."));
    };
    r.onerror = () => reject(r.error || new Error("Couldn't read the generated file."));
    r.readAsDataURL(blob);
  });
}

/* Filenames reach here from department names and member-entered titles. iOS will happily
   write a path separator into a filename and then fail to resolve the URI, so the name is
   flattened before it becomes a real file. The extension is preserved because the share
   sheet types the file from it — strip the ".pdf" and iOS offers no "Save to Files". */
function safeName(filename, fallback) {
  const raw = String(filename || "").trim() || fallback;
  const cleaned = raw.replace(/[/\\:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/^[.\s-]+|[\s-]+$/g, "");
  return cleaned || fallback;
}

/* THE ONE WAY A GENERATED FILE LEAVES THE APP.

   Returns { ok } — ok:false only for a real failure. A share sheet the user swipes away
   is ok:true and silent: they cancelled on purpose, and a "couldn't share" toast after a
   deliberate cancel is the app arguing with them.

   `title` is what the share sheet calls the item; it falls back to the filename. */
export async function saveOrShare(blob, filename, title) {
  const name = safeName(filename, "document.pdf");
  if (!Capacitor.isNativePlatform()) {
    // WEB: the same anchor click the app has always done, with two small hardenings that
    // the consolidation made free. The anchor is attached to the document before it is
    // clicked, which Firefox requires and the old inline copies did not do; and the object
    // URL is revoked on a timer rather than in the same tick, because Safari has
    // historically cancelled an in-flight download when the URL is revoked under it.
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { ok: true };
    } catch (e) {
      say({ kind: "error", title: "Couldn't download the file", text: "Something went wrong preparing the download. Please try again.", details: e?.message });
      return { ok: false, reason: "download", message: e?.message };
    }
  }

  // NATIVE: write to the app's cache, then hand the file URI to the system share sheet.
  // Cache and not Documents deliberately — these are generated artifacts, regenerable from
  // live data in one tap, and iOS is free to reclaim them. Whatever the member actually
  // wants to keep, they keep by choosing "Save to Files" in the sheet.
  try {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    const data = await blobToBase64(blob);
    // THE TIMESTAMP IS THE FOLDER, NOT THE FILENAME. Uniqueness is still required — two
    // reports generated a minute apart must not collide, and a stale file from last week
    // must not be what gets shared — but the share sheet shows the FILE name, and
    // "1790105399204-North-Hood-Roster.pdf" is what the member would then be asked to
    // save into Files. The folder carries the uniqueness; the file carries the name.
    const path = `exports/${Date.now()}/${name}`;
    await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    await Share.share({ title: title || name, files: [uri] });
    return { ok: true };
  } catch (e) {
    // The user dismissing the sheet arrives here as an error on iOS. That is a cancel, not
    // a failure, and it gets no toast.
    const msg = String(e?.message || e || "");
    if (/cancel/i.test(msg) || /abort/i.test(msg)) return { ok: true, cancelled: true };
    say({ kind: "error", title: "Couldn't share the file", text: "The file was created but the share sheet didn't open. Please try again.", details: msg });
    return { ok: false, reason: "share", message: msg };
  }
}

/* Convenience for the text exports (CSV) that used to build their own anchor. Same
   contract, one less line at each call site. */
export function saveOrShareText(text, filename, mime = "text/csv;charset=utf-8", title) {
  return saveOrShare(new Blob([text], { type: mime }), filename, title);
}
