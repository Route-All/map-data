#!/usr/bin/env python3
"""
Mileposts: the mile markers / reference posts state DOTs publish as open data, one file per state, so the app can place a permit end printed only
as a milepost ("END ON US-85 AT MP BUTTE 53.29", "END ON MN-65 AT MP 97.28"): the road tiles carry no mileposts, and those ends were held for a
person (SD 3336a14e, 2860a6b0, MN 0d5ddd02, 2026-11-27).
  python3 mileposts.py <work>                      every state in SOURCES, plus OSM milestones build.sh left in <work>/milestones
  python3 mileposts.py <work> --states SD,MN       only these states (a local copy for the bench)
It writes <work>/mileposts/<ST>.json.gz (gzip, mtime 0, so an unchanged state is byte-identical) and <work>/mileposts.json, the index publish.mjs
(KIND=mileposts) uploads like the exits: mileposts/v1/<buildId>/<ST>.json.gz and the pointer mileposts/current.json. mileposts.json also carries
each DOT layer's `sources` stamp (its edit date, where the layer gives one, and its row count); the next run reuses the live rows of a layer whose
stamp is unchanged, and writes nothing at all when every state's file would be byte-identical to the live build's (a normal day).

  mileposts: [lat, lng, route, mp, county, dir, src], one per marker:
    route   our refs: "I 29", "US 85", "US 14A", and a state's own routes as "<ST> <n>" ("SD 34", "MN 65", "OH 176"); null for an OSM milestone
            that names no road (the app matches it by where it lies on the printed road).
    mp      the value the permit prints: the posted marker number, with the DOT's decimal where it publishes one (SD's 53.29-style junction markers).
    county  the county the DOT gives the marker, upper case ("BUTTE", "CUY", "085"); null where it gives none. Kentucky's and Nevada's posts restart
            in each county, so the county is part of the marker there; SD and MN print it only as a place name.
    dir     the carriageway or direction the DOT gives ("N", "I", "Eastbound"), else null.
    src     "dot" or "osm".
Sources and licences: each SOURCES entry's `licence`, written into every state file. Only public-domain and open (attribution / disclaimer) layers.
"""
import sys, os, json, gzip, hashlib, re, datetime, urllib.request, urllib.parse, urllib.error

LIVE = 'https://tiles.routeall.app/mileposts/current.json'
UA = {'User-Agent': 'RouteAll map-data build'}
FIELDS = ['lat', 'lng', 'route', 'mp', 'county', 'dir', 'src']
OSM_LICENCE = 'OpenStreetMap highway=milestone nodes, (c) OpenStreetMap contributors, ODbL 1.0'
ABBR = {'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT',
  'delaware': 'DE', 'district-of-columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
  'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA',
  'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new-hampshire': 'NH', 'new-jersey': 'NJ', 'new-mexico': 'NM', 'new-york': 'NY', 'north-carolina': 'NC', 'north-dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode-island': 'RI', 'south-carolina': 'SC', 'south-dakota': 'SD',
  'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west-virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY'}

INTERSTATE, US_ROUTE = {'I', 'IS', 'IR', 'IH', 'INT'}, {'US', 'USH', 'U'}

def ref(kind, number, st):
    """Our ref for a DOT's route: kind I / US / anything else (the state's own system), number "085", "14A", "35E". None when there is no number."""
    m = re.match(r'^0*(\d+)\s*([A-Z]?)\s*$', str(number or '').strip().upper())
    if not m or m.group(1) == '': return None
    k = str(kind or '').strip().upper()
    return f"{'I' if k in INTERSTATE else 'US' if k in US_ROUTE else st} {m.group(1)}{m.group(2)}"

def named(name, st):
    """A DOT's route name ("I-84", "US-93", "SH-55", "KY-90", "M-59", "SR443", "IS 255 N", "I190 NB") as our ref, or None."""
    m = re.match(r'^\s*([A-Z]{1,3})[- ]?0*(\d+)([A-Z]?)\b', str(name or '').upper())
    return ref(m.group(1), m.group(2) + m.group(3), st) if m else None

