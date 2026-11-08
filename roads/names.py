#!/usr/bin/env python3
"""
Road names (format/names.md): every name a numbered road goes by in one state, from OpenStreetMap. build.sh runs it per state:
  osmium add-locations-to-ways <roads + route relations>.pbf -f opl -o - | python3 names.py <geofabrik state> <out dir>
and it writes <out dir>/<ST>.json.gz (gzip, mtime 0, so an unchanged state is byte-identical and publish copies it).

Why (owner, 2026-11-08): permits print numbers ("IH-635", "SL-8 NFR", "SH-161 WFR"); the map labels the same pavement by a local name
("Lyndon B Johnson Freeway", "North Sam Houston Parkway East", a frontage road called "North Service Road"). The app reads these files to
tie the two, only next to pavement that carries both (GRID squares).

  names:    UPPERCASE name -> ref -> grid squares where a way carries both (ways with ref + name / alt_name / official_name / old_name /
            loc_name; road relations' ref over their member ways' names; unsigned_ref, as "SR <n>").
  frontage: ref -> UPPERCASE names of non-freeway ways beside that ref's main lanes (~150 m, roughly parallel), named Frontage / Service
            Road, with a main-lane name, or carrying the ref themselves.
  unsigned: ref -> names, for refs that exist only as unsigned_ref.
"""
import sys, json, math, re, datetime, gzip, os
from collections import defaultdict

ABBR = {'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT',
  'delaware': 'DE', 'district-of-columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
  'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA',
  'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new-hampshire': 'NH', 'new-jersey': 'NJ', 'new-mexico': 'NM', 'new-york': 'NY', 'north-carolina': 'NC', 'north-dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode-island': 'RI', 'south-carolina': 'SC', 'south-dakota': 'SD',
  'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west-virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY'}
STATE = ABBR.get(sys.argv[1], sys.argv[1].upper()) if len(sys.argv) > 1 else '??'
OUT = sys.argv[2] if len(sys.argv) > 2 else None
FAST = re.compile(r'^(motorway|trunk)(_link)?$')
MAIN = re.compile(r'^(motorway|trunk)$')
FRONTAGE_WORDS = re.compile(r'\b(frontage|service\s+(road|rd))\b', re.I)
CELL = 0.0015  # ~150 m

def tags_of(field):
    out = {}
    if not field:
        return out
    for kv in field.split(','):
        if '=' not in kv:
            continue
        k, v = kv.split('=', 1)
        out[unesc(k)] = unesc(v)
    return out

def unesc(s):
    # OPL escapes: %XX% hex code points
    return re.sub(r'%([0-9a-fA-F]+)%', lambda m: chr(int(m.group(1), 16)), s)

def refs_of(t):
    return [r.strip() for r in (t.get('ref') or '').split(';') if r.strip()]

ways = {}          # id -> (tags, coords)
relations = []     # (tags, member way ids)
for line in sys.stdin:
    if not line or line[0] not in 'wr':
        continue
    parts = line.rstrip('\n').split(' ')
    kind, oid = line[0], int(parts[0][1:])
    fields = {p[0]: p[1:] for p in parts[1:] if p}
    t = tags_of(fields.get('T', ''))
    if kind == 'w':
        coords = []
        for nd in (fields.get('N') or '').split(','):
            m = re.search(r'x(-?[\d.]+)y(-?[\d.]+)', nd)
            if m:
                coords.append((float(m.group(1)), float(m.group(2))))
        ways[oid] = (t, coords)
    elif t.get('route') == 'road':
        members = [int(m[1:].split('@')[0]) for m in (fields.get('M') or '').split(',') if m.startswith('w')]
        relations.append((t, members))

# name -> ref -> set of half-degree cells where that name carries that ref. A name alone is not enough: "MAIN STREET" carries dozens of
# routes across a state, so the app only reads a label as a route inside the cells where the two go together.
names = defaultdict(lambda: defaultdict(set))
unsigned = defaultdict(set)
GRID = 100  # cells per degree (~1.1 km): a name means a route only next to pavement that carries both (two "Main Street"s a town apart differ)
def cells_of(coords):
    out = set()
    for i, (x, y) in enumerate(coords):
        out.add(f'{math.floor(y * GRID)}:{math.floor(x * GRID)}')
        if i:  # long rural segments: fill in between nodes
            px, py = coords[i - 1]
            n = int(max(abs(x - px), abs(y - py)) * GRID * 2)
            for k in range(1, n):
                out.add(f'{math.floor((py + (y - py) * k / n) * GRID)}:{math.floor((px + (x - px) * k / n) * GRID)}')
    return out
def add_name(n, ref, coords):
    n = (n or '').strip().upper()
    if re.fullmatch(r'\d+[A-Z]?', ref or ''):
        return  # a bare number would match every road with that number
    if n and ref and not re.fullmatch(r'[A-Z]{0,4}\s*\d+[A-Z]?', n):  # a name, not a bare number
        names[n][ref] |= cells_of(coords)

for t, coords in ways.values():
    rs = refs_of(t)
    for r in rs:
        for key in ('name', 'alt_name', 'official_name', 'old_name', 'loc_name'):
            for n in (t.get(key) or '').split(';'):
                add_name(n, r, coords)
    for u in (t.get('unsigned_ref') or '').split(';'):
        u = u.strip()
        if re.fullmatch(r'\d+[A-Z]?', u):
            u = f'SR {u}'  # state-maintained numbers kept off the signs (PA quadrant routes, NC secondary roads) print as "SR 1002"
        if u and re.fullmatch(r'[A-Z]+.*', u):
            for key in ('name', 'alt_name'):
                for n in (t.get(key) or '').split(';'):
                    add_name(n, u, coords)
                    if n.strip():
                        unsigned[u].add(n.strip().upper())

