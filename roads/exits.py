#!/usr/bin/env python3
"""
Freeway exits: every OSM highway=motorway_junction node in one state, with its exit number. build.sh runs it per state on the
same input as names.py:
  osmium add-locations-to-ways <roads + route relations>.pbf -f opl -o - | python3 exits.py <geofabrik state> <out dir>
and it writes <out dir>/<ST>.json.gz (gzip, mtime 0, so an unchanged state is byte-identical).

Why (2026-11-15): permits print the exit to leave a freeway by ("Take Exit #97 To US-70"), and the road tiles carry no exit numbers, so the app's
walk picked an exit by printed miles alone: NC 16ed9e62 left I-95 by exit 95, 2.3 mi past the printed exit 97. tags-filter keeps the tagged nodes
of the ways it keeps, so the junction nodes of names.py's motorway / trunk ways are in its input already.

  exits: [lat, lng, ref, heading, to, main way ids, main ref, ramp way ids, old ref?], one per junction node with a ref (old ref only where OSM tags one):
    heading   bearing (0-360, whole degrees) of the one-way main lanes through the node, the carriageway the exit leaves; null on a two-way road.
    to        the node's exit_to, else its destination, else the destination of a ramp that starts there; null when none.
    main ...  the motorway / trunk ways through the node and the first of their refs ("I 95").
    ramp ...  the motorway_link / trunk_link ways that start at the node: the ramp leaving at that exit.
"""
import sys, json, math, re, gzip, os
from collections import defaultdict

ABBR = {'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT',
  'delaware': 'DE', 'district-of-columbia': 'DC', 'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL',
  'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD', 'massachusetts': 'MA',
  'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new-hampshire': 'NH', 'new-jersey': 'NJ', 'new-mexico': 'NM', 'new-york': 'NY', 'north-carolina': 'NC', 'north-dakota': 'ND', 'ohio': 'OH',
  'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode-island': 'RI', 'south-carolina': 'SC', 'south-dakota': 'SD',
  'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west-virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY'}
MAIN = re.compile(r'^(motorway|trunk)$')
LINK = re.compile(r'^(motorway|trunk)_link$')

def unesc(s):
    return re.sub(r'%([0-9a-fA-F]+)%', lambda m: chr(int(m.group(1), 16)), s)

def tags_of(field):
    out = {}
    for kv in (field or '').split(','):
        if '=' in kv:
            k, v = kv.split('=', 1)
            out[unesc(k)] = unesc(v)
    return out

def bearing(a, b):
    (x1, y1), (x2, y2) = a, b
    return (math.degrees(math.atan2((x2 - x1) * math.cos(math.radians(y1)), y2 - y1)) + 360) % 360

def one_way(t):
    o = t.get('oneway')
    return o in ('yes', '1', 'true', '-1') or (t.get('highway') == 'motorway' and o != 'no') or t.get('junction') == 'roundabout'

def build(lines):
    junctions = {}                      # node id -> (lng, lat, tags)
    at = defaultdict(list)              # node id -> [(way id, tags, index, nodes, coords)] for main / link ways through a junction
    ways = []
    for line in lines:
        if not line or line[0] not in 'nw':
            continue
        parts = line.rstrip('\n').split(' ')
        fields = {p[0]: p[1:] for p in parts[1:] if p}
        t = tags_of(fields.get('T'))
        if line[0] == 'n':
            if t.get('highway') == 'motorway_junction' and t.get('ref') and fields.get('x') and fields.get('y'):
                junctions[int(parts[0][1:])] = (float(fields['x']), float(fields['y']), t)
            continue
        if not (MAIN.match(t.get('highway', '')) or LINK.match(t.get('highway', ''))):
            continue
        nodes, coords = [], []
        for nd in (fields.get('N') or '').split(','):
            m = re.match(r'n(\d+)x(-?[\d.]+)y(-?[\d.]+)', nd)
            if m:
                nodes.append(int(m.group(1))); coords.append((float(m.group(2)), float(m.group(3))))
        ways.append((int(parts[0][1:]), t, nodes, coords))
    # OPL lists nodes before ways, so every junction is known by now.
    for wid, t, nodes, coords in ways:
        for k, n in enumerate(nodes):
            if n in junctions:
                at[n].append((wid, t, k, nodes, coords))
    out = []
    for n, (x, y, t) in junctions.items():
        main = [w for w in at[n] if MAIN.match(w[1].get('highway', ''))]
        ramps = [w for w in at[n] if LINK.match(w[1].get('highway', '')) and (w[2] == 0 if w[1].get('oneway') != '-1' else w[2] == len(w[3]) - 1)]
        heading = None
        for wid, wt, k, nodes, coords in main:
            if not one_way(wt) or len(coords) < 2:
                continue
            a, b = (coords[k - 1], coords[k]) if k > 0 else (coords[k], coords[k + 1])
            heading = round(bearing(a, b) if wt.get('oneway') != '-1' else (bearing(a, b) + 180) % 360) % 360
            break
        to = t.get('exit_to') or t.get('destination') or next((w[1].get('destination') for w in ramps if w[1].get('destination')), None)
        ref = next((r.strip() for w in main for r in (w[1].get('ref') or '').split(';') if r.strip()), None)
        row = [round(y, 6), round(x, 6), t['ref'].strip(), heading, to, sorted(w[0] for w in main), ref, sorted(w[0] for w in ramps)]
        # The number the exit had before a renumbering (old_ref): Texas renumbered I-27's exits in 2025 (Lubbock's exit 8 is 538) and permits still print
        # the old ones. Appended only where tagged, so a reader of the eight fields is unchanged.
        if (t.get('old_ref') or '').strip(): row.append(t['old_ref'].strip())
        out.append(row)
    out.sort(key=lambda e: (e[0], e[1], e[2]))
    return out

def demo():
    # A one-way motorway (way 1, west to east) with exit 97 at node 2, and a ramp (way 2) leaving there with a destination.
    opl = ['n1 v1 x-78.0000 y35.0', 'n2 v1 Thighway=motorway_junction,ref=97 x-77.9990 y35.0', 'n3 v1 x-77.9980 y35.0', 'n4 v1 x-77.9980 y34.999',
           'w1 v1 Thighway=motorway,ref=I%20%95 Nn1x-78.0000y35.0,n2x-77.9990y35.0,n3x-77.9980y35.0',
           'w2 v1 Thighway=motorway_link,destination=US%20%70;Selma Nn2x-77.9990y35.0,n4x-77.9980y34.999']
    e = build(opl)
    assert e == [[35.0, -77.999, '97', 90, 'US 70;Selma', [1], 'I 95', [2]]], e
    print('exits.py demo ok')

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'demo':
        demo(); sys.exit(0)
    STATE = ABBR.get(sys.argv[1], sys.argv[1].upper()) if len(sys.argv) > 1 else '??'
    OUT = sys.argv[2] if len(sys.argv) > 2 else None
    exits = build(sys.stdin)
    body = json.dumps({'state': STATE, 'source': 'OpenStreetMap via Geofabrik; © OpenStreetMap contributors, ODbL 1.0', 'exits': exits},
                      separators=(',', ':'), ensure_ascii=False).encode()
    if OUT:
        os.makedirs(OUT, exist_ok=True)
        with open(os.path.join(OUT, f'{STATE}.json.gz'), 'wb') as f:
            f.write(gzip.compress(body, 9, mtime=0))
    else:
        sys.stdout.buffer.write(body)
    print(f'{STATE}: {len(exits)} exits, {sum(1 for e in exits if e[3] is not None)} with a heading, {sum(1 for e in exits if e[7])} with a ramp', file=sys.stderr)