def num(v):
    try: return float(str(v).strip())
    except (TypeError, ValueError): return None

def text(v):
    v = ' '.join(str(v).split()) if v is not None else ''
    return v.upper() or None

# One entry per state: the layers (ArcGIS REST, queried as JSON in WGS84), the filter, and row(attributes) -> (route, mp, county, dir) or None.
DISCLAIMER = 'open data; the publisher disclaims accuracy and asks to be credited as the source'
SOURCES = {
  'SD': {'layers': ['https://sdgis.sd.gov/dot/rest/services/TIM/DOT_MileageReferenceMarkers/FeatureServer/0'], 'where': "data_class='1'",
         'licence': 'South Dakota DOT Mileage Reference Markers; ' + DISCLAIMER,
         # Mainline (data_class 1, not ramps or frontage). mrm is the marker as posted and printed ("053.29"); highway "014A" is US-14A.
         'row': lambda a: (ref(a['highway_category'], a['highway'], 'SD'), num(a['mrm']), text(a['county']), text(a['direction']))},
  'MN': {'layers': ['https://webgis.dot.state.mn.us/65agsf1/rest/services/sdw_infra/REFERENCE_POST/FeatureServer/0'], 'where': '1=1',
         'licence': 'MnDOT Highway Reference Posts (Minnesota Geospatial Commons); public, no use constraints beyond keeping MnDOT\'s disclaimer '
                    'https://www.dot.state.mn.us/information/disclaimer.html',
         # ROUTE_ID SSGGGGGGGGGGNNNNAD: 01 Interstate, 02 US, 03 trunk highway; NNNN the number, A its letter ("-" for none), D increasing / decreasing.
         'row': lambda a: (ref({'01': 'I', '02': 'US'}.get(a['ROUTE_ID'][:2], 'MN'), a['ROUTE_ID'][12:16] + a['ROUTE_ID'][16].replace('-', ''), 'MN'),
                           num(a['REFERENCE_POST']), None, a['ROUTE_ID'][17:18] or None) if len(a['ROUTE_ID'] or '') >= 18 else None},
  'IA': {'layers': ['https://gis.iowadot.gov/agshost/rest/services/RAMS/Reference_Posts/FeatureServer/0'], 'where': 'EFFECTIVE_END_DATE IS NULL',
         'licence': 'Iowa DOT Reference Posts; CC BY 4.0',
         'row': lambda a: (ref(a['OFFICIAL_ROUTE_PREFIX'], a['OFFICIAL_ROUTE_NUMBER'], 'IA') if a['OFFICIAL_ROUTE_PREFIX'] else None,
                           num(a['REFERENCE_POST_VALUE']), None, text(a['OFFICIAL_ROUTE_DIRECTION']))},
  'ID': {'layers': ['https://gisp.itd.idaho.gov/server/rest/services/GDWarehouse/Assets/FeatureServer/3'], 'where': '1=1',
         'licence': 'Idaho Transportation Department Mile Post Signs; ' + DISCLAIMER,
         'row': lambda a: (named(a['RouteName'], 'ID'), num(a['MilePostSigns']), None, text(a['TravelDirection']))},
  # Interstates, US routes, state routes (layers 0-2); POST_NAME "U_41_204" is US-41 post 204.
  'IN': {'layers': [f'https://gis.indot.in.gov/ro/rest/services/DOT/ReferencePosts/FeatureServer/{i}' for i in (0, 1, 2)], 'where': '1=1',
         'licence': 'INDOT Reference Posts; ' + DISCLAIMER,
         'row': lambda a: (lambda p: (ref(p[0], p[1], 'IN'), num(p[2]), None, None) if len(p) == 3 else None)(str(a['POST_NAME'] or '').split('_'))},
  # Kentucky's milepoints restart in each county: the county number is part of the marker.
  'KY': {'layers': ['https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/State_Road_Milepoints/FeatureServer/1'], 'where': '1=1',
         'licence': 'Kentucky Transportation Cabinet State Road Milepoints; CC0 1.0',
         'row': lambda a: (named(a['RTNAME'], 'KY'), num(a['MILEPOINT']), f"{int(a['CO_NUMBER']):03d}" if a['CO_NUMBER'] is not None else None, None)},
  'MA': {'layers': ['https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/Mileposts/FeatureServer/0'], 'where': 'Signed=1',
         'licence': 'MassDOT Mileposts; public domain',
         'row': lambda a: (named(a['Route_ID'], 'MA'), num(a['Mile_Point']), None, text((a['Route_ID'] or '').split(' ')[-1]))},
  'MI': {'layers': ['https://gisagomdot.state.mi.us/arcgis/rest/services/MDOT/MdotMileMarker/FeatureServer/0'], 'where': '1=1',
         'licence': 'MDOT Mile Markers; ' + DISCLAIMER,
         'row': lambda a: (named(a['Route'], 'MI'), num(a['MileNumber']), None, text(a['Direction']))},
  'MO': {'layers': ['https://mapping.modot.mo.gov/arcgis/rest/services/BaseMap/EmergRefMkr/MapServer/6'], 'where': '1=1',
         'licence': 'MoDOT Emergency Reference Markers; ' + DISCLAIMER,
         'row': lambda a: (ref(a['DESIGNATION'], a['TRAVELWAY_NAME'], 'MO'), num(a['SIGN_NUM_LOG']), text(a['COUNTY_NAME']), text(a['DIRECTION']))},
  'NC': {'layers': ['https://services.arcgis.com/NuWFvHYDMVmmxMeM/arcgis/rest/services/NCDOT_Mile_Markers_Published_View/FeatureServer/0'], 'where': '1=1',
         'licence': 'NCDOT Mile Markers; ' + DISCLAIMER,
         'row': lambda a: (named(a['RouteName'], 'NC'), num(a['SignMP']), text(a['County']), text(a['RouteDirection']))},
  'ND': {'layers': ['https://gis.dot.nd.gov/arcgis/rest/services/external/Transportation_Reference_Points/FeatureServer/0'], 'where': '1=1',
         'licence': 'NDDOT Transportation Reference Points; ' + DISCLAIMER,
         'row': lambda a: (ref({'I': 'I', 'U': 'US'}.get(a['RTE_SIN'], 'ND'), a['HWY'], 'ND'), num(a['REF_PT_NUM']), None, text(a['DIRECTION']))},
  # Nevada posts county-cumulative mileage ("CoCum"): it restarts in each county, given as its two-letter code ("WA" Washoe).
  'NV': {'layers': ['https://gis.dot.nv.gov/arcgis/rest/services/Authoritative/MileMarker_CoCum/FeatureServer/0'], 'where': '1=1',
         'licence': 'NDOT Mile Markers (county cumulative); ' + DISCLAIMER,
         'row': lambda a: (named(a['PostedRoute'], 'NV'), num(a['PostedMileage']), text(a['PostedCounty']), None)},
  'OH': {'layers': ['https://tims.dot.state.oh.us/ags/rest/services/Roadway_Information/State_Milepost/MapServer/0'], 'where': '1=1',
         'licence': 'ODOT TIMS State Mileposts; public information',
         'row': lambda a: (ref(a['ROUTE_CODE'], a['RTE_NUMBER'], 'OH'), num(a['MILEPOST']), text(a['COUNTY']), None)},
}

