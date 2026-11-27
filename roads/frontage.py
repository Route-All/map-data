#!/usr/bin/env python3
"""
Frontage roads: for each freeway (motorway or trunk carriageway with a ref), the non-freeway ways that run alongside it, whatever the map
names them. build.sh runs it per state on the state's highway ways:
  python3 frontage.py <geofabrik state> <out dir> <highways.pbf>
It reads the file twice (osmium add-locations-to-ways ... -f opl) and writes <out dir>/<ST>.json.gz (gzip, mtime 0, so an unchanged state is
byte-identical).

Why (owner, 2026-11-15): Texas permits print frontage rows ("IH-20 NFR", "US-287 WFR", "SL-340 EFR"), and the map names that pavement
anything: "Interstate 10 East", "North Loop 289", "West Interstate Drive", "FM 511", "Northwest Zac Lenz Parkway Frontage Road East", or
nothing at all (Dumas's US-287 west frontage south of Birch Ave). Guessing frontage from names in the router kept breaking other permits
(routing-100/ROUTER-FAULTS.md, w3-frontage .. w5-tx3). Geometry says it once, here.

  ways: one per frontage way:
    [way id, main refs ("I 10;US 90"), side, travel, with, highway, name, oneway, metres off, metres beside, stretch, ramps, coords]
    side      bearing (0-359) from the main lanes to the way: 0 = north of them. A printed "NFR" is the ways whose side is within 90 of 0.
    travel    bearing the way may be driven, start to end, when one-way (oneway=-1 already turned); null when two-way.
    with      'with' / 'against' the main carriageway beside it when both are one-way, else null.
    metres off    median distance from the main lanes; metres beside: the way's length that runs alongside them.
    stretch   [lat, lng, lat, lng]: where the way's first and last alongside points fall on the main lanes, in the way's own order.
    ramps     [[link way ids, 'on' | 'off' | 'both'], ...]: the motorway / trunk links leaving this way that reach the main lanes ('on': from the
              frontage onto the main lanes), the first id touching this way.
    coords    [lng, lat, lng, lat, ...] at 5 decimals, the road tiles' precision, so the app needs no tile read for them.

Thresholds (tuned on TX 769864f9, 83f18fb6, a3d27124, bb3f006b, c528e998, cce0eeff, dc0178eb, e9327b90; see demo()):
  NEAR_M     a sample counts when a main-lane segment lies within this, ...
  PARALLEL   ... running within this many degrees of the sample's own segment (either way);
  SHARE      and the way counts when this share of its length (and at least MIN_M) does.
"""
import sys, json, math, re, gzip, os, subprocess, statistics
from collections import defaultdict
from exits import ABBR, tags_of

NEAR_M = 110
PARALLEL = 25
SHARE = 0.6
MIN_M = 15
CELL = 0.002            # grid square, ~220 m north-south
SAMPLE_M = 40           # a long segment is judged every SAMPLE_M
MAIN = re.compile(r'^(motorway|trunk)$')
LINK = re.compile(r'^(motorway|trunk)_link$')
# What may be a frontage road: surface classes a truck drives. Not driveways or parking aisles.
CANDIDATE = re.compile(r'^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service)$')
FRONTAGE_NAME = re.compile(r'\b(frontage|service\s+r(oa)?d|access\s+r(oa)?d)\b', re.I)

def ways_of(lines, want):
    """(id, tags, node ids, [(lng, lat)]) for the way lines of an OPL stream with locations whose tags `want` accepts (judged before the nodes are read)."""
    for line in lines:
        if not line.startswith('w'):
            continue
        parts = line.rstrip('\n').split(' ')
        fields = {p[0]: p[1:] for p in parts[1:] if p}
        t = tags_of(fields.get('T'))
        if not want(t):
            continue
        nodes, coords = [], []
        for nd in (fields.get('N') or '').split(','):
            i, j = nd.find('x'), nd.find('y')
            if i > 0 and j > i:
                nodes.append(int(nd[1:i])); coords.append((float(nd[i + 1:j]), float(nd[j + 1:])))
        if len(coords) >= 2:
            yield int(parts[0][1:]), t, nodes, coords

def refs_of(t):
    return [r.strip() for r in (t.get('ref') or '').split(';') if r.strip()]

def one_way(t):
    o = t.get('oneway')
    if o == '-1':
        return -1
    if o in ('yes', '1', 'true') or (t.get('highway') in ('motorway', 'motorway_link') and o != 'no') or t.get('junction') == 'roundabout':
        return 1
    return 0

