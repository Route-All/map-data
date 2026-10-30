#!/usr/bin/env bash
# Builds the road tiles for every US state + DC from Geofabrik's OpenStreetMap extracts.
#   roads/build.sh                      all states, into roads/.build
#   STATES="delaware maryland" roads/build.sh
#   WORK=/somewhere KEEP_PBF=1 ...      keep the downloads and reuse them on re-runs
# Output: $WORK/tiles/<row>_<col>.bin and $WORK/build.json. publish.mjs uploads them.
# One state at a time, deleting each download when done, so it fits a GitHub runner's disk.
set -euo pipefail
cd "$(dirname "$0")"

STATES=${STATES:-"alabama alaska arizona arkansas california colorado connecticut delaware district-of-columbia florida
  georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan minnesota
  mississippi missouri montana nebraska nevada new-hampshire new-jersey new-mexico new-york north-carolina north-dakota
  ohio oklahoma oregon pennsylvania rhode-island south-carolina south-dakota tennessee texas utah vermont virginia
  washington west-virginia wisconsin wyoming"}
WORK=${WORK:-.build}
rm -rf "$WORK/raw" "$WORK/raw2" "$WORK/tiles" "$WORK/tiles2" "$WORK/manifest2.json" "$WORK/sources.txt" "$WORK/build.json" "$WORK/pois-raw" "$WORK/pois" "$WORK/pois.json" "$WORK/extras.jsonl" "$WORK/signs.jsonl" "$WORK/weigh-station-gaps.geojson"
mkdir -p "$WORK/pbf"
# The tags the app reads plus v2's raw evidence (format/roadTile.mjs TAGS). area_tags=false keeps closed ways
# (roundabouts) as lines.
echo '{"attributes":{"id":true},"linear_tags":true,"area_tags":false,"include_tags":["highway","ref","name","oneway","junction","service","layer","bridge","tunnel","access","hgv","maxheight","maxwidth","maxweight"]}' > "$WORK/export.json"
echo '{"attributes":{"id":true},"linear_tags":true,"area_tags":false,"include_tags":["highway","ref","destination","destination:lanes","destination:street","exit_to"]}' > "$WORK/signs.json"
# Places (pois.mjs): the tags that say what a place is and what it offers a truck.
echo '{"attributes":{"id":true},"linear_tags":false,"area_tags":true,"include_tags":["amenity","highway","name","brand","hgv","fuel","fuel:diesel","fuel:HGV_diesel","shower","showers","food","restaurant","opening_hours","phone","contact:phone","capacity:hgv","truck_wash","addr:housenumber","addr:street","addr:city"]}' > "$WORK/places.json"

for state in $STATES; do
  start=$SECONDS
  pbf="$WORK/pbf/$state.osm.pbf"
  echo "== $state"
  # A stalled transfer (under 100 KB/s for a minute) is abandoned and retried rather than
  # left to hang the job until GitHub kills it hours later.
  [ -n "${KEEP_PBF:-}" ] && [ -s "$pbf" ] || curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 \
    --speed-limit 100000 --speed-time 60 -A "RouteAll roads build" -o "$pbf" \
    "https://download.geofabrik.de/north-america/us/$state-latest.osm.pbf"
  echo "$state $(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf")" >> "$WORK/sources.txt"
  osmium tags-filter "$pbf" w/highway -o "$WORK/highways.pbf" --overwrite
  # Every highway way: tile.mjs keeps named ones for v1 and adds the unnamed truck classes for v2.
  osmium export "$WORK/highways.pbf" -c "$WORK/export.json" -f geojsonseq -x print_record_separator=false \
    --geometry-types=linestring -o - | node tile.mjs add "$WORK"
  rm -f "$WORK/highways.pbf"
  osmium tags-filter "$pbf" nwr/amenity=fuel,weighbridge,parking,car_wash nwr/highway=rest_area,services \
    -o "$WORK/places-full.pbf" --overwrite
  # Freeways, trunk roads and ramps: an unnamed scale beside one is a weigh station, elsewhere a private scale.
  osmium tags-filter "$pbf" w/highway=motorway,motorway_link,trunk,trunk_link -o "$WORK/freeways.pbf" --overwrite
  osmium export "$WORK/freeways.pbf" -c "$WORK/signs.json" -f geojsonseq -x print_record_separator=false \
    --geometry-types=linestring -o "$WORK/freeways.geojsonseq" --overwrite
  osmium export "$WORK/places-full.pbf" -c "$WORK/places.json" -f geojsonseq -x print_record_separator=false \
    --geometry-types=point,polygon -o - | node pois.mjs add "$WORK" "$state" "$WORK/freeways.geojsonseq"
  rm -f "$WORK/places-full.pbf" "$WORK/freeways.pbf" "$WORK/freeways.geojsonseq"
  # Roads signposted to a weigh station, for the stations no one has mapped as a place (pois.mjs signs).
  osmium tags-filter "$pbf" w/destination w/destination:lanes w/destination:street w/exit_to -o "$WORK/signed.pbf" --overwrite
  osmium export "$WORK/signed.pbf" -c "$WORK/signs.json" -f geojsonseq -x print_record_separator=false \
    --geometry-types=linestring -o - | node pois.mjs signs "$WORK" "$state"
  rm -f "$WORK/signed.pbf"
  [ -n "${KEEP_PBF:-}" ] || rm -f "$pbf"
  echo "  $((SECONDS - start)) s"
done

node tile.mjs finish "$WORK"
# Truck-stop chains, CAT Scales, truck washes and the DOT parking survey (extras.mjs), merged in by finish.
node extras.mjs "$WORK"
node pois.mjs finish "$WORK"
