"""Builds sql/training_slice7_cancel_DRAFT.sql (+ docs/review/training_slice7_db_READER_DIFFS.patch) from the LIVE function
bodies in docs/review/training_slice7_db_LIVEDEFS.json — so every repointed reader is the verbatim live body plus ONE
inserted block, and the migration's post-condition can prove exactly that: md5(body with the insert removed) = live md5.

    python3 docs/review/training_slice7_db_build.py
"""
import json, difflib, os
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
L = json.load(open(os.path.join(ROOT, "docs/review/training_slice7_db_LIVEDEFS.json")))
D = L["defs"]

def key(prefix):
    ks = [k for k in D if k.startswith(prefix + "(")]
    assert len(ks) == 1, (prefix, ks)
    return ks[0]

# (function, regprocedure signature, anchor that must occur exactly once, the block inserted right AFTER it)
REPOINT = [
  ("open_signin", "public.open_signin(uuid)",
   "  if v_session.done then\n    raise exception 'This session is complete — you cannot open a sign-in.';\n  end if;\n",
   "  -- B4C:slice7 — a cancelled session takes no sign-in.\n  if v_session.status = 'cancelled' then\n    raise exception 'CANCELLED: this session was cancelled — it can''t take a sign-in.';\n  end if;\n"),
  ("current_signin_token", "public.current_signin_token(uuid)",
   "  -- ---- end copied gate ----\n",
   "  -- B4C:slice7 — a cancelled session has no live code (not an error: the page asks for every session it shows).\n  if v_session.status = 'cancelled' then\n    return null;\n  end if;\n"),
  ("member_check_in", "public.member_check_in(uuid,text,double precision,double precision,double precision)",
   "  IF v_session.done THEN\n    RAISE EXCEPTION 'This session is complete — attendance is locked.';\n  END IF;\n",
   "  -- B4C:slice7 — nobody checks in to a cancelled session.\n  IF v_session.status = 'cancelled' THEN\n    RAISE EXCEPTION 'CANCELLED: this session was cancelled — there is nothing to check in to.';\n  END IF;\n"),
  ("set_session_location", "public.set_session_location(uuid,double precision,double precision,integer,text)",
   "  if v_session.done then\n    raise exception 'This session is complete — its location can no longer be changed.';\n  end if;\n",
   "  -- B4C:slice7 — a cancelled session's location is frozen with it.\n  if v_session.status = 'cancelled' then\n    raise exception 'CANCELLED: this session was cancelled — restore it before changing its location.';\n  end if;\n"),
  ("set_my_session_registration", "public.set_my_session_registration(uuid,text)",
   "  if coalesce(v_sess.done, false) then\n    raise exception 'This session is closed';\n  end if;\n",
   "  -- B4C:slice7 — no RSVPs to a cancelled session (existing ones are kept, unchanged).\n  if exists (select 1 from public.training_sessions where id = p_session_id and status = 'cancelled') then\n    raise exception 'CANCELLED: this session was cancelled';\n  end if;\n"),
  ("finalize_training_session", "public.finalize_training_session(uuid,integer)",
   "      if s.done then raise exception 'ALREADY_FINALIZED: this session is already finalized.'; end if;\n",
   "      -- B4C:slice7 — a cancelled drill didn't happen: nothing to finalize.\n      if s.status = 'cancelled' then raise exception 'CANCELLED: this session was cancelled — restore it before finalizing.'; end if;\n"),
  ("correct_training_session", "public.correct_training_session(uuid,jsonb,uuid[],uuid[],text)",
   "      if not found then raise exception 'NOT_FOUND: that session is not in your department.' using errcode = 'P0002'; end if;\n",
   "      -- B4C:slice7 — a cancelled session is restored (two-person), not corrected.\n      if s.status = 'cancelled' then raise exception 'CANCELLED: this session was cancelled — restore it before correcting it.'; end if;\n"),
  ("attach_drill_plan_to_session", "public.attach_drill_plan_to_session(uuid,uuid)",
   "    if not exists (select 1 from public.training_sessions where id = p_session_id and department_id = v_dept) then\n      raise exception 'That session is not in your department.';\n    end if;\n",
   "    -- B4C:slice7 — no plans onto a cancelled session (R7).\n    if exists (select 1 from public.training_sessions where id = p_session_id and status = 'cancelled') then\n      raise exception 'CANCELLED: that session was cancelled — restore it before attaching a plan.';\n    end if;\n"),
  ("my_department_rollup", "public.my_department_rollup()",
   "           where ts.department_id = d.id and ts.date >= current_date",
   " and coalesce(ts.status, 'scheduled') <> 'cancelled'"),
]

