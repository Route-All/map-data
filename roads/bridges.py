#!/usr/bin/env python3
"""
Bridges: every highway bridge in the FHWA National Bridge Inventory (NBI), one file per state, so the app can warn where a leg the permit does not
print (the driver's own legs, unprinted connectors, Mapbox fill-ins) passes under a bridge lower than the load, or over a posted, closed or weak one.
Permit offices have already cleared the printed roads.
  python3 bridges.py <work>               asks FHWA for its newest delimited all-states file; builds only when it differs from the live build
  python3 bridges.py <work> <zip or txt>  builds from a file on disk, no check
It writes <work>/bridges/<ST>.json.gz (gzip, mtime 0, so an unchanged state is byte-identical) and <work>/bridges.json, the index publish.mjs
(KIND=bridges) uploads like the exits: bridges/v1/<buildId>/<ST>.json.gz and the pointer bridges/current.json. bridges.json also carries `source`
(FHWA's URL, year, Last-Modified and size), and the next run compares it with FHWA's HEAD, so the yearly file is downloaded once, not daily.

  bridges: [lat, lng, structure, on, carried, under, under_ref, over_ft, under_ft, width_ft, opr_t, posting, status], one per bridge:
    lat, lng     items 16/17 (DDMMSS.ss) in decimal degrees. NBI coordinates can be hundreds of metres off: match a bridge to a road by its route and
                 name, not by the point alone.
    structure    item 8, the state's structure number.
    on           the route on the bridge from items 5B-5E: "I 84 W", "US 98 Bus", "SR 24", "CR 279"; null for a city street or unnumbered road.
                 A trailing N/E/S/W is item 5E, which states use both for a split route (I 35 E) and for one carriageway (I 84 W on the
                 westbound bridge of I-84): match with and without it.
    carried      item 7, the road on the bridge as the state names it ("RISING SUN LANE").  under: item 6A, what it crosses ("US 11").
    under_ref    item 54A: "H" highway or "R" railroad beneath; null when neither (water, a valley).
    over_ft      item 53, vertical room for traffic ON the bridge (a truss, an overhead sign), in feet.
    under_ft     item 54B, vertical room for the highway or railroad UNDER the bridge, in feet.
    width_ft     item 47, horizontal room between the rails for traffic on the bridge, in feet.
                 A clearance is null when the NBI codes it as unrestricted (99.99; states also code 100 ft as 30.17-32.68 m) or does not record it.
    opr_t        item 64, the operating rating in metric tons as FHWA publishes it (rating-factor submissions are already converted, RF x 32.4 t, MS18).
    posting      item 70: 5 = at or above legal loads, 4..0 = increasingly below legal (should be posted).
    status       item 41: A open, B open with posting recommended, D open only because of temporary shoring, E temporary structure,
                 G new and not yet open, K closed, P posted for load, R posted for other limits (speed, one truck at a time).
"""
import sys, os, io, csv, json, gzip, hashlib, re, zipfile, datetime, urllib.request

FHWA = 'https://www.fhwa.dot.gov/bridge/nbi/{year}hwybronefiledel.zip'
LIVE = 'https://tiles.routeall.app/bridges/current.json'
UA = {'User-Agent': 'RouteAll map-data build'}
SOURCE = 'FHWA National Bridge Inventory {year}, https://www.fhwa.dot.gov/bridge/nbi.cfm; U.S. government work, public domain'
FIELDS = ['lat', 'lng', 'structure', 'on', 'carried', 'under', 'under_ref', 'over_ft', 'under_ft', 'width_ft', 'opr_t', 'posting', 'status']
# FIPS state codes of the 50 states and DC, the states the road build covers; Puerto Rico (72) and the Virgin Islands (78) are left out.
STATES = {'01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL', '13': 'GA',
  '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME', '24': 'MD', '25': 'MA', '26': 'MI',
  '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH', '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI', '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA',
  '53': 'WA', '54': 'WV', '55': 'WI', '56': 'WY'}
PREFIX = {'1': 'I', '2': 'US', '3': 'SR', '4': 'CR'}                                  # item 5B; 5-8 (city, federal / state lands, other) have no number to match
LEVEL = {'2': 'Alt', '3': 'Byp', '4': 'Spur', '6': 'Bus', '7': 'Ramp', '8': 'Frontage'}  # item 5C; 1 mainline
SUFFIX = {'1': 'N', '2': 'E', '3': 'S', '4': 'W'}                                      # item 5E
FT = 3.28084