def get(url, timeout=60):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r: return r.read()

def arcgis(url, **params):
    d = json.loads(get(f'{url}?{urllib.parse.urlencode({**params, "f": "json"})}'))
    if 'error' in d: raise RuntimeError(f"{url}: {d['error'].get('message')}")
    return d

def point(g):
    """A feature's (lat, lng): a point, or the first of a multipoint (Ohio)."""
    if not g: return None
    x, y = (g['x'], g['y']) if 'x' in g else (g['points'][0] if g.get('points') else (None, None))
    return (round(y, 6), round(x, 6)) if isinstance(x, (int, float)) and isinstance(y, (int, float)) else None

def stamp(url, where):
    """What says a layer changed: its data edit date where the server gives one, and its row count."""
    info = arcgis(url)
    edit = (info.get('editingInfo') or {}).get('dataLastEditDate') or (info.get('editingInfo') or {}).get('lastEditDate')
    return {'url': url, 'edited': edit, 'count': arcgis(f'{url}/query', where=where, returnCountOnly='true')['count']}, info

def fetch(url, where, info):
    """Every feature of one layer, page by page in object-id order."""
    oid = info.get('objectIdField') or next((f['name'] for f in info.get('fields', []) if f.get('type') == 'esriFieldTypeOID'), 'OBJECTID')
    size, offset, out = int(info.get('maxRecordCount') or 1000), 0, []
    while True:
        d = arcgis(f'{url}/query', where=where, outFields='*', outSR=4326, orderByFields=oid, resultOffset=offset, resultRecordCount=size)
        feats = d.get('features') or []
        out += feats; offset += len(feats)
        if not feats or not (d.get('exceededTransferLimit') or len(feats) == size): return out

