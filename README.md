# RouteAll map data

The jobs that build the public map data used by the RouteAll app: road geometry, truck-relevant
places, live road work and weekly fuel prices. Everything here is built from open data and
published, unchanged in meaning, at `https://tiles.routeall.app`.

This repository holds builder code and scheduled workflows only. It holds no app code, no user or
driver data, and no credentials.

## What is published

| Data | Paths | Built from | Schedule |
| --- | --- | --- | --- |
| Road tiles | `roads/current.json` → `roads/<buildId>/tiles/<row>_<col>.bin` | OpenStreetMap (Geofabrik US state extracts) | Daily check; rebuilt within 24 h of a newer extract |
| Places (truck stops, fuel, rest areas, weigh stations) | `pois/current.json` → `pois/<buildId>/…` | OpenStreetMap, All The Places (CC0), US DOT NTAD Truck Stop Parking | With the roads |
| Road work and closures | `events/v2/current.json` → `events/v2/manifests/…` → `events/v2/objects/<sha256>.json` (and the older `events/current.json` + `events/t/…`) | USDOT WZDx feed registry, state WZDx feeds, Caltrans Lane Closure System | Hourly |
| Fuel prices | `fuel/current.json` | U.S. Energy Information Administration | Weekly |

Publication order is always content first, then the version's manifest, then the `current.json`
pointer last, so a reader never sees a pointer to data that is not there yet. Content objects
under `events/v2/objects/` are named by their SHA-256 and never change. Manifests are kept for at
least 35 days. Each road-work manifest says, per feed and per tile, whether the data is
`complete`, `partial` or `unavailable`: an empty `complete` area means nothing was reported, an
`unavailable` one means it could not be checked.

## Attribution and licences

- **OpenStreetMap.** Road and place data © OpenStreetMap contributors, available under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/). The road and
  place tiles are a derived database and are published under the same licence. Any display of
  this data must credit "© OpenStreetMap contributors".
- **Extra places.** [All The Places](https://www.alltheplaces.xyz/) (CC0) and the U.S. DOT NTAD
  Truck Stop Parking dataset (public domain).
- **Road work.** From the public feeds of the U.S. Department of Transportation's
  [WZDx registry](https://data.transportation.gov/) and the state agencies listed in each
  manifest's `feeds`, and from Caltrans. Shown as the agencies report it; not a routing or
  clearance guarantee.
- **Fuel prices.** U.S. Energy Information Administration (public domain).

## Layout

- `roads/` — the builders (`build.sh`, `tile.mjs`, `pois.mjs`, `events.mjs`, `fuel.mjs`), the one
  publisher (`publish.mjs`, `events.mjs`), the storage adapter (`store.mjs`), the Geofabrik check
  (`source-check.mjs`), the freshness check (`freshness.mjs`) and tests.
- `.github/workflows/` — `roads.yml` (daily), `road-work.yml` (hourly at :17), `fuel.yml` (weekly),
  `keepalive.yml` (monthly).
- `status/roads-build.json` — the live road build's manifest, committed monthly by the keepalive.

## Running by hand

Node 22. Every publisher writes to a folder when given one, and never needs credentials for that:

```bash
cd roads && npm ci
node events.mjs /tmp/out                  # road work into /tmp/out/events/...
STATES=delaware ./build.sh                # one state's road and place tiles into .build (needs osmium)
STORE_DIR=/tmp/out node publish.mjs       # publish that build into /tmp/out
node freshness.mjs                        # check the published data's age; exits 1 with ALERT lines
npm test
```

Production runs only through the scheduled workflows. See [SECURITY.md](SECURITY.md) for the
credential model.