def feet(m, unrestricted=30.0):
    """Metres to feet (2 decimals); None for blank, 0 and 'unrestricted'. 99.99 is the coding guide's unrestricted, and states also code 100 ft
    (30.17-32.68 m: Kansas 30.47 on 19,119 bridges), so a clearance of 30 m or more is unrestricted. Widths pass unrestricted=99 (99.9)."""
    try: v = float(m)
    except ValueError: return None
    return round(v * FT, 2) if 0 < v < unrestricted else None

def degrees(s, digits):
    """Items 16/17: DDMMSSss (latitude, 8 digits) or DDDMMSSss (longitude, 9). None when blank or not a number.
    Some states (Maryland, Kentucky, Alabama, ~1,300 bridges) code decimal degrees instead: 32126910 = 32.126910, as minutes or seconds of 60
    or more give away. Read as such; the caller's range check drops what is still nonsense."""
    s = s.strip()
    if not s.isdigit() or not s.strip('0'): return None
    s = s.zfill(digits); d, m, sec = int(s[:-6]), int(s[-6:-4]), int(s[-4:]) / 100
    return round(d + m / 60 + sec / 3600, 5) if m < 60 and sec < 60 else round(d + int(s[-6:]) / 1e6, 5)

def route(prefix, level, number, suffix):
    n = number.strip().lstrip('0')
    if prefix not in PREFIX or not n: return None
    return ' '.join(x for x in (PREFIX[prefix], n, SUFFIX.get(suffix), LEVEL.get(level)) if x)

def text(s):
    return ' '.join(s.split()) or None

def number(s, kind):
    try: return kind(s)
    except ValueError: return None

NEED = ['STATE_CODE_001', 'STRUCTURE_NUMBER_008', 'ROUTE_PREFIX_005B', 'SERVICE_LEVEL_005C', 'ROUTE_NUMBER_005D', 'DIRECTION_005E',
        'FEATURES_DESC_006A', 'FACILITY_CARRIED_007', 'LAT_016', 'LONG_017', 'VERT_CLR_OVER_MT_053', 'VERT_CLR_UND_REF_054A', 'VERT_CLR_UND_054B',
        'HORR_CLR_MT_047', 'OPERATING_RATING_064', 'POSTING_EVAL_070', 'OPEN_CLOSED_POSTED_041']

def build(lines):
    """NBI delimited rows (text in single quotes) -> ({ST: [bridge, ...]}, {reason: rows dropped})."""
    rows = csv.reader(lines, quotechar="'")
    head = [h.strip() for h in next(rows)]
    missing = [k for k in NEED if k not in head]
    # The NBI is moving to the SNBI format; a renamed column must stop the build, not publish nulls.
    if missing: raise SystemExit(f'NBI header lacks {missing}: the file format changed')
    at = {k: head.index(k) for k in NEED}
    out, dropped = {}, {'other territory': 0, 'no location': 0}
    for r in rows:
        if len(r) < len(head): continue
        g = lambda k: r[at[k]].strip()
        st = STATES.get(g('STATE_CODE_001'))
        if not st: dropped['other territory'] += 1; continue
        lat, lon = degrees(g('LAT_016'), 8), degrees(g('LONG_017'), 9)
        if lat is None or lon is None or not (17 < lat < 72 and 64 < lon < 180): dropped['no location'] += 1; continue
        ref = g('VERT_CLR_UND_REF_054A').upper()
        posting, opr = number(g('POSTING_EVAL_070'), int), number(g('OPERATING_RATING_064'), float)
        out.setdefault(st, []).append([lat, -lon, g('STRUCTURE_NUMBER_008'),
            route(g('ROUTE_PREFIX_005B'), g('SERVICE_LEVEL_005C'), g('ROUTE_NUMBER_005D'), g('DIRECTION_005E')),
            text(g('FACILITY_CARRIED_007')), text(g('FEATURES_DESC_006A')), ref if ref in ('H', 'R') else None,
            feet(g('VERT_CLR_OVER_MT_053')), feet(g('VERT_CLR_UND_054B')) if ref in ('H', 'R') else None, feet(g('HORR_CLR_MT_047'), 99.0),
            None if opr is None else round(opr, 1), posting, g('OPEN_CLOSED_POSTED_041').upper() or None])
    for b in out.values(): b.sort(key=lambda x: (x[0], x[1], x[2]))
    return out, dropped

