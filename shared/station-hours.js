/* STATION HOURS — the credited-hours rule, as plain JavaScript.

   LIFTED OUT OF src/App.jsx VERBATIM. Both functions are byte-for-byte what they were inside the
   component file, with `export` added; nothing about the derivation changed in the move. The reason
   for the move is that App.jsx is JSX, and node cannot import a .jsx file at all
   (ERR_UNKNOWN_FILE_EXTENSION) — so a named export from there would have been unreachable from a
   test, and the number this rule produces is the one that goes to a board and to ISO/LOSAP.

   Same shape as shared/maint-due.js, which came out of api/digest.js for the same reason.

   NO REACT, NO DOM, NO IMPORTS. Keep it that way: the moment this file needs a hook or a browser
   global it stops being testable in node, which is the whole point of it existing. */

/* THE station-hours bucketing rule — one definition, three readers.

   Lifted verbatim out of StationHoursReport so the Station Hours screen, the Chief's Report and the
   Meeting Agenda cannot drift apart. They already did once: api/digest.js kept its own copy, missed the
   auto_closed rule, and now credits hours the screen does not. That divergence is invisible until two
   documents quoting the same period disagree in front of a board.

   ORDER IS THE RULE. auto_closed is tested BEFORE verified, because a check-in can be properly
   geo-verified while its stop time was guessed by the sweeper — the duration is fiction, so the shift is
   recorded and never credited until an officer confirms the real out-time. Reversing these two lines
   would silently credit estimated hours to ISO/LOSAP.

   Sums are raw; rounding happens once at the display edge. Rounding per row would drift a column away
   from the total printed above it.

   Input rows are dept_station_shifts output, which already excludes incident, off-site and open shifts
   at the SQL layer — this function must not re-filter, or the two layers would each hold half a rule. */
export function rollupStationHours(shifts) {
  const byMember = {};
  for (const s of shifts || []) {
    // `id` is carried so PDF detail sections can join on member_id rather than a display name.
    const m = (byMember[s.member_id] ||= { id: s.member_id, name: s.member_name, standby: 0, training: 0, unverified: 0, vTrue: 0, oTrue: 0, n: 0, autoClosed: 0, checkins: 0, attestedHrs: 0, optionalHrs: 0 });
    // THREE STATES NOW, not two. `officer_attested` is a separate flag from `verified` on purpose:
    // an officer marking someone present is a human attestation, not a location proof, and the
    // ledger has to keep saying which one it was. Crediting them equally is a policy decision;
    // recording them identically would be a lie, and the whole audit story rests on the difference
    // staying visible. Never set verified=true on a derived row to make the arithmetic simpler.
    const attested = !!s.officer_attested;
    // Older RPC, before the migration lands, returns no such column -> undefined -> false -> these
    // rows stay in the uncredited bucket exactly as they do today. The client can ship first.
    const hrs = Number(s.hours) || 0;
    // auto_closed STILL FIRST and still uncredited, even for an attested row: the stop time was
    // guessed by the sweeper either way, and an attestation about attendance is not an attestation
    // about when someone left.
    if (s.auto_closed) { m.unverified += hrs; m.autoClosed += 1; }
    else if (!s.verified && !attested) m.unverified += hrs;      // neither proven nor attested
    else if (s.kind === "training") m.training += hrs;
    else m.standby += hrs;                                       // standby is the only other surfaced kind
    if (s.verified) m.vTrue += 1;
    if (attested && !s.verified) m.oTrue += 1;                   // counted once, in one state only
    m.n += 1;
    // VERIFIED % DENOMINATOR — a deliberate choice, and it stays "of CHECK-INS".
    // Attendance-derived rows involve no check-in at all, so counting them would silently
    // change what the metric measures: from "how often did people verify at the station when
    // they checked in" (a discipline number an officer can act on) to "what share of all
    // recorded time is creditable" (a different question). Including them would also make the
    // figure fall the moment attendance hours switch on, for reasons unrelated to check-in
    // behaviour. Derived rows are excluded from the denominator and the label says "of check-ins".
    // "check-ins" means someone actually checked in — a real punch, geo or otherwise. An officer
    // marking a roster is not a check-in, so attested rows stay out of this denominator and the
    // verified % keeps meaning "how often did people verify when they checked in".
    if (!attested) m.checkins += 1;
    if (attested) { m.attestedHrs += hrs; if (s.optional) m.optionalHrs += hrs; }
  }
  const rows = Object.values(byMember)
    .map((m) => ({ ...m, total: m.standby + m.training, vpct: m.checkins ? Math.round(100 * m.vTrue / m.checkins) : 0 }))
    .sort((x, y) => y.total - x.total);   // ranked by CREDITED hours — padding unverified time can't climb this list
  const standby    = rows.reduce((a, r) => a + r.standby, 0);
  const training   = rows.reduce((a, r) => a + r.training, 0);
  const unverified = rows.reduce((a, r) => a + r.unverified, 0);
  const n          = rows.reduce((a, r) => a + r.n, 0);
  const vTrue      = rows.reduce((a, r) => a + r.vTrue, 0);
  const autoClosed = rows.reduce((a, r) => a + r.autoClosed, 0);
  const checkins   = rows.reduce((a, r) => a + r.checkins, 0);
  const oTrue       = rows.reduce((a, r) => a + r.oTrue, 0);
  const attestedHrs = rows.reduce((a, r) => a + r.attestedHrs, 0);
  const optionalHrs   = rows.reduce((a, r) => a + r.optionalHrs, 0);
  return {
    rows,
    totals: { standby, training, credited: standby + training, unverified, shifts: n, members: rows.length,
              vTrue, oTrue, checkins, vpct: checkins ? Math.round(100 * vTrue / checkins) : 0,
              autoClosed, attestedHrs, optionalHrs },
  };
}