def rows(st, feats):
    """DOT features -> marker rows, dropping any with no route, value or place."""
    out = []
    for f in feats:
        try: r = SOURCES[st]['row'](f.get('attributes') or {})
        except (KeyError, ValueError, TypeError): r = None
        p = point(f.get('geometry'))
        if r and r[0] and r[1] is not None and p: out.append([p[0], p[1], r[0], round(r[1], 3), r[2], r[3], 'dot'])
    return out

def milestone_value(tags):
    """An OSM milestone's mile value: distance=72, "72 mi" (miles, the US norm), else None (km markers, no number)."""
    for k in ('distance', 'pk'):
        m = re.match(r'^\s*(\d+(?:\.\d+)?)\s*(mi|mile|miles)?\s*$', str(tags.get(k, '')), re.I)
        if m: return float(m.group(1))
    return None

def osm_rows(work, st):
    """OSM highway=milestone nodes build.sh exported for this state (<work>/milestones/<geofabrik name>.geojsonseq). Route from the node's own ref."""
    name = next((n for n, a in ABBR.items() if a == st), None)
    path = os.path.join(work, 'milestones', f'{name}.geojsonseq')
    out = []
    if not name or not os.path.exists(path): return out
    for line in open(path, encoding='utf8'):
        try: f = json.loads(line.strip().lstrip('\x1e'))
        except ValueError: continue
        tags, g = f.get('properties') or {}, f.get('geometry') or {}
        mp = milestone_value(tags)
        if mp is None or g.get('type') != 'Point': continue
        r = tags.get('ref') or tags.get('highway:ref') or tags.get('route_ref')
        out.append([round(g['coordinates'][1], 6), round(g['coordinates'][0], 6), named(r.split(';')[0], st) if r else None, mp, None, None, 'osm'])
    return out

def body(st, markers, licences):
    # One row per marker: MnDOT lists an undivided road's post once per direction, at the same point.
    markers = list({(r[0], r[1], r[2], r[3], r[4]): r for r in sorted(markers, key=lambda r: (str(r[2]), r[3], r[0], r[1], str(r[5])), reverse=True)}.values())
    markers.sort(key=lambda r: (str(r[2]), r[3], r[0], r[1], str(r[5])))
    return gzip.compress(json.dumps({'state': st, 'sources': licences, 'fields': FIELDS, 'mileposts': markers}, separators=(',', ':'), ensure_ascii=False).encode(), 9, mtime=0)

def live_build():
    """The live build.json, or None when none is live yet (404). Any other failure: None too; every layer is then fetched afresh."""
    try:
        ptr = json.loads(get(LIVE))
        return {**json.loads(get(f"https://tiles.routeall.app/{ptr['path']}/build.json")), 'path': ptr['path']}
    except Exception:
        return None

def live_rows(live, st):
    """The live build's rows for one state, or None."""
    try: return json.loads(gzip.decompress(get(f"https://tiles.routeall.app/{live['path']}/{st}.json.gz")))['mileposts']
    except Exception: return None