def fhwa_head(year):
    """FHWA's HEAD for that year's file, or None (FHWA answers 503, not 404, for a year it has not published)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(FHWA.format(year=year), method='HEAD', headers=UA), timeout=30) as r:
            return {'url': FHWA.format(year=year), 'year': year, 'lastModified': r.headers.get('Last-Modified'), 'bytes': int(r.headers.get('Content-Length') or 0)}
    except Exception:
        return None

def live_source():
    """The live build's `source`, or None when there is none or it cannot be read (then the build runs, as a first one would)."""
    try:
        get = lambda u: json.load(urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30))
        ptr = get(LIVE)
        return get(f"https://tiles.routeall.app/{ptr['path']}/build.json").get('source')
    except Exception:
        return None

def should_build(found, live):
    """Build unless FHWA's file is the one live (same URL, Last-Modified and size) or older than it (a newer year's file gone missing, a 503)."""
    if not live: return True
    if found['year'] < live.get('year', 0): return False
    return any(found.get(k) != live.get(k) for k in ('url', 'lastModified', 'bytes'))

def write(work, states, source):
    d = os.path.join(work, 'bridges'); os.makedirs(d, exist_ok=True)
    index = {}
    for st, rows in sorted(states.items()):
        body = json.dumps({'state': st, 'source': SOURCE.format(year=source['year']), 'fields': FIELDS, 'bridges': rows},
                          separators=(',', ':'), ensure_ascii=False).encode()
        gz = gzip.compress(body, 9, mtime=0)
        with open(os.path.join(d, f'{st}.json.gz'), 'wb') as f: f.write(gz)
        index[st] = {'bytes': len(gz), 'sha256': hashlib.sha256(gz).hexdigest()}
    # A short set would drop a whole state's bridges: every state the roads cover, or nothing.
    if len(index) != len(STATES): raise SystemExit(f'{len(index)} bridge files for {len(STATES)} states')
    built = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(os.path.join(work, 'bridges.json'), 'w') as f:
        json.dump({'buildId': re.sub(r'[-:]', '', built), 'builtAt': built, 'states': index, 'source': source}, f, indent=1); f.write('\n')
    return index

def lines_of(path):
    if path.endswith('.zip'):
        z = zipfile.ZipFile(path); name = next(n for n in z.namelist() if n.lower().endswith('.txt'))
        return io.TextIOWrapper(z.open(name), encoding='latin-1', newline='')
    return open(path, encoding='latin-1', newline='')

if __name__ == '__main__':
    if len(sys.argv) < 2: sys.exit('usage: python3 bridges.py <work> [<NBI zip or txt>]')
    work = sys.argv[1]; os.makedirs(work, exist_ok=True)
    if len(sys.argv) > 2:
        path = sys.argv[2]; m = re.search(r'(20\d\d)', os.path.basename(path))
        source = {'url': None, 'year': int(m.group(1)) if m else None, 'lastModified': None, 'bytes': os.path.getsize(path)}
    else:
        this = datetime.date.today().year
        source = next((h for h in map(fhwa_head, range(this, this - 3, -1)) if h), None)
        if not source: sys.exit('no FHWA NBI file found for the last three years')
        live = live_source()
        if not should_build(source, live):
            print(f"bridges: FHWA's {source['year']} file is the one live ({source['lastModified']}); nothing to build"); sys.exit(0)
        path = os.path.join(work, 'nbi.zip')
        req = urllib.request.Request(source['url'], headers=UA)
        with urllib.request.urlopen(req, timeout=300) as r, open(path, 'wb') as f:
            while chunk := r.read(1 << 20): f.write(chunk)
        if source['bytes'] and os.path.getsize(path) != source['bytes']: sys.exit(f"downloaded {os.path.getsize(path)} bytes, FHWA said {source['bytes']}")
    states, dropped = build(lines_of(path))
    if len(sys.argv) == 2: os.remove(path)
    index = write(work, states, source)
    n = sum(len(b) for b in states.values())
    print(f"bridges: {n} in {len(index)} states, {sum(s['bytes'] for s in index.values()) / 1e6:.1f} MB gzip; dropped {dropped}")