/* CREDITED HOURS, DE-OVERLAPPED. The one function every hours surface reads.

   THE BUG THIS FIXES. rollupStationHours adds `standby += hrs` and `training += hrs` and reports
   credited = standby + training. Those two buckets are not disjoint: a member on station standby when
   a drill starts is inside BOTH at once, so the drill's minutes were counted twice. Chase Thomas read
   standby 36.92 + training 1.5 = 38.42 credited for a month in which he was present 36.92 hours. That
   figure goes to a board and to ISO, and it overstated him by the length of every drill he was already
   at the station for.

   The de-overlap cannot be done here. It is interval logic — union each member's spans, credit a
   minute that is both training and standby to training once — and it already exists, correct, in
   dept_iso_hours, which does it with range_agg over tstzrange. Redoing it in JavaScript on totals that
   have already lost their timestamps is not possible, and redoing it on the raw rows would be a second
   implementation of the rule to drift. So: the split comes from SQL, and this function's whole job is
   to JOIN it to the things SQL does not return.

   WHAT COMES FROM WHERE, and it is a clean line:
     • standby / training / credited  <- dept_iso_hours, per member. Already de-overlapped, already
       clipped to the window, training already winning the tie. Never recomputed here.
     • unverified, auto-closed, verified %  <- rollupStationHours. dept_iso_hours filters
       `and sp.verified` and so cannot see uncredited time at all; the uncredited bucket only exists on
       the shift side, and the verified-% denominator is a count of CHECK-IN EVENTS, which is not an
       hours question.

   A UNION ON member_id, not a lookup from either side. Both directions really happen:
     • rollup-only — a member whose whole period was unverified or auto-closed has no ISO row. They
       must still appear, showing 0 credited and their uncredited hours, or the screen would silently
       drop the members an officer most needs to see.
     • ISO-only — the two RPCs window differently. dept_station_shifts filters on checked_in_at alone,
       so a shift that STARTED before the period is not in it; dept_iso_hours filters on overlap and
       clips, so the part inside the period IS. A member whose only presence straddled the period
       start therefore has ISO hours and no shift row.

   That second case is also why a merged row keeps `vpct: null` rather than 0. There were no check-in
   events inside the window to take a percentage OF, and printing "0%" would report perfect
   non-verification for a member who verified fine — a number that reads as a discipline problem and
   is really an empty denominator. Null renders as "—".

   ONE CONSEQUENCE, STATED. Credited is now clipped to the period and unverified is not: the uncredited
   bucket still counts a straddling shift whole, because it comes from the shift rows. Both are
   defensible and they answer slightly different questions; what matters is that the CREDITED figure —
   the only one that leaves the building — is the clipped, de-overlapped one.

   Shape is deliberately identical to rollupStationHours' return, so the table, the PDF, the Chief's
   Report and the Agenda all keep reading exactly the fields they read before. */
export function mergeStationHours(shifts, isoRows) {
  const { rows: shRows, totals: SH } = rollupStationHours(shifts);
  const num = (v) => Number(v) || 0;
  const byShift = new Map(shRows.map((r) => [r.id, r]));
  const byIso = new Map((isoRows || []).map((r) => [r.member_id, r]));
  const ids = new Set([...byShift.keys(), ...byIso.keys()]);
  const rows = [...ids].map((id) => {
    const s = byShift.get(id);
    const i = byIso.get(id);
    // The ISO-only shell: zeros for everything the shift side would have supplied, and a null vpct
    // rather than a fabricated 0% — see above.
    const base = s || { id, name: i?.member_name || "", unverified: 0, vTrue: 0, oTrue: 0, n: 0,
                        autoClosed: 0, checkins: 0, attestedHrs: 0, optionalHrs: 0, vpct: null };
    const training = num(i?.training_hours);
    const standby  = num(i?.standby_hours);
    return { ...base, name: base.name || i?.member_name || "", standby, training,
             total: num(i?.iso_total_hours) };
  }).sort((x, y) => y.total - x.total || (x.name || "").localeCompare(y.name || ""));
  // Department figures follow the same split, from the same sides, so the column foots to its own
  // footer. Summing the per-member ISO numbers is arithmetic, not interval logic: the RPC has already
  // de-overlapped each member, and members do not overlap each other.
  const standby  = rows.reduce((a, r) => a + r.standby, 0);
  const training = rows.reduce((a, r) => a + r.training, 0);
  const credited = rows.reduce((a, r) => a + r.total, 0);
  return {
    rows,
    totals: { ...SH, standby, training, credited, members: rows.length },
  };
}
