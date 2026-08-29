#!/usr/bin/env python3
"""
Build a GPX route for Xcode's Simulate Location that exercises the two-house
geofence path end to end, without driving.

    python3 scripts/make_fence_gpx.py LAT1 LNG1 LAT2 LNG2 [OUT.gpx]

The route, in order:

    far start  ->  INTO House 1  ->  dwell  ->  OUT  ->  INTO House 2
               ->  dwell  ->  OUT  ->  far away  ->  hold

WHY EACH LEG IS SHAPED THE WAY IT IS

  It starts OUTSIDE both fences. Beginning inside one means iOS already considers
  you within the region when monitoring starts, and it does not fire ENTER for a
  region you are already in — the arrival would never happen and the test would
  fail for a reason that has nothing to do with the bug.

  Each dwell is longer than FENCE_LOITERING_MS (2 min). We register
  notifyOnEntry:false / notifyOnDwell:true, so crossing the line records nothing;
  only staying inside does. A short pass-through proves nothing.

  Points are emitted roughly one per simulated second AND carry <time>. Xcode
  advances a GPX waypoint per second when timestamps are absent and interpolates
  from them when present, so both behaviours give the same wall-clock dwell.

  The final leg runs well past both houses and then HOLDS. The exit is the thing
  under test, and iOS can take minutes to deliver it — stopping the route the
  moment you cross the boundary is how you conclude "no EXIT" when the truth was
  "not yet".
"""
import sys, math, datetime

def usage_exit(msg):
    print(f"error: {msg}\n\n{__doc__}", file=sys.stderr)
    sys.exit(1)

if len(sys.argv) not in (5, 6):
    usage_exit("expected 4 coordinates")
try:
    lat1, lng1, lat2, lng2 = (float(a) for a in sys.argv[1:5])
except ValueError:
    usage_exit("coordinates must be numbers")
out = sys.argv[5] if len(sys.argv) == 6 else "B4C-two-house.gpx"

R = 6371000.0
def haversine(a_lat, a_lng, b_lat, b_lng):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lng - a_lng)
    h = math.sin(dp/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dl/2)**2
    return 2*R*math.asin(math.sqrt(h))

# Metres -> degrees, latitude-corrected so the "far" legs are truly far at this latitude.
def offset(lat, lng, north_m, east_m):
    dlat = north_m / 111320.0
    dlng = east_m / (111320.0 * math.cos(math.radians(lat)) or 1e-9)
    return lat + dlat, lng + dlng

sep = haversine(lat1, lng1, lat2, lng2)

pts = []            # (lat, lng)
def hold(lat, lng, seconds):
    pts.extend([(lat, lng)] * seconds)
def leg(a, b, seconds):
    (alat, alng), (blat, blng) = a, b
    for i in range(1, seconds + 1):
        f = i / seconds
        pts.append((alat + (blat-alat)*f, alng + (blng-alng)*f))

# Start 3 km south-west of House 1 — comfortably outside any 150 m fence, and
# outside the old default proximity radius so the approach is realistic.
start = offset(lat1, lng1, -2200, -2200)
# End 5 km beyond House 2, far enough that a proximity-based deactivation would
# certainly have happened under the old default.
end   = offset(lat2, lng2,  3600,  3600)

hold(*start, 20)                       # settle before anything moves
leg(start, (lat1, lng1), 120)          # approach House 1
hold(lat1, lng1, 210)                  # DWELL 1 — 3.5 min, past the 2 min loiter
leg((lat1, lng1), (lat2, lng2), 180)   # House 1 -> House 2 (crosses out of 1, into 2)
hold(lat2, lng2, 210)                  # DWELL 2
leg((lat2, lng2), end, 180)            # leave House 2 and keep going
hold(*end, 420)                        # HOLD 7 min — give iOS time to deliver EXIT

t0 = datetime.datetime(2026, 1, 1, 9, 0, 0, tzinfo=datetime.timezone.utc)
rows = []
for i, (la, ln) in enumerate(pts):
    ts = (t0 + datetime.timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows.append(f'  <wpt lat="{la:.7f}" lon="{ln:.7f}"><time>{ts}</time></wpt>')

with open(out, "w") as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    f.write('<gpx version="1.1" creator="B4C two-house fence test" '
            'xmlns="http://www.topografix.com/GPX/1/1">\n')
    f.write("\n".join(rows))
    f.write("\n</gpx>\n")

mins = len(pts) / 60.0
print(f"wrote {out}")
print(f"  waypoints           : {len(pts)}  (~{mins:.1f} min of simulated time)")
print(f"  House 1             : {lat1:.6f}, {lng1:.6f}")
print(f"  House 2             : {lat2:.6f}, {lng2:.6f}")
print(f"  distance apart      : {sep:,.0f} m")
print(f"  start (outside both): {start[0]:.6f}, {start[1]:.6f}")
print(f"  end   (far away)    : {end[0]:.6f}, {end[1]:.6f}")
print()
if sep < 1000:
    print(f"  NOTE: the houses are {sep:,.0f} m apart — under the SDK's ~1 km default")
    print("  proximity radius. Both fences would likely have stayed active even before")
    print("  the bump, which WEAKENS the proximity hypothesis. If the exit still fails")
    print("  here, look at the `registered` log line (notifyOnExit) instead.")
else:
    print(f"  The houses are {sep:,.0f} m apart, beyond the SDK's ~1 km default proximity")
    print("  radius — consistent with House 1 being deactivated mid-drive before the bump.")
