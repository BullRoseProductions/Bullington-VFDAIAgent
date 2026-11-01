// SWEEP FAKE — not the app's client. Realistic fixtures (long names, emails, serials) so content-driven overflow shows.
const D = "dddddddd-0000-0000-0000-000000000001";
const ME = "aaaaaaaa-0000-0000-0000-000000000001";
const now = new Date(); const iso = (d) => d.toISOString(); const day = (n) => iso(new Date(Date.now() + n * 864e5));
const ymd = (n) => day(n).slice(0, 10);
const names = ["Alexandria Montgomery-Whitfield", "Bartholomew Okonkwo", "Christopher Vanderlinden", "Dakota Rae Hollingsworth", "Evangeline Castellanos", "Frederick Nakamura", "Giovanni Abernathy", "Henrietta Pemberton-Lowe", "Isabella Kowalczyk", "Jonathan Featherstonehaugh", "Katherine Delacroix", "Leopold Montenegro"];
const members = names.map((n, i) => ({ id: i ? `aaaaaaaa-0000-0000-0000-0000000000${String(i + 1).padStart(2, "0")}` : ME, department_id: D, name: n, role: i === 0 ? "Chief" : "Firefighter / EMT-Basic", access: i === 0 ? ["Department Admin", "Project Admin"] : i < 3 ? ["Officer"] : ["Member"], status: i === 11 ? "Inactive" : i > 8 ? "Probationary" : "Active", phone: "(817) 555-01" + String(10 + i), email: `${n.toLowerCase().replace(/[^a-z]/g, ".")}.firefighter.volunteer@northcountyfiredepartment-example.org`, joined: "2019", participation: 80 - i * 5, mentor_id: null, created_at: day(-400), separated: false, password_set: true }));
const certs = members.flatMap((m, i) => [{ id: `c${i}a`, member_id: m.id, department_id: D, name: "Emergency Medical Technician — Basic (National Registry)", exp: ymd(30 * (i - 4)).slice(0, 7), proof_path: null, cert_type_id: null, no_expiry: false, achieved_on: null }, { id: `c${i}b`, member_id: m.id, department_id: D, name: "Firefighter I", exp: ymd(400).slice(0, 7), no_expiry: false }]);
const sessions = [-14, -7, -3, 0, 2, 5, 9].map((n, i) => { const d = new Date(Date.now() + n * 864e5); return { id: `s${i}`, department_id: D, title: ["Hose deployment and advancement — 1¾\" and 2½\" lines", "Vehicle extrication with hydraulic tools", "Ladder throws", "Pump operations", "Hazmat awareness refresher", "Business meeting", "Search & rescue"][i], y: d.getFullYear(), m: d.getMonth(), d: d.getDate(), session_date: ymd(n), start_time: "19:00:00", duration_min: 120, done: n < 0, plans: [], attendance: n < 0 ? [ME, members[1].id] : [], audience: "everyone", status: "scheduled", counts_attendance: true, is_meeting: i === 5, location_label: "Station 1 bay", created_at: day(-30) }; });
const notifications = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, member_id: i < 6 ? ME : members[2].id, department_id: D, type: ["cert_expired", "maint_overdue", "event_1h", "duty_due_today", "gear_due_tomorrow", "event_24h", "task_assigned", "shift_open"][i], title: ["Your Emergency Medical Technician — Basic (National Registry) certification expired", "Engine 1 annual pump test is overdue", "Training tonight: Hose deployment and advancement", "Duty due today: weekly SCBA bottle check", "Gear inspection due tomorrow", "Business meeting tomorrow", "New task assigned to you", "Shift open"][i], body: i % 2 ? "Station 1 · tap to open the details and see who else is on it" : `Reach ${members[3].email} or call (817) 555-0199 — reference https://northcountyfiredepartment-example.org/very/long/path/to/the/document/that/does/not/wrap.pdf`, severity: ["critical", "critical", "warning", "info", "warning", "info", "info", "info"][i], subject_ref: `x${i}`, read_at: i > 4 ? day(-1) : null, created_at: day(-i * 0.6), pushed_at: null }));
const equipment = Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, department_id: D, equipment_type_id: "t1", serial_number: "SN-SCBA-2019-00000045678912345", asset_number: "NCFD-ASSET-000123456", manufacturer: "Mine Safety Appliances", model: "G1 SCBA 4500 PSI 45-minute", size: "L", status: i < 3 ? "held" : "in_inventory", condition: "Serviceable", current_holder_id: i < 3 ? members[i].id : null, current_holder_name: i < 3 ? members[i].name : null, created_at: day(-100), equipment_type: { name: "Self-Contained Breathing Apparatus", category: "PPE" } }));
const apparatus = [{ id: "ap1", department_id: D, name: "Engine 1", unit_number: "E-101", type: "Type 1 Engine", status: "in_service", vin: "1FDUF5HT5JEB12345", year: 2018, make: "Pierce", model: "Enforcer" }, { id: "ap2", department_id: D, name: "Brush 25", unit_number: "BR-25", type: "Type 6 Brush Truck", status: "in_service" }];
const FIX = {
  departments: [{ id: D, name: "North County Volunteer Fire Department & Rescue Association", station: "Station 1", city: "Granbury, TX", primary_color: "#B11E2A", accent_color: "#1F4E79", font: "Condensed (bold)", tagline: null, voice: null, logo_url: null, disabled_modules: [], station_lat: 32.4, station_lng: -97.7, week_start_day: 0 }],
  members, members_view: members, member_private: [], certs, celebrations: members.map((m) => ({ member_id: m.id, joined_date: "2019-03-14" })),
  training_sessions: sessions, session_attendance: [], notifications, equipment, apparatus, equipment_type: [{ id: "t1", name: "Self-Contained Breathing Apparatus", category: "PPE" }],
  documents: [{ id: "doc1", department_id: D, name: "Standard Operating Guideline 101 — Structure Fire Response and Incident Command (rev. 2026).pdf", type: "SOG", storage_path: "x", created_at: day(-20), uploaded_by: members[0].name, series_id: "doc1" }],
  resources: [{ id: "r1", department_id: D, category: "Crisis", name: "988 Suicide & Crisis Lifeline", phone: "988", website: "https://988lifeline.org/very/long/path/that/keeps/going/and/going", email: "help.and.support.desk@988lifeline-example.org", is_crisis: true, sort_order: 1 }],
  duties: [{ id: "du1", department_id: D, title: "Weekly SCBA bottle pressure check and log entry", frequency: "weekly", assigned_to: members[1].id, created_at: day(-10) }],
  stations: [{ id: "st1", department_id: D, name: "Station 1 — Headquarters", lat: 32.4, lng: -97.7, radius_m: 120 }],
  donation_campaigns: [], funding_events: [], fundraisers: [], drill_plans: [], session_plans: [], ai_outputs: [], cert_types: [], action_items: [], station_presence: [], announcements: [],
};
const RPC = {
  my_member_id: ME, my_department_id: D, is_dept_admin: true, is_department_admin: true, is_project_admin: true, is_leader: true, is_leadership: true, is_canmanage: true, is_canmanage_ops: true, has_password: true,
  my_departments: [{ department_id: D, name: FIX.departments[0].name }], dept_cert_types: [], my_read_sign_queue: [], my_open_station_session: [], my_stations: FIX.stations,
  pa_department_radar: [{ department_id: D, department_name: FIX.departments[0].name, station: "Station 1", city: "Granbury, TX", admin_name: members[0].name, admin_email: members[0].email, health: "ok", last_activity: day(-1) }],
  dept_expirations: certs.slice(0, 10).map((c, i) => ({ item_id: c.id, member_id: c.member_id, member_name: members[i % 12].name, source: "cert", kind: "cert", label: c.name, cls: null, expires_on: ymd(30 * (i - 4)), bucket: i < 4 ? "expired" : "soon" })),
  dept_qualification_matrix: [], dept_probation_board: [], dept_read_sign_compliance: [], dept_on_station_now: [], dept_on_station_now_all: [], dept_open_shifts: [], dept_open_long_shifts: [], dept_shifts_needing_review: [],
};
function q(table) {
  const f = { single: false, maybe: false }; const b = {};
  for (const m of ["select", "eq", "neq", "in", "is", "order", "limit", "gte", "lte", "lt", "gt", "or", "not", "range", "filter", "match", "contains", "overlaps", "ilike", "like", "textSearch", "insert", "update", "delete", "upsert"]) b[m] = () => b;
  b.single = () => { f.single = true; return b; }; b.maybeSingle = () => { f.maybe = true; return b; };
  b.then = (res, rej) => { const rows = FIX[table] || []; return Promise.resolve(f.single || f.maybe ? { data: rows[0] || null, error: null } : { data: rows, error: null, count: rows.length }).then(res, rej); };
  return b;
}
const user = { id: "u1", email: members[0].email };
const session = { user, access_token: "sweep" };
export const supabase = {
  from: q,
  rpc: (n) => ({ then: (res, rej) => Promise.resolve({ data: n in RPC ? RPC[n] : null, error: n in RPC ? null : { message: "sweep: no fixture" } }).then(res, rej) }),
  auth: { getSession: async () => ({ data: { session } }), getUser: async () => ({ data: { user } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}), refreshSession: async () => ({ data: { session } }), updateUser: async () => ({ data: {}, error: null }) },
  storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: { message: "sweep" } }), getPublicUrl: () => ({ data: { publicUrl: "" } }), upload: async () => ({ error: null }), list: async () => ({ data: [], error: null }) }) },
  channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {},
};
export const APP_URL = location.origin, APP_ORIGIN = location.origin;
export const setOnSessionExpired = () => {}; export const writesInFlight = () => 0;