for t, members in relations:
    ref = (t.get('ref') or '').strip()
    net = t.get('network') or ''
    if not ref:
        continue
    # A relation's ref is bare in some networks ("8" in US:TX:Loop): give it its network's word.
    if re.fullmatch(r'\d+[A-Z]?', ref):
        last = net.split(':')[-1]
        word = {'Loop': 'Loop', 'Spur': 'Spur', 'FM': 'FM', 'RM': 'RM', 'Business': 'Business', 'Beltway': 'Loop', 'I': 'I', 'US': 'US'}.get(last)
        if not word and re.fullmatch(r'[A-Z]{2}', last) and net.startswith('US:'):
            word = last  # a state network: US:TX -> "TX 161"
        if not word:
            continue  # a bare number with no network word would match any road with that number
        ref = f'{word} {ref}'
    for wid in members:
        w = ways.get(wid)
        if w:
            for key in ('name', 'alt_name', 'official_name'):
                for n in (w[0].get(key) or '').split(';'):
                    add_name(n, ref, w[1])

# Frontage: non-freeway ways beside a ref's main lanes.
grid = defaultdict(list)  # cell -> [(ref, bearing)]
main_names = defaultdict(set)
def bearing(a, b):
    return math.degrees(math.atan2(b[1] - a[1], (b[0] - a[0]) * math.cos(math.radians(a[1])))) % 180
for t, coords in ways.values():
    if not MAIN.match(t.get('highway', '')):
        continue
    rs = refs_of(t)
    if not rs:
        continue
    for r in rs:
        if t.get('name'):
            main_names[r].add(t['name'].strip().upper())
    for i in range(1, len(coords)):
        a, b = coords[i - 1], coords[i]
        br = bearing(a, b)
        steps = max(1, int(max(abs(b[0] - a[0]), abs(b[1] - a[1])) / CELL))
        for s in range(steps + 1):
            x = a[0] + (b[0] - a[0]) * s / steps
            y = a[1] + (b[1] - a[1]) * s / steps
            for r in rs:
                grid[(int(y / CELL), int(x / CELL))].append((r, br))

frontage = defaultdict(lambda: defaultdict(set))  # ref -> name -> cells
for t, coords in ways.values():
    hw = t.get('highway', '')
    if FAST.match(hw) or not t.get('name') or len(coords) < 2:
        continue
    nm = t['name'].strip().upper()
    hits = defaultdict(int)
    beside = 0  # samples with any parallel main lane nearby
    samples = coords[::max(1, len(coords) // 8)]
    for i, (x, y) in enumerate(samples):
        nxt = samples[i + 1] if i + 1 < len(samples) else coords[-1]
        br = bearing((x, y), nxt) if nxt != (x, y) else None
        cy, cx = int(y / CELL), int(x / CELL)
        seen = set()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for r, mb in grid.get((cy + dy, cx + dx), ()):
                    if r in seen:
                        continue
                    if br is None or min(abs(br - mb), 180 - abs(br - mb)) < 30:
                        seen.add(r)
        for r in seen:
            hits[r] += 1
        beside += bool(seen)
    # A way that carries a ref itself and runs beside main lanes is that ref's frontage (TX 161's frontage roads sit beside the PGBT tollway).
    if beside >= max(2, len(samples) // 2):
        for r in refs_of(t):
            frontage[r][nm] |= cells_of(coords)
    for r, n in hits.items():
        if n >= max(2, len(samples) // 2) and (FRONTAGE_WORDS.search(nm) or nm in main_names[r] or any(m and m in nm for m in main_names[r])):
            frontage[r][nm] |= cells_of(coords)

def enc(cells):
    # Sorted grid squares as small steps: first "lat,lng", then "dlat,dlng", or just "dlng" on the same row. Halves the file.
    pts = sorted(tuple(map(int, c.split(':'))) for c in cells)
    out, prev = [], None
    for la, lo in pts:
        out.append(f'{la},{lo}' if prev is None else (f'{lo - prev[1]}' if la == prev[0] else f'{la - prev[0]},{lo - prev[1]}'))
        prev = (la, lo)
    return ' '.join(out)

out = {
    'state': STATE,
    'source': 'OpenStreetMap via Geofabrik; © OpenStreetMap contributors, ODbL 1.0',
    'grid': GRID,
    'names': {k: {r: enc(c) for r, c in sorted(v.items())} for k, v in sorted(names.items())},
    'frontage': {k: {n: enc(c) for n, c in sorted(v.items())} for k, v in sorted(frontage.items())},
    'unsigned': {k: sorted(v) for k, v in sorted(unsigned.items())},
}
body = json.dumps(out, separators=(',', ':'), ensure_ascii=False).encode()
if OUT:
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f'{STATE}.json.gz'), 'wb') as f:
        f.write(gzip.compress(body, 9, mtime=0))
else:
    sys.stdout.buffer.write(body)
print(f'{STATE}: {len(ways)} ways, {len(relations)} road relations -> {len(names)} names, {len(frontage)} routes with frontage names, {len(unsigned)} unsigned refs', file=sys.stderr)
