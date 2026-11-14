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

Gzip of `{ state, source, grid, names, frontage, unsigned, aliases }` (`aliases` from v3; a reader treats it as optional). The app downloads only the states a route needs and refuses a
file whose size or SHA-256 differs from the pointer.

- `grid`: grid squares per degree (100, about 1.1 km). A name counts as a route only in a square (or its 8 neighbours) where
  OSM pavement carries both.
- `names[NAME][ref]`: squares where the UPPERCASE name carries the ref ("I 635", "TX 161", "Loop 8", "SR 1002").
  Names come from a way's `name`, `alt_name`, `official_name`, `old_name`, `loc_name`, `reg_name`, `nat_name`, `short_name`,
  `int_name`, `name:en`, `name_1`, `name_2`, and from a road route relation's own names over every member way ("Pennsylvania
  Turnpike" → "I 76", "Bob Bullock Loop" → "Loop 20"). From v3 a name also carries its way's or relation's `old_ref`, `fut_ref`,
  `official_ref` and `unsigned_ref` ("Clayton Bypass Scenic Byway" → "I 42" and its old "US 70"). Keys are exact UPPERCASE names; the app normalizes on lookup. A name that
  is only a designation ("LOOP 335", and from the tags added in v2 also "STATE ROUTE 103", "I 95 (MA)") is not a key: the app
  parses those itself.
- `frontage[ref][NAME]`: squares where a non-freeway road beside that ref's main lanes has that name.
- `unsigned[ref]`: names of refs that exist only as `unsigned_ref`.
- `aliases[printed ref][map ref]`: squares where pavement the map refs as `map ref` is also `printed ref`, so a permit that prints
  one is read on pavement labelled the other. Sources: a way's or route relation's `old_ref` / `fut_ref` / `official_ref` /
  `unsigned_ref` against its `ref` (NC's Clayton Bypass: `"US 70": { "I 42": … }`; I-69 at Cleveland, TX: `"I 69": { "US 59": … }`),
  and a route relation's ref against a member way's own refs when the way's `ref` lacks it (a concurrency mapped only on the
  relation, named or unnamed). Refs as OSM writes them; a bare number on either side is left out. The app reads the pairs both
  ways (services/roadNames.ts `refAliases`), only in a square (or its 8 neighbours) listed here.

Squares are one string per entry, sorted, as small steps: the first square `lat,lng`, then `dlat,dlng`, or `dlng` alone on
the same row (`"3292,-9680 1 1 1,-2"` = 3292:-9680, 3292:-9679, 3292:-9678, 3293:-9680).
