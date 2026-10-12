// The FIRE palette — the app's colour tokens, shared by App.jsx and the sign-in screens (Login, SetPassword).
// Moved here verbatim from App.jsx so the auth screens can match the Industrial Noir shell without importing the app.
/* ---------------- FIRE-LUXURY palette (shared; rest of app adopts later) ---------------- */
export const FIRE = {
  pageBg: "radial-gradient(130% 100% at 100% 0%, #1A1217 0%, #0E1014 42%, #0A0B0E 100%)",
  sidebar: "#0A0C0F",
  card: "#13161B",
  hairline: "rgba(255,255,255,.05)",
  cardShadow: "0 10px 30px rgba(0,0,0,.4)",
  cardRadius: 16,
  textPrimary: "#F7F8FA",
  textSecondary: "#B6BDC8",
  textMuted: "#7E8794",
  textMuted2: "#9AA1AC",
  red: "#C8323A",          // active-nav hairline, today marker, kicker labels
  redBright: "#E5484D",    // tiny icon accents only
  green: "#3FB860",
  greenText: "#76C98D",
  amberText: "#D6A95E",
  blueText: "#5B9BD5",   // Board-audience events (distinct from leadership amber + fire red)
  redText: "#E58A90",
  track: "rgba(255,255,255,.06)",
  // --- Phase 0 additive tokens (values previously hardcoded in the Training reskins) ---
  name: "#F0F2F5",                       // near-white for NAMES (kept distinct from textPrimary #F7F8FA)
  btnBg: "rgba(255,255,255,.04)",        // dark control fill
  btnBorder: "rgba(255,255,255,.1)",     // dark control border
  inputBorder: "rgba(255,255,255,.12)",
  btnText: "#E7EAEF",
  btnIcon: "#9AA1AC",                    // == textMuted2
  navLabel: "#C7CDD6",
  neverLogged: "#D08A8F",
  deleteRed: "#C8606A",
  white: "#fff",
  // --- Industrial Noir (DA dashboard skin, v11 mock) ---
  cardNoir: "linear-gradient(180deg, #0F131A, #0B0E13)",          // card face: faint top-to-bottom falloff
  card2Noir: "#10141A",                                           // inset sub-panel (mini charts) inside a Noir card
  insetNoir: "#0A0D11",                                           // icon wells, segmented-control track
  lineNoir: "rgba(255,255,255,.07)",                              // Noir hairline (a touch stronger than `hairline`)
  line2Noir: "rgba(255,255,255,.13)",                             // Noir axis / control border
  cardShadowNoir: "0 10px 30px rgba(0,0,0,.45)",
  tileShadowNoir: "0 4px 14px rgba(0,0,0,.4)",
  // Hero band, in layers (bottom → top): the warm-edged near-black sweep, an optional photo, the glows, the left shade.
  heroBaseNoir: "linear-gradient(100deg, #05070A 0%, #0A0D12 55%, #160A0D 100%)",
  heroGlowNoir: "radial-gradient(140% 170% at 92% 0%, rgba(224,58,68,.58), rgba(200,50,58,.18) 30%, rgba(200,50,58,0) 50%), radial-gradient(90% 130% at 104% 122%, rgba(150,52,30,.4), rgba(0,0,0,0) 55%)",
  heroShadeNoir: "linear-gradient(90deg, rgba(0,0,0,.6) 0%, rgba(0,0,0,.25) 32%, transparent 52%)",
  heroPhotoOpacity: 0.2,                                          // a hero photo sits at ~15–25% under the glows
  kickerNoir: "#F2A3A8",                                          // brighter redText for the hero kicker
  // Noir categorical set (dashboard calendar): distinct, harmonized with the shell.
  catBlue: "#4F90D6", catGreen: "#2FA869", catAmber: "#CC9E52", catViolet: "#8E7CC3",
  barGlowNoir: "rgba(224,58,68,.45)",                             // FIRE.redBright glow on the current bar / point
};

// Sign-in screens (Login, SetPassword) — the Industrial Noir card on the noir page. Styles only.
const DISPLAY = "'Oswald', system-ui, sans-serif";
export const AUTH = {
  // Oswald + Public Sans (the app loads them in Fonts(); the auth screens render before the app, so they import too),
  // plus the input focus ring in brand red.
  css: `@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&display=swap');
    .b4c-input { transition: border-color .15s ease, box-shadow .15s ease; }
    .b4c-input:focus { outline: none; border-color: ${FIRE.red}; box-shadow: 0 0 0 3px rgba(200,50,58,.25); }
    .b4c-input::placeholder { color: ${FIRE.textMuted}; }`,
  page: { minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", background: FIRE.pageBg, fontFamily: "'Public Sans', system-ui, sans-serif", color: FIRE.textPrimary, padding: 20, paddingTop: "calc(20px + env(safe-area-inset-top))", paddingBottom: "calc(20px + env(safe-area-inset-bottom))" },
  card: { position: "relative", overflow: "hidden", background: `${FIRE.heroGlowNoir}, ${FIRE.cardNoir}`, borderRadius: 14, border: `1px solid ${FIRE.lineNoir}`, padding: 26, boxShadow: FIRE.cardShadowNoir },
  logo: { display: "block", height: 54, width: "auto", margin: "0 auto 10px" },
  brandLine: { fontFamily: DISPLAY, fontWeight: 600, fontSize: 10.5, letterSpacing: ".32em", textTransform: "uppercase", color: FIRE.textMuted2, textAlign: "center", margin: "0 0 18px" },
  heading: { fontFamily: DISPLAY, fontSize: 22, fontWeight: 700, color: FIRE.textPrimary, textAlign: "center", margin: "0 0 6px", letterSpacing: "-0.01em" },
  body: { fontSize: 13, color: FIRE.textSecondary, textAlign: "center", margin: "0 0 18px", lineHeight: 1.5 },
  input: { width: "100%", boxSizing: "border-box", padding: "11px 13px", fontSize: 15, borderRadius: 10, border: `1px solid ${FIRE.line2Noir}`, background: FIRE.insetNoir, color: FIRE.textPrimary, colorScheme: "dark", fontFamily: "inherit" },
  primary: { width: "100%", padding: "11px", fontSize: 15, fontWeight: 700, color: FIRE.white, background: FIRE.red, border: "none", borderRadius: 10, boxShadow: "0 4px 16px rgba(200,50,58,.35)", fontFamily: "inherit" },
  secondary: { width: "100%", padding: "9px", fontSize: 13.5, fontWeight: 600, color: FIRE.btnText, background: FIRE.btnBg, border: `1px solid ${FIRE.btnBorder}`, borderRadius: 10, fontFamily: "inherit" },
  link: { color: FIRE.textSecondary, background: "none", border: "none", textDecoration: "underline", fontFamily: "inherit" },
  muted: FIRE.textSecondary,
  divider: `1px solid ${FIRE.lineNoir}`,
  ok: FIRE.greenText,
  err: FIRE.redText,
  panel: { background: FIRE.btnBg, border: `1px solid ${FIRE.lineNoir}`, borderRadius: 10 },
};