def same_layers(a, b):
    """A state's layers unchanged: every stamp carries an edit date and matches the live one (a count alone does not prove a layer unedited)."""
    return bool(a) and bool(b) and len(a) == len(b) and all(x.get('edited') and x == y for x, y in zip(a, b))

def build(work, states, live):
    """{ST: gz bytes}, {ST: layer stamps}, notes. A layer that fails keeps the live rows for its state (or none), and the run carries on."""
    files, stamps, notes = {}, {}, []
    for st in sorted(states):
        dot, licences = [], []
        if st in SOURCES:
            src, where = SOURCES[st], SOURCES[st]['where']
            try:
                pairs = [stamp(u, where) for u in src['layers']]
                stamps[st] = [s for s, _ in pairs]
                old = live and same_layers(stamps[st], (live.get('sources') or {}).get(st)) and live_rows(live, st)
                if old is not None and old is not False:
                    dot = [r for r in old if r[6] == 'dot']; notes.append(f'{st}: unchanged, live rows kept')
                else:
                    dot = rows(st, [f for (s, info), u in zip(pairs, src['layers']) for f in fetch(u, where, info)])
                    # A layer that suddenly returns far fewer markers than it says it holds is a broken answer, not a smaller state.
                    if len(dot) < 0.5 * sum(s['count'] for s in stamps[st]): raise RuntimeError(f'{len(dot)} usable of {sum(s["count"] for s in stamps[st])} rows')
                licences.append(src['licence'] + ' (' + ', '.join(src['layers']) + ')')
            except Exception as e:
                old = live and live_rows(live, st)
                dot = [r for r in (old or []) if r[6] == 'dot']
                if live and (live.get('sources') or {}).get(st): stamps[st] = live['sources'][st]
                else: stamps.pop(st, None)
                if dot: licences.append(src['licence'])
                notes.append(f'{st}: {e}; {"live rows kept" if dot else "no DOT markers this run"}')
        osm = osm_rows(work, st)
        if osm: licences.append(OSM_LICENCE)
        if dot or osm: files[st] = body(st, dot + osm, licences)
    return files, stamps, notes

def write(work, files, stamps):
    d = os.path.join(work, 'mileposts'); os.makedirs(d, exist_ok=True)
    index = {}
    for st, gz in sorted(files.items()):
        with open(os.path.join(d, f'{st}.json.gz'), 'wb') as f: f.write(gz)
        index[st] = {'bytes': len(gz), 'sha256': hashlib.sha256(gz).hexdigest()}
    built = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    with open(os.path.join(work, 'mileposts.json'), 'w') as f:
        json.dump({'buildId': re.sub(r'[-:]', '', built), 'builtAt': built, 'states': index, 'sources': stamps}, f, indent=1); f.write('\n')
    return index

def unchanged(files, live):
    """Every state's file is the live one, byte for byte, and no live state went missing: nothing to publish."""
    have = (live or {}).get('states') or {}
    return bool(have) and set(have) == set(files) and all(have[st].get('sha256') == hashlib.sha256(gz).hexdigest() for st, gz in files.items())

def main(argv):
    if len(argv) < 2: sys.exit('usage: python3 mileposts.py <work> [--states SD,MN]')
    work = argv[1]; os.makedirs(work, exist_ok=True)
    only = argv[argv.index('--states') + 1].upper().split(',') if '--states' in argv else None
    states = only or sorted(set(ABBR.values()))
    live = None if only else live_build()
    files, stamps, notes = build(work, states, live)
    for n in notes: print('mileposts:', n)
    if not files: sys.exit('mileposts: no state has any markers; not writing')
    if unchanged(files, live): print('mileposts: every state is the live build, byte for byte; nothing to build'); return
    index = write(work, files, stamps)
    n = {st: len(json.loads(gzip.decompress(gz))['mileposts']) for st, gz in files.items()}
    print(f"mileposts: {sum(n.values())} in {len(index)} states ({', '.join(f'{k} {v}' for k, v in n.items())}), "
          f"{sum(s['bytes'] for s in index.values()) / 1e6:.1f} MB gzip")

if __name__ == '__main__':
    main(sys.argv)
