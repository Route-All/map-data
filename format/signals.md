# Traffic signals (`signals/v1`)

Traffic lights for the lights-ahead cue and "at the second light, turn right". Built by
`roads/signals.mjs` with the roads (`roads/build.sh`), published by `KIND=signals roads/publish.mjs`.
Additive: it never changes `roads/`, `pois/`, `boundaries/` or `events/`.

## Pointer

`https://tiles.routeall.app/signals/current.json` (cached 5 minutes):

```json
{ "version": "20261031T072300Z", "deg": 0.25, "path": "signals/v1/20261031T072300Z" }
```

`version` is the build id (build time, UTC, like `pois/current.json`'s `buildId`). Exactly these three fields.

## Tiles

`${path}/${Math.floor(lat / deg)}_${Math.floor(lon / deg)}.json`, for example
`signals/v1/20261031T072300Z/131_-469.json` for San Diego (32.79, -117.24).

```json
{ "s": [[-117.23931, 32.79252], [-117.24102, 32.79011]] }
```

- `s`: one `[lon, lat]` per light, rounded to 5 decimals (~1 m).
- **Served like the place tiles: the body is gzip** (starts `1f 8b`), `Content-Type: application/octet-stream`,
  no `Content-Encoding`, so the reader gunzips it itself. Immutable (`max-age=31536000`): a build's tiles never change.
- **A tile with no lights is not published: 404 means "no signals here".**
- `${path}/build.json` is metadata (counts, previous build), not a tile.

## What counts as a light

- OpenStreetMap nodes tagged `highway=traffic_signals`, from the Geofabrik state extracts. Pedestrian-only
  signals (`highway=crossing` + `crossing=traffic_signals`) are not included.
- OSM often maps one node per approach at a junction. Nodes within **30 m** of each other (chained) are merged into
  one light at their mean, so two separate lights under 30 m apart, such as a divided road's median crossing,
  count as one.
- Coverage is what OSM mappers have entered: a missing light is a gap in the map, not proof there is none.

© OpenStreetMap contributors, ODbL 1.0, like the road and place tiles.
