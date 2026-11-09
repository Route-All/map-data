# Road names (`names/`)

Every name a numbered road goes by, per state, so the app can tell that "Lyndon B Johnson Freeway" is the permit's
"IH-635" and that "North Service Road" is its "SL-8 NFR". Built daily with the road tiles (roads/names.py, roads/names.mjs),
published by `KIND=names node publish.mjs`. © OpenStreetMap contributors, ODbL 1.0.

## Pointer: `names/current.json` (max-age 300)

```json
{ "version": "20261108T190000Z", "path": "names/v1/20261108T190000Z",
  "states": { "TX": { "bytes": 239724, "sha256": "…" }, … } }
```

## State file: `{path}/{ST}.json.gz` (immutable)

Gzip of `{ state, source, grid, names, frontage, unsigned }`. The app downloads only the states a route needs and refuses a
file whose size or SHA-256 differs from the pointer.

- `grid`: grid squares per degree (100, about 1.1 km). A name counts as a route only in a square (or its 8 neighbours) where
  OSM pavement carries both.
- `names[NAME][ref]`: squares where the UPPERCASE name carries the ref ("I 635", "TX 161", "Loop 8", "SR 1002").
- `frontage[ref][NAME]`: squares where a non-freeway road beside that ref's main lanes has that name.
- `unsigned[ref]`: names of refs that exist only as `unsigned_ref`.

Squares are one string per entry, sorted, as small steps: the first square `lat,lng`, then `dlat,dlng`, or `dlng` alone on
the same row (`"3292,-9680 1 1 1,-2"` = 3292:-9680, 3292:-9679, 3292:-9678, 3293:-9680).
