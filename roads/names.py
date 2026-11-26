#!/usr/bin/env python3
"""
Road names (format/names.md): every name a numbered road goes by in one state, from OpenStreetMap. build.sh runs it per state:
  osmium add-locations-to-ways <roads + route relations>.pbf -f opl -o - | python3 names.py <geofabrik state> <out dir>
and it writes <out dir>/<ST>.json.gz (gzip, mtime 0, so an unchanged state is byte-identical and publish copies it).

Why (owner, 2026-11-08): permits print numbers ("IH-635", "SL-8 NFR", "SH-161 WFR"); the map labels the same pavement by a local name
("Lyndon B Johnson Freeway", "North Sam Houston Parkway East", a frontage road called "North Service Road"). The app reads these files to
tie the two, only next to pavement that carries both (GRID squares).

  names:    UPPERCASE name -> ref -> grid squares where a way carries both (ways with ref + any NAME_KEYS tag; road relations' ref over
            their member ways' names AND the relation's own names, e.g. "Pennsylvania Turnpike" / "Bob Bullock Loop", over every member
            way; unsigned_ref, as "SR <n>").
  frontage: ref -> UPPERCASE names of non-freeway ways beside that ref's main lanes (~150 m, roughly parallel), named Frontage / Service
            Road, with a main-lane name, or carrying the ref themselves.
  unsigned: ref -> names, for refs that exist only as unsigned_ref.
  aliases:  printed ref -> map ref -> grid squares where pavement carrying the map ref is also the printed one: a way's or route relation's
            old_ref / fut_ref / official_ref / unsigned_ref (NC's Clayton Bypass is "I 42" with old_ref "US 70", and permits still print
            US-70; I-69 at Cleveland, TX is "US 59" with fut_ref "I 69"), and a route relation's ref over member ways whose own ref lacks it
            (a concurrency mapped only on the relation, named or not).
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
# Not read as frontage (map-gaps, 2026-11-14, AWS against the same OSM): frontage_road=yes alone (20,271 TX ways: 7 of 84 permits worse,
# map-gaps-app-1114171546-2), nor an "Access Road" in another name tag (Amarillo's East Interstate Drive, name_1 "Interstate Highway 40 Access
# Road": it fixed TX e9327b90's IH-40 SFR/NFR rows but 2 of 84 got worse, map-gaps-app-1114172722-4: Fort Worth / Mansfield for 9c37e1c8).
CELL = 0.0015  # ~150 m
# Every tag a road's name is kept in. v1 read the first five; the rest (TIGER's name_1 / name_2, reg_name, short_name, name:en ...) and a
# relation's own names are v2, and from those a name that only restates a designation ("STATE ROUTE 103", "NH RT 140", "I 95 (MA)") is left
# out: the app parses those itself, and TIGER's name_1 often names ANOTHER route on the same pavement.
V1_KEYS = ('name', 'alt_name', 'official_name', 'old_name', 'loc_name')
NAME_KEYS = V1_KEYS + ('reg_name', 'nat_name', 'short_name', 'int_name', 'name:en', 'name_1', 'name_2')
_ST = '|'.join(sorted({k.replace('-', ' ').upper() for k in ABBR} | set(ABBR.values()), key=len, reverse=True))
_DIR = r'NORTH|SOUTH|EAST|WEST|NORTHBOUND|SOUTHBOUND|EASTBOUND|WESTBOUND|[NSEW]B?'
# A designation starts with a network's word (the app's national audit uses the same words) and has a number in it ...
# (Fable review, PR #23: a single-digit route ("I-5 (BUS)", "AR-5") and "U.S. ROUTE 9" passed; the number is a lookahead and U.S. sits outside \b.)
_DESIG = re.compile(rf'(?=.*\d)(?:(?:{_DIR}|OLD) )?(?:(?:{_ST}) )?(?:(?:{_ST})[ -]?\d|I[ -]?\d|U\.\s?S\.|S\.\s?R\.|(?:INTERSTATE|IH|US|UNITED STATES|STATE|COUNTY|CNTY|PARISH'
                    rf'|HIGHWAY|HWY|ROUTE|RTE|RT|FM|RM|FARM|RANCH|URBAN|LOOP|SPUR|BUSINESS|FOREST|NATIONAL FOREST|TOWNSHIP|TWP|BIA|BUREAU|INDIAN'
                    rf'|PARK ROAD|TRUNK|CR|SR|SH|STH|CTH|FR|FSR|NF|CO RD|ST RT|M|K)\b)')
# A lettered route is a designation too ("COUNTY ROAD HH", "COUNTY TRUNK HIGHWAY K", "CTH F", "ROUTE AA"): TIGER's name_1 naming ANOTHER lettered route
# on the same pavement was tied to the way's ref (WI "COUNTY ROAD F" -> WI 21, ~636 such pairs). Fable review, PR #23.
_LETTERED = re.compile(r'(?:(?:COUNTY|CNTY|CO|STATE|TOWNSHIP) (?:TRUNK )?(?:ROAD|RD|HIGHWAY|HWY|ROUTE|RTE)|CTH|STH|ROUTE|RTE|HIGHWAY|HWY) [A-Z]{1,3}$')
# ... and any parenthetical only says where / which one ("(MA)", "(B - PECOS, TX)", "(CLOCKWISE)"). "LOOP 1 (MOPAC)" names the road: kept.
_WHERE = re.compile(rf'(?:{_DIR})|[A-Z] - .*|(?:.*, )?(?:{_ST})|.*\b(?:CLOCKWISE|COUNTERCLOCKWISE|FORMER|OLD|BUS|BUSINESS|TRUCK|ALT|SCENIC)\b.*')
def is_designation(n):
    return bool(_LETTERED.fullmatch(n.strip())) or (bool(_DESIG.match(n)) and all(_WHERE.fullmatch(p.strip()) for p in re.findall(r'\(([^)]*)\)?', n)))

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

# Other numbers the same pavement is printed as: renumbered (old_ref), being renumbered (fut_ref), the DOT's own (official_ref), unsigned.
# Only a value shaped like one ref: OSM also keeps histories there ("FM 157 (old Loop 496 (old US 287))", "US-12, US-191"), which no permit prints.
# A state DOT's own number for a road, on no sign, which its permits print: New York's reference routes ("NY-953B" on Strunk Road, Jamestown:
# NY 3389b254; OSM nysdot_ref "953B"), PennDOT's quadrant routes ("SR-4017" on Snyder Road, Lancaster County: PA 72dacb4a; OSM ref:penndot
# "SR4017" / "SR 0230", on ~53,000 ways). Read as "NY 953B" / "SR 4017" (no leading zero), and like unsigned_ref otherwise.
STATE_DOT_REF = {'nysdot_ref': 'NY', 'ref:penndot': 'SR'}
OTHER_REF_KEYS = ('old_ref', 'fut_ref', 'official_ref', 'unsigned_ref') + tuple(STATE_DOT_REF)
UNSIGNED_KEYS = ('unsigned_ref',) + tuple(STATE_DOT_REF)
ONE_REF = re.compile(r'[A-Za-z]{1,6}[ -]?\d+[A-Za-z]?(?: (?:Business|Bus|Bypass|Byp|Alternate|Alt|Truck|Spur|Loop|Connector|Toll))?')
# ... and only a network the app reads as one (app services/permitRoute.ts roadClassKey): it reads any other word as a state route, so
# "Exit 1A", "Old 50", "Road 17", "NASA 1" and AR's "Hwy 14" (an old state number, beside today's AR 14) would be state routes. Fable review, PR #24.
NETWORKS = set(ABBR.values()) | {'I', 'IH', 'US', 'SR', 'SH', 'STH', 'K', 'M', 'N', 'CR', 'CO', 'CH', 'CTH', 'CNTY', 'CSAH', 'FM', 'RM', 'PR',
                                 'LOOP', 'SPUR', 'BUSINESS', 'BUS', 'BL', 'BS', 'BI', 'BU', 'SL', 'SS'}
canon = lambda r: re.sub(r'^([A-Za-z]+)[ -]*(?=\d)', r'\1 ', r)  # "US-412", "SR1596" -> "US 412", "SR 1596": one key per ref
def ref_shaped(r):
    return bool(ONE_REF.fullmatch(r)) and re.match(r'[A-Za-z]+', r).group().upper() in NETWORKS
def other_refs(t, keys=OTHER_REF_KEYS, business=False):
    out = []
    for k in keys:
        for r in (t.get(k) or '').split(';'):
            r = r.strip()
            if k in STATE_DOT_REF:
                r = re.sub(r'^([A-Za-z]*)[ -]?0*(?=\d)', lambda m: f'{m.group(1).upper() or STATE_DOT_REF[k]} ', r)  # "953B" -> "NY 953B", "SR0230" -> "SR 230"
            if k == 'unsigned_ref' and re.fullmatch(r'\d+[A-Z]?', r):
                if business:
                    continue  # a business route's bare unsigned number is its hidden state number, not "SR 96E"
                r = f'SR {r}'  # as the unsigned names below
            if ref_shaped(r):
                out.append(canon(r))
    return out
norm = lambda r: re.sub(r'[\s-]+', '', r.upper())  # "I-69" and "I 69" are one ref
def number(r):
    m = re.search(r'\d+[A-Z]?', r.upper())
    return m.group() if m else None
# One road whatever the network's spelling: "OH 121" is "SR 121", "M 13" "MI 13", "US 1 Alt" "US 1 Alternate".
same_ref = lambda a, b: norm(a) == norm(b) or (number(a) is not None and number(a) == number(b))
# A network's rank: Interstate 4, US 3, state 2, anything else (FM, county, loop, business, truck, a lettered business or spur ...) 1.
LOW_NET = {'CR', 'FM', 'RM', 'PR', 'CH', 'TR', 'TH', 'FR', 'NF', 'FS', 'FH', 'BL', 'BS', 'BI', 'BU'}
def rank(r, lettered_low=False):
    u = r.upper()
    # As a road an old number moved onto, "US 412B", "US 63B", "AR 4S", "AR 367Y" are the parent's business / spur / connector routes, as low
    # as "US 412 Business" (Fable review, PR #24). As the old number itself the letter changes nothing: old "US 63B" is no lower than AR 18.
    # E/W/N/S are split routes of the same network (US 19E, I 35W, I 80N): no lower.
    if re.search(r'\b(?:BUSINESS|BUS|ALT|ALTERNATE|TRUCK|SPUR|LOOP|BYPASS|BYP|CONNECTOR|TOLL)\b', u) \
            or (lettered_low and re.search(r'\d[A-DF-MO-RT-VX-Z]\b', u)):
        return 1
    m = re.match(r'([A-Z]+)[ -]?\d', u)
    p = m.group(1) if m else ''
    if p in ('I', 'IH'):
        return 4
    if p == 'US':
        return 3
    if p not in LOW_NET and (p in ABBR.values() or p in ('SR', 'SH', 'STH', 'K', 'M', 'N')):
        return 2
    return 1
def road_class(r):
    # The app's identity for a ref (roadClassKey, roughly): Interstate, US, county, FM/RM/PR, else state, with the number and any route word.
    # "US 412" and "US 412B" differ; "Hwy 14", "SR 14" and "AR 14" are one.
    m = re.fullmatch(r'([A-Z]*) ?(\d+[A-Z]?)(?: ([A-Z]+))?', re.sub(r'[\s-]+', ' ', r.upper()).strip())
    if not m:
        return norm(r)
    p, n, w = m.groups()
    p = 'I' if p in ('I', 'IH') else p if p in ('US', 'FM', 'RM', 'PR') else 'CR' if p in ('CR', 'CO', 'CH', 'CTH', 'CNTY', 'CSAH') else 'S'
    return f'{p}{n}{w or ""}'
ways = {}          # id -> (tags, coords)
way_nodes = {}     # id -> node ids, for named ways with a ref (numbered-street names, below)
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
        if t.get('name') and t.get('ref'):
            way_nodes[oid] = [nd.split('x')[0] for nd in (fields.get('N') or '').split(',') if nd]
    elif t.get('route') == 'road':
        members = [int(m[1:].split('@')[0]) for m in (fields.get('M') or '').split(',') if m.startswith('w')]
        relations.append((t, members))

# name -> ref -> set of half-degree cells where that name carries that ref. A name alone is not enough: "MAIN STREET" carries dozens of
# routes across a state, so the app only reads a label as a route inside the cells where the two go together.
names = defaultdict(lambda: defaultdict(set))
unsigned = defaultdict(set)
aliases = defaultdict(lambda: defaultdict(set))  # printed ref -> map ref -> cells
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
def names_of(t, kept=V1_KEYS):
    # The `kept` tags as they are (v1's, so nothing v1 had is lost); the others without the bare designations.
    return [n for k in NAME_KEYS for n in (t.get(k) or '').split(';') if k in kept or not is_designation(n.strip().upper())]
def add_name(n, ref, cells):
    n = (n or '').strip().upper()
    if re.fullmatch(r'\d+[A-Z]?', ref or ''):
        return  # a bare number would match every road with that number
    if n and ref and cells and not re.fullmatch(r'[A-Z]{0,4}\s*\d+[A-Z]?', n):  # a name, not a bare number
        names[n][ref] |= cells
def add_alias(printed, on, cells):
    # Both sides one ref of a network the app reads ("I 42", "US 70", "Loop 8"): a bare number ("70"), bare letters ("A", "E"), a network
    # id ("US:AL:Autauga") or another word ("Exit 1A", "Hwy 14") names no road. A side that is the other without its prefix ("CTH A" / "A",
    # "CR A1" / "A1") is no second number. One spelling per ref ("US-412" is "US 412").
    printed, on = canon(printed), canon(on)
    a, b = norm(printed), norm(on)
    if a != b and cells and ref_shaped(printed) and ref_shaped(on) and not a.endswith(b) and not b.endswith(a):
        aliases[printed][on] |= cells

def relation_ref(ref, net):
    # A relation's ref is bare in some networks ("8" in US:TX:Loop): give it its network's word.
    if re.fullmatch(r'\d+[A-Z]?', ref):
        # An Interstate's or US route's business route is that route's: "I 75 Business", never "Loop 75" (US:I:Business:Loop).
        biz = re.match(r'US:(I|US):Business', net)
        if biz:
            return f'{biz.group(1)} {ref} Business'
        last = net.split(':')[-1]
        word = {'Loop': 'Loop', 'Spur': 'Spur', 'FM': 'FM', 'RM': 'RM', 'Business': 'Business', 'Beltway': 'Loop', 'I': 'I', 'US': 'US'}.get(last)
        if not word and re.fullmatch(r'[A-Z]{2}', last) and net.startswith('US:'):
            word = last  # a state network: US:TX -> "TX 161"
        if not word:
            return None  # a bare number with no network word would match any road with that number
        ref = f'{word} {ref}'
    return ref

# Where each ref is a current ref (a way's, or a route relation's over its member ways), by the app's identity for it.
live = defaultdict(set)
for t, coords in ways.values():
    for r in refs_of(t):
        live[road_class(r)] |= cells_of(coords)
for t, members in relations:
    for r in (relation_ref(r, t.get('network') or '') for r in refs_of(t)):
        if r:
            for wid in members:
                if wid in ways:
                    live[road_class(r)] |= cells_of(ways[wid][1])
def old_targets(x, refs):
    # An old_ref on a lower network is the old alignment the route left (ref AR 367, old_ref US 67, the US 67 freeway a few km west): tying the
    # live number to it would read the lower road as the route, however far the route moved. Only the refs no lower than the old one take it
    # (I 42 old US 70, I 84 old I 80N, US 491 old US 666). On a freeway too: Milwaukee's WI 175 freeway is old US 41.
    return [r for r in refs if rank(r, lettered_low=True) >= rank(x)]
# How far (grid squares) from a road carrying a number today its old_ref is left out. One square (the app's reach) let Hurst and Euless Blvd
# in Hurst/Euless, TX (TX 10, old_ref SH 183) stand for SH-183 two squares south of today's SH-183 Airport Freeway, and the walk drove 9.5 mi
# of them (app routing-100/ALIAS-ANALYSIS.md, 9c37e1c8).
OLD_REACH = 2
def off_old(x, cells):
    # ... and even then only away from the number's pavement today: in a square within OLD_REACH of a way or route relation that carries the
    # old number now, it is the number moved onto a parallel road (NC's I 795 old US 117, beside US 117; Hurst Blvd, old SH 183, beside the
    # Airport Freeway) or a business route beside its parent ("US 412B" old US 412). Left out there, names and aliases both. Fable review, PR #24:
    # a direct test, so a rank that guesses wrong (two US routes) cannot tie a live number to another road beside it. Kept: I 42 old US 70
    # (Clayton Bypass), US 491 old US 666.
    now = live.get(road_class(x))
    if not now:
        return cells
    reach = range(-OLD_REACH, OLD_REACH + 1)
    def near(c):
        la, lo = map(int, c.split(':'))
        return any(f'{la + dy}:{lo + dx}' in now for dy in reach for dx in reach)
    return {c for c in cells if not near(c)}

# A retired number on a road with no number now, far from any road that carries the number today: a state route handed to a city, which the
# state's permits still print. Clovis, NM: Brady Avenue, Thomas Street and Dr Martin Luther King Jr Boulevard are old_ref "NM 270", NMDOT
# prints "NM-270" for them (trip dd62f70e) and New Mexico has no NM 270 now. Read as an unsigned number: the street's names carry it. Within
# FAR squares of the number's pavement today it is the old alignment beside the new road, as before: left out.
FAR = 50  # grid squares, ~35 mi
live_far = defaultdict(set)
for k, cs in live.items():
    for c in cs:
        la, lo = map(int, c.split(':'))
        live_far[k].add((la // FAR, lo // FAR))
def retired(olds, cells):
    out = []
    for x in olds:
        if rank(x) != 2:
            continue  # a state's own number; a retired US route (US 66, US 80 west of Dallas) is printed by no permit
        now = live_far.get(road_class(x), ())
        blocks = {(int(c.split(':')[0]) // FAR, int(c.split(':')[1]) // FAR) for c in cells}
        if not any((a + da, b + db) in now for a, b in blocks for da in (-1, 0, 1) for db in (-1, 0, 1)):
            out.append(x)
    return out

for t, coords in ways.values():
    rs = refs_of(t)
    cells = cells_of(coords)
    for r in rs:
        for n in names_of(t):
            add_name(n, r, cells)
    # Only beside a current ref: a way with an old_ref and no ref is the old alignment, no longer that route; one with only a fut_ref is not
    # built yet. unsigned_ref's names are read below, as before.
    olds = other_refs(t, ('old_ref',))
    for x in other_refs(t) if rs else ():
        if any(same_ref(x, r) for r in rs):
            continue
        on, xc = (old_targets(x, rs), off_old(x, cells)) if x in olds else (rs, cells)
        if not on:
            continue
        if x not in other_refs(t, UNSIGNED_KEYS):
            for n in names_of(t):
                add_name(n, x, xc)
        for r in on:
            add_alias(x, r, xc)
    for u in (t.get('unsigned_ref') or '').split(';') + other_refs(t, tuple(STATE_DOT_REF)) + ([] if rs else retired(olds, cells)):
        u = u.strip()
        if re.fullmatch(r'\d+[A-Z]?', u):
            u = f'SR {u}'  # state-maintained numbers kept off the signs (PA quadrant routes, NC secondary roads) print as "SR 1002"
        if u and re.fullmatch(r'[A-Z]+.*', u):
            for key in ('name', 'alt_name'):
                for n in (t.get(key) or '').split(';'):
                    add_name(n, u, cells)
                    if n.strip():
                        unsigned[u].add(n.strip().upper())

# A county's number the map keeps only as another name: Wallahatchie Road, Montgomery County, AL is name_1 "County Road 83" and Old Carter Hill
# Road "County Road 85" (TIGER's second name), neither with a ref, and ALDOT prints "CO RD 83", "CO RD 85" (app trip 93a7830d). Read as an unsigned
# number: the street's name carries "CR 83". Only a way with no ref (beside a ref, TIGER's name_1 often names ANOTHER route on the pavement), and
# not one already named for a county number (the app reads that name itself). build.sh keeps these ways whatever their class.
COUNTY_NAME = re.compile(r'(?:COUNTY|CO\.?|CNTY) (?:ROAD|RD|HIGHWAY|HWY|ROUTE|RTE) (\d+[A-Z]?)')
for t, coords in ways.values():
    nm = (t.get('name') or '').strip().upper()
    if refs_of(t) or not nm or COUNTY_NAME.fullmatch(nm):
        continue
    for k in ('alt_name', 'name_1', 'name_2'):
        for n in (t.get(k) or '').split(';'):
            m = COUNTY_NAME.fullmatch(n.strip().upper())
            if m:
                add_name(nm, f'CR {m.group(1)}', cells_of(coords))
                unsigned[f'CR {m.group(1)}'].add(nm)

# A bypass the route itself now runs on: WYDOT prints Douglas's west bypass "WY-59 BY PASS" (app trip d40b2cbf); OSM refs it plain "WY 59" (the
# road through town is old_ref WY 59) and only TIGER's name remembers it, "State Highway 59 (Bypass)". Such a way is "<its ref> Bypass" too:
# only the ref whose number TIGER's bypass name carries, and never a ref that is already a bypass, business or other lesser route.
TIGER_BYPASS = re.compile(r'.*?\b(\d+[A-Z]?) \(Bypass\)', re.I)
for t, coords in ways.values():
    tiger = ':'.join(t.get(k) or '' for k in ('tiger:name_base', 'tiger:name_base_1', 'tiger:name_base_2'))
    if '(bypass)' not in tiger.lower():
        continue
    nums = {m.group(1).upper() for m in (TIGER_BYPASS.fullmatch(p.strip()) for p in tiger.split(':')) if m}
    for r in refs_of(t):
        if number(r) in nums and rank(r) >= 2:
            add_alias(f'{canon(r)} Bypass', r, cells_of(coords))

for t, members in relations:
    net = t.get('network') or ''
    rs = [r for r in (relation_ref(r, net) for r in refs_of(t)) if r]
    member_ways = [ways[wid] for wid in members if wid in ways]
    # Concurrency kept only on the relation: a member way whose own ref lacks the relation's is that route too, named or not (theme 19).
    for ref in rs:
        for wt, coords in member_ways:
            wr = refs_of(wt)
            if not any(same_ref(ref, w) for w in wr):
                for w in wr:
                    add_alias(ref, w, cells_of(coords))
    # The relation's old / future / official / unsigned numbers: its member ways' names, its own names, its own refs.
    # As on ways: only beside a current ref, and unsigned_ref ties refs only (its names are read from the ways).
    biz = 'Business' in net
    xs = [x for x in (relation_ref(x, net) for x in other_refs(t, business=biz)) if x and not any(same_ref(x, r) for r in rs)] if rs else []
    unsigned_xs = {relation_ref(x, net) for x in other_refs(t, UNSIGNED_KEYS, business=biz)}
    olds = {relation_ref(x, net) for x in other_refs(t, ('old_ref',))}
    for x in xs:
        for wt, coords in member_ways:
            on, xc = (old_targets(x, rs), off_old(x, cells_of(coords))) if x in olds else (rs, cells_of(coords))
            if not on:
                continue
            if x not in unsigned_xs:
                for n in names_of(wt) + names_of(t, kept=()):
                    add_name(n, x, xc)
            for r in on:
                add_alias(x, r, xc)
    for ref in rs:
        # The member ways' names carry the relation's ref even when a way's own ref differs (a concurrency, a ref left off the way).
        for wt, coords in member_ways:
            for n in names_of(wt):
                add_name(n, ref, cells_of(coords))
        # The relation's own names ("Pennsylvania Turnpike" on I 76, "Bob Bullock Loop" on US:TX:Loop 20) over every member way.
        for n in names_of(t, kept=()):
            for _, coords in member_ways:
                add_name(n, ref, cells_of(coords))

# A numbered street's other name runs as far as the road does. OSM tags "111th Street" as the alt_name of Hassert Boulevard (CH 66, Will County,
# IL) on the mile east of Book Road only; the permits print "111th St" for all of it to IL-59 (app trip 32591c0f). The ways of one name and one
# ref that join end to end are one road: a numbered-street name any of them carries in another name tag is carried by all of them. Only a
# numbered street ("111TH STREET", "WEST 79TH STREET"): a grid street keeps its number for its length, a bridge's memorial name does not.
NUMBERED_STREET = re.compile(r'\b\d+(?:ST|ND|RD|TH)\b')
roads_by = defaultdict(list)  # (name, ref) -> way ids
for wid in way_nodes:
    t = ways[wid][0]
    for r in refs_of(t):
        roads_by[(t['name'].strip().upper(), r)].append(wid)
for (nm, r), wids in roads_by.items():
    if len(wids) < 2:
        continue
    at = defaultdict(list)
    for wid in wids:
        for nd in way_nodes[wid]:
            at[nd].append(wid)
    seen = set()
    for start in wids:
        if start in seen:
            continue
        part, todo = [], [start]
        seen.add(start)
        while todo:
            w = todo.pop()
            part.append(w)
            for nd in way_nodes[w]:
                for o in at[nd]:
                    if o not in seen:
                        seen.add(o)
                        todo.append(o)
        other = {n.strip().upper() for w in part for k in NAME_KEYS[1:] for n in (ways[w][0].get(k) or '').split(';')}
        other = {n for n in other if n and n != nm and NUMBERED_STREET.search(n) and not is_designation(n)}
        if other:
            cells = set().union(*(cells_of(ways[w][1]) for w in part))
            for n in other:
                add_name(n, r, cells)

# Hand-kept ties (names-extra.json): a number a state's permits print that no OSM tag ties to the pavement, each checked against the state
# DOT's own data and read only inside its box. `on`: ways carrying one of those refs are the printed number too (an alias, and their names
# carry it); `names`: ways of that name are it (an unsigned number). Written as given: these are not OSM values to be judged by shape.
# `name` with `on` (and `highway`, the ways' class): a NAME the permits print for those ways (IDOT's "I-80 OVERFLOW LANE" is the US 6 ramp).
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'names-extra.json')) as f:
    EXTRA = [e for e in json.load(f)['entries'] if e['state'] == STATE]
for e in EXTRA:
    s, w, n, ea = e['box']
    for t, coords in ways.values():
        inside = [c for c in coords if s <= c[1] <= n and w <= c[0] <= ea]
        if not inside:
            continue
        cells = cells_of(inside)
        for on in e.get('on', ()):
            for r in refs_of(t):
                if norm(r) != norm(on) or t.get('highway') != e.get('highway', t.get('highway')):
                    continue
                if 'name' in e:  # a printed NAME for that pavement, not a number
                    add_name(e['name'], r, cells)
                    continue
                aliases[e['ref']][r] |= cells
                for nm in names_of(t):
                    add_name(nm, e['ref'], cells)
        mine = {x.strip().upper() for k in NAME_KEYS for x in (t.get(k) or '').split(';')}
        for nm in e.get('names', ()):
            if nm in mine:
                # As given, even a name shaped like a number ("OLD 119" is PennDOT's SR 3093), which add_name leaves out.
                names[nm][e['ref']] |= cells
                unsigned[e['ref']].add(nm)

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
    'aliases': {k: {r: enc(c) for r, c in sorted(v.items())} for k, v in sorted(aliases.items())},
}
body = json.dumps(out, separators=(',', ':'), ensure_ascii=False).encode()
if OUT:
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, f'{STATE}.json.gz'), 'wb') as f:
        f.write(gzip.compress(body, 9, mtime=0))
else:
    sys.stdout.buffer.write(body)
print(f'{STATE}: {len(ways)} ways, {len(relations)} road relations -> {len(names)} names, {len(frontage)} routes with frontage names, {len(unsigned)} unsigned refs, {len(aliases)} printed refs with aliases', file=sys.stderr)