PIN_READERS_UNCHANGED = {   # read-only hours readers + gates/identity + membership-window + close-on-done: must be byte-identical after
  **{"public." + k.split("(")[0] + "(" + ",".join(a.split(" ", 1)[1] for a in k[k.index("(") + 1:-1].split(", ") if a) + ")": v
     for k, v in L["md5_only"].items()},
}
# regprocedure text forms for md5_only keys (types as pg prints them) — normalise "timestamp with time zone" -> timestamptz
def norm_sig(s): return s.replace("timestamp with time zone", "timestamptz").replace("double precision", "double precision")
PIN_READERS_UNCHANGED = {norm_sig(k): v for k, v in PIN_READERS_UNCHANGED.items()}
SLICE6_UNCHANGED = {
  "public.reopen_training_session(uuid,text)": D[key("reopen_training_session")]["md5"],
  "public.drill_window_presence(uuid)": D[key("drill_window_presence")]["md5"],
  "public.recompute_training_plan_last_iso(uuid)": D[key("recompute_training_plan_last_iso")]["md5"],
  "public.tg_training_session_audit_append_only()": D[key("tg_training_session_audit_append_only")]["md5"],
}
GUARD_SIG, GUARD_MD5 = "public.tg_training_session_lock_guard()", D[key("tg_training_session_lock_guard")]["md5"]
DROP = {"public.swap_week_dates(uuid,uuid)": D[key("swap_week_dates")]["md5"], "public.move_week(uuid,text)": D[key("move_week")]["md5"]}

new_defs, diffs, repoint_sql, post_sql, pins_repoint = {}, [], [], [], []
for i, (name, sig, anchor, ins) in enumerate(REPOINT, 1):
    k = key(name); live = D[k]["def"]
    assert live.count(anchor) == 1, (name, live.count(anchor))
    new = live.replace(anchor, anchor + ins)
    assert new.count(ins) == 1
    new_defs[name] = new
    diffs += difflib.unified_diff(live.splitlines(True), new.splitlines(True), f"live/{name}", f"slice7/{name}")
    tag = f"r{i}"
    assert f"${tag}$" not in new
    repoint_sql.append(f"  -- {name}: the live body + the B4C:slice7 block (see docs/review/training_slice7_db_READER_DIFFS.patch)\n"
                       f"  EXECUTE ${tag}${new}${tag}$;\n")
    pins_repoint.append((sig, D[k]["md5"], ins, tag))

def jsonb_pairs(d): return ",\n    ".join(f"'{k}', '{v}'" for k, v in d.items())

ins_lits = "\n".join(f"  v_ins_{t} constant text := $i{t}${ins}$i{t}$;" for (_, _, ins, t) in pins_repoint)
repoint_pin_checks = "\n".join(
    f"  IF md5(pg_get_functiondef(to_regprocedure('{sig}'))) <> '{md5}' THEN RAISE EXCEPTION 'PREFLIGHT: {sig} has drifted (live md5 %, pinned {md5}). Re-audit.', md5(pg_get_functiondef(to_regprocedure('{sig}'))); END IF;"
    for (sig, md5, _, _) in pins_repoint)
repoint_post_checks = "\n".join(
    f"  IF position(v_ins_{t} in pg_get_functiondef(to_regprocedure('{sig}'))) = 0\n"
    f"     OR md5(replace(pg_get_functiondef(to_regprocedure('{sig}')), v_ins_{t}, '')) <> '{md5}' THEN\n"
    f"    RAISE EXCEPTION 'POST: {sig} is not exactly the live body + its slice7 block.';\n  END IF;"
    for (sig, md5, _, t) in pins_repoint)

TEMPLATE = open(os.path.join(ROOT, "docs/review/training_slice7_db_template.sql")).read()
out = (TEMPLATE
       .replace("/*@PIN_UNCHANGED@*/", jsonb_pairs({**PIN_READERS_UNCHANGED, **SLICE6_UNCHANGED}))
       .replace("/*@PIN_DROP@*/", jsonb_pairs(DROP))
       .replace("/*@GUARD_SIG@*/", GUARD_SIG).replace("/*@GUARD_MD5@*/", GUARD_MD5)
       .replace("/*@INSERT_LITERALS@*/", ins_lits)
       .replace("/*@REPOINT_PIN_CHECKS@*/", repoint_pin_checks)
       .replace("/*@REPOINT@*/", "\n".join(repoint_sql))
       .replace("/*@REPOINT_POST_CHECKS@*/", repoint_post_checks))
assert "/*@" not in out, "unfilled placeholder"
open(os.path.join(ROOT, "sql/training_slice7_cancel_DRAFT.sql"), "w").write(out)
open(os.path.join(ROOT, "docs/review/training_slice7_db_READER_DIFFS.patch"), "w").write("".join(diffs))
print("ok", len(out), "chars;", len(pins_repoint), "repointed")