def xy(p, lat0):
    """(lng, lat) to metres east / north of 0, flat round lat0: fine at the 100 m this judges."""
    return (p[0] * 111_320 * math.cos(math.radians(lat0)), p[1] * 110_540)

def ang(dx, dy):
    return math.degrees(math.atan2(dx, dy)) % 360

def diff(a, b):
    return abs((a - b + 180) % 360 - 180)

class Mains:
    """The main lanes' segments in grid squares, their nodes (for ramps), and the links (ramps) by end node."""
    def __init__(self):
        self.grid = defaultdict(list)   # cell -> [(a, b, refs, travel or None)]
        self.nodes = set()
        self.node_keys = defaultdict(set)  # main-lane node -> refs keys of the carriageways through it
        self.link_end = defaultdict(list)  # node -> [link id]
        self.links = {}                 # link id -> (first node, last node, oneway)
        self.cells = set()

    def add(self, wid, t, nodes, coords):
        hw = t.get('highway', '')
        if LINK.match(hw):
            ow = one_way(t)
            self.links[wid] = (nodes[0], nodes[-1], ow)
            self.link_end[nodes[0]].append(wid); self.link_end[nodes[-1]].append(wid)
            return
        rs = refs_of(t)
        if not MAIN.match(hw) or not rs:
            return
        self.nodes.update(nodes)
        ow = one_way(t)
        key = (';'.join(rs), hw)
        for n in nodes:
            self.node_keys[n].add(key[0])
        for i in range(1, len(coords)):
            a, b = coords[i - 1], coords[i]
            if ow == -1:
                a, b = b, a
            seg = (a, b, key, ow != 0)
            steps = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / (CELL / 2)))
            for s in range(steps + 1):
                c = (int((a[1] + (b[1] - a[1]) * s / steps) // CELL), int((a[0] + (b[0] - a[0]) * s / steps) // CELL))
                if not self.grid[c] or self.grid[c][-1] is not seg:
                    self.grid[c].append(seg)
                self.cells.add(c)

    def near(self, p):
        cy, cx = int(p[1] // CELL), int(p[0] // CELL)
        seen = set()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for seg in self.grid.get((cy + dy, cx + dx), ()):
                    if id(seg) not in seen:
                        seen.add(id(seg)); yield seg

    def touches(self, coords):
        for x, y in coords:
            cy, cx = int(y // CELL), int(x // CELL)
            if any((cy + dy, cx + dx) in self.cells for dy in (-1, 0, 1) for dx in (-1, 0, 1)):
                return True
        return False

def judge(mains, t, nodes, coords):
    """The frontage entry for one candidate way, or None."""
    hw = t.get('highway', '')
    # A service way only when named as frontage: TX had 26,349 service ways beside freeways (median 60 m: lot aisles, station access), 212 named.
    if not CANDIDATE.match(hw) or (hw == 'service' and not FRONTAGE_NAME.search(t.get('name') or '')) or t.get('area') == 'yes':
        return None
    if not mains.touches(coords):
        return None
    own = set(refs_of(t))
    lat0 = coords[0][1]
    total = 0.0
    by = defaultdict(float)           # main refs -> metres alongside
    off, travel_v, side_v, dists, along = defaultdict(lambda: [0.0, 0.0]), [0.0, 0.0], defaultdict(lambda: [0.0, 0.0]), defaultdict(list), defaultdict(list)
    main_travel = defaultdict(lambda: [0.0, 0.0])
    near_by = defaultdict(float)      # main refs -> metres alongside, every carriageway within NEAR_M (not only the nearest)
    for i in range(1, len(coords)):
        a, b = coords[i - 1], coords[i]
        ax, ay = xy(a, lat0); bx, by_ = xy(b, lat0)
        seg_len = math.hypot(bx - ax, by_ - ay)
        if seg_len == 0:
            continue
        total += seg_len
        br = ang(bx - ax, by_ - ay)
        travel_v[0] += (bx - ax); travel_v[1] += (by_ - ay)
        n = max(1, int(seg_len // SAMPLE_M))
        for k in range(n):
            f = (k + 0.5) / n
            p = (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
            px, py = xy(p, lat0)
            best, near_keys = None, set()
            for seg in mains.near(p):
                (s0, s1, key, oneway) = seg
                if hw == 'trunk' and (key[1] != 'motorway' or own & set(key[0].split(';'))):
                    continue  # a trunk carriageway is frontage only of another number's motorway (US-183 beside the SH-130 toll lanes)
                sx, sy = xy(s0, lat0); ex, ey = xy(s1, lat0)
                dx, dy = ex - sx, ey - sy
                L = dx * dx + dy * dy
                if not L:
                    continue
                mb = ang(dx, dy)
                if min(diff(br, mb), diff(br, (mb + 180) % 360)) > PARALLEL:
                    continue
                u = max(0.0, min(1.0, ((px - sx) * dx + (py - sy) * dy) / L))
                qx, qy = sx + u * dx, sy + u * dy
                d = math.hypot(px - qx, py - qy)
                if d <= NEAR_M:
                    near_keys.add(key[0])
                if d <= NEAR_M and (best is None or d < best[0]):
                    best = (d, key, px - qx, py - qy, mb if oneway else None, (s0[0] + (s1[0] - s0[0]) * u, s0[1] + (s1[1] - s0[1]) * u))
            if best is None:
                continue
            d, key, ox, oy, mtravel, q = best
            w = seg_len / n
            for k2 in near_keys:
                near_by[k2] += w
            by[key[0]] += w
            dists[key[0]].append(d)
            if d > 1:
                off[key[0]][0] += ox / d * w; off[key[0]][1] += oy / d * w
            if mtravel is not None:
                main_travel[key[0]][0] += math.sin(math.radians(mtravel)) * w; main_travel[key[0]][1] += math.cos(math.radians(mtravel)) * w
            along[key[0]].append(q)
    if not by:
        return None
    refs, beside = max(by.items(), key=lambda kv: kv[1])
    if beside < MIN_M or beside < SHARE * total:
        return None
    ow = one_way(t)
    travel = None
    if ow:
        tv = travel_v if ow == 1 else [-travel_v[0], -travel_v[1]]
        travel = round(ang(*tv)) % 360
    mt = main_travel[refs]
    with_ = None
    if travel is not None and (mt[0] or mt[1]):
        with_ = 'with' if diff(travel, ang(*mt)) < 90 else 'against'
    ox, oy = off[refs]
    side = round(ang(ox, oy)) % 360 if (ox or oy) else None
    q = along[refs]
    ramps = []
    nodeset = set(nodes)
    for n0 in nodes:
        for lid in mains.link_end.get(n0, ()):
            chain = reach_main(mains, lid, nodeset)
            if chain:
                first, last, low = mains.links[lid]
                kind = 'both' if low == 0 else ('on' if (first == n0) == (low == 1) else 'off')
                ramps.append([chain, kind])
    # Beside two parallel freeways (Houston's BW 8 free lanes and the SHT toll lanes 30 m apart), the way is filed under the nearer one only,
    # and a row printing the other found a hole in its frontage (TX 9b04f47c / c929d5a5: way 143346235 under SHT, its ramp onto BW 8, the
    # SL-8 SFR row ending short of IH-45). The other is listed too where the way connects to it: by its own ref, or a ramp onto its main lanes.
    reached = {k for chain, _ in ramps for end in mains.links[chain[-1]][:2] for k in mains.node_keys.get(end, ())}
    others = [k for k in near_by if k != refs and near_by[k] >= MIN_M and (own & set(k.split(';')) or k in reached)]
    return [';'.join([refs] + sorted(others)), side, travel, with_, hw, t.get('name') or '', t.get('oneway') or '', round(statistics.median(dists[refs])), round(beside),
            [round(q[0][1], 5), round(q[0][0], 5), round(q[-1][1], 5), round(q[-1][0], 5)], ramps,
            [round(v, 5) for c in coords for v in c]]

def reach_main(mains, lid, avoid, depth=5):
    """The link ids from link `lid` to the first main-lane node, through links only (breadth first), or None."""
    prev = {lid: None}
    queue = [lid]
    for _ in range(depth):
        nxt = []
        for l in queue:
            a, b, _ow = mains.links[l]
            for end in (a, b):
                if end in mains.nodes:
                    out = []
                    while l is not None:
                        out.append(l); l = prev[l]
                    return out[::-1]
                if end in avoid and l != lid:
                    continue
                for m in mains.link_end.get(end, ()):
                    if m not in prev:
                        prev[m] = l; nxt.append(m)
        queue = nxt
    return None

def build(read):
    """read() -> a fresh OPL line iterator (with locations), twice: main lanes and ramps first, then every candidate way."""
    mains = Mains()
    for wid, t, nodes, coords in ways_of(read(), lambda t: bool(MAIN.match(t.get('highway', '')) or LINK.match(t.get('highway', '')))):
        mains.add(wid, t, nodes, coords)
    out = []
    for wid, t, nodes, coords in ways_of(read(), lambda t: bool(CANDIDATE.match(t.get('highway', '')))):
        e = judge(mains, t, nodes, coords)
        if e:
            out.append([wid] + e)
    out.sort(key=lambda e: e[0])
    return out

def demo():
    # Two one-way main carriageways of "I 20" running east-west 60 m apart (way 1 east, way 2 west), a one-way frontage 50 m north
    # of the westbound lanes running west (way 3), a two-way street 400 m north (way 4, too far), a cross street (way 5, not parallel),
    # an unnamed frontage piece (way 6), and an on-ramp (way 7) from the frontage's west end onto the westbound lanes.
    dlat = lambda m: m / 110_540
    y0, y1, y2, y3 = 32.0, 32.0 + dlat(60), 32.0 + dlat(110), 32.0 + dlat(400)
    opl = [
        f'w1 v1 Thighway=motorway,ref=I%20%20 Nn1x-95.00y{y0},n2x-94.99y{y0}',
        f'w2 v1 Thighway=motorway,ref=I%20%20 Nn3x-94.99y{y1},n4x-95.00y{y1}',
        f'w3 v1 Thighway=primary,name=Interstate%20%20%20%East,oneway=yes Nn5x-94.991y{y2},n6x-94.998y{y2}',
        f'w4 v1 Thighway=residential,name=Elm%20%St Nn7x-94.991y{y3},n8x-94.998y{y3}',
        f'w5 v1 Thighway=residential,name=Cross%20%St Nn9x-94.995y{y2},n10x-94.995y{y3}',
        f'w6 v1 Thighway=residential,oneway=-1 Nn11x-94.9985y{y2},n12x-94.9981y{y2}',
        f'w7 v1 Thighway=motorway_link Nn6x-94.998y{y2},n4x-95.00y{y1}',
    ]
    e = {x[0]: x for x in build(lambda: iter(opl))}
    assert set(e) == {3, 6}, sorted(e)
    w3 = e[3]
    assert w3[1] == 'I 20' and abs(w3[2] - 0) <= 1 and abs(w3[3] - 270) <= 1 and w3[4] == 'with', w3[:5]
    assert 45 <= w3[8] <= 55, w3[8]
    assert w3[11] == [[[7], 'on']], w3[11]
    assert e[6][3] is not None and abs(e[6][3] - 270) <= 1 and e[6][4] == 'with', e[6][:5]  # oneway=-1 drawn east, driven west
    # Two parallel freeways: toll lanes "SHT" (way 8, westbound) 25 m from the frontage, the free lanes "BW 8" (way 2) 50 m off. The frontage
    # (way 3) has a ramp onto BW 8 (way 7) and is filed under both; the unnamed piece (way 6) has none and stays under the nearer, SHT alone.
    opl2 = [x.replace('I%20%20', 'BW%20%8') for x in opl] + [f'w8 v1 Thighway=motorway,ref=SHT Nn13x-94.99y{32.0 + dlat(85)},n14x-95.00y{32.0 + dlat(85)}']
    e2 = {x[0]: x for x in build(lambda: iter(opl2))}
    assert e2[3][1] == 'SHT;BW 8' and e2[6][1] == 'SHT', (e2[3][1], e2[6][1])
    print('frontage.py demo ok')

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'demo':
        demo(); sys.exit(0)
    STATE = ABBR.get(sys.argv[1], sys.argv[1].upper())
    OUT, PBF = sys.argv[2], sys.argv[3]
    def read():
        # FRONTAGE_OSMIUM_INDEX (e.g. sparse_file_array,/tmp/idx): osmium's node locations on disk, for a machine short of memory.
        idx = ['-i', os.environ['FRONTAGE_OSMIUM_INDEX']] if os.environ.get('FRONTAGE_OSMIUM_INDEX') else []
        p = subprocess.Popen(['osmium', 'add-locations-to-ways', *idx, PBF, '-f', 'opl', '-o', '-'], stdout=subprocess.PIPE, text=True, bufsize=1 << 20)
        yield from p.stdout
        if p.wait():
            raise SystemExit(f'osmium failed on {PBF}')
    ways = build(read)
    body = json.dumps({'state': STATE, 'source': 'OpenStreetMap via Geofabrik; © OpenStreetMap contributors, ODbL 1.0',
                       'params': {'nearM': NEAR_M, 'parallel': PARALLEL, 'share': SHARE, 'minM': MIN_M}, 'ways': ways},
                      separators=(',', ':'), ensure_ascii=False).encode()
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f'{STATE}.json.gz'), 'wb') as f:
        f.write(gzip.compress(body, 9, mtime=0))
    print(f'{STATE}: {len(ways)} frontage ways, {len({r for w in ways for r in w[1].split(";")})} refs, '
          f'{sum(1 for w in ways if w[11])} with a ramp, {len(body) // 1024} KB', file=sys.stderr)
