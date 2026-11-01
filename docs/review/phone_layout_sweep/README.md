# Phone-layout sweep (dev harness — not shipped, never touches a real backend)

Serves the REAL app from this checkout with `supabaseClient` / `apiBase` aliased to fakes (`fakeSupabase.js`: a DA/PA
identity and realistic fixtures — long names, emails, serials, URLs) so every screen renders without signing in, then
measures real Chrome layout at exact phone widths in iframes.

    SWEEP_ROOT=$(pwd) node node_modules/vite/bin/vite.js --config docs/review/phone_layout_sweep/vite.sweep.config.mjs
    # open http://127.0.0.1:5320/__sweep, then in its console:
    await sweep()                                   // 28 screens × 360/375/390/430
    await sweep(undefined, [360], { forced: true }) // + the touch-screen 16px input rule desktop Chrome won't apply

Reading the result: see the comment at the top of `sweep.html`. Limits: screens whose RPCs have no fixture render
their empty / error state, so data-driven width (a long real table) is only covered where a fixture exists; iOS-only
behaviour (focus zoom) is not layout and can't be seen here — that is what the forced run approximates.
