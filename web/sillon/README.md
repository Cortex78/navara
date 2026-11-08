# Sillon

Proof-of-concept field leveling and drainage design on **IGN LiDAR HD**, built on Navara.
The roadmap, the reference analysis and the sprint chain are in [PLAN.md](PLAN.md).

## Run

The Navara packages must be built first (`cargo make prepare` at the repo root, then `pnpm run build`).

```bash
pnpm -C web/sillon dev
```

The app opens over Camargue rice fields. Service workers need `https` or `localhost`.

```bash
pnpm -C web/sillon test        # unit tests, offline
pnpm -C web/sillon test:live   # hits data.geopf.fr and Esri
```

## Layout

| Path                         | What                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `src/geo/`                   | Lambert-93 (EPSG:2154) and Web-Mercator tile math                                     |
| `src/ign/`                   | Géoplateforme URLs and fetch, BIL decoding, LiDAR HD metadata (WFS), geocoder         |
| `src/dem/`                   | Terrarium + PNG encoding, the DEM tile bridge, `ElevationGrid` loading and sampling   |
| `src/sw/demServiceWorker.ts` | Serves `/__sillon/dem/{product}/{size}/{z}/{x}/{y}.png` from IGN BIL, cached          |
| `src/imagery/`               | Basemaps (BD ORTHO®, IRC, Esri) and LiDAR overlays (IGN shaded relief, point classes) |
| `src/app/`                   | Navara view, panel, readout, acquisition badge                                        |

Everything under `geo/`, `ign/` and `dem/` is engine-free and unit-tested; only `src/app/` imports Navara.

## Why a service worker for terrain

IGN serves elevation as float32 rasters for a bounding box (`image/x-bil;bits=32`). Navara's
`raster-dem` source only takes `{z}/{x}/{y}` RGB tiles. The service worker converts between the two.
It encodes Terrarium, which has 1/256 m steps, rather than Mapbox terrain-RGB, whose 0.1 m steps
would show as terraces on a field with 2 m of relief.

Products: `mnt` (LiDAR HD DTM, gap-filled with RGE ALTI®), `mnt-lidar` (LiDAR HD only) and `mns`
(surface model).

## Data

IGN Géoplateforme (`data.geopf.fr`), Licence Ouverte / Etalab 2.0: LiDAR HD MNT/MNS, BD ORTHO®,
RPG, geocoding. Esri World Imagery is offered as an alternative basemap under Esri's terms.

## Artifact edition

`artifact/` builds Sillon as a claude.ai artifact: a page that may only fetch
its own files, run scripts from a few CDNs, and serve standard web file types.
So it differs from the app above in three ways:

- **Data is baked.** `bake.ts` fetches a field pack from the Géoplateforme:
  the 1 m LiDAR HD grid over 3 × 3 km, a 20 m context grid over 24 km,
  BD ORTHO®, infrared and IGN shaded-relief tiles, LiDAR HD metadata and RPG
  fields. Binary parts are base64 in `.txt` files.
- **MapLibre GL renders** (loaded from jsDelivr), since the Navara engine's
  WebAssembly is larger than an artifact file may be.
- **Tiles come from a `sillon://` protocol** instead of the service worker:
  imagery from the pack's bundles, and terrain and hillshade generated in the
  page from the LiDAR grid.

```bash
NODE_USE_ENV_PROXY=1 pnpm exec tsx artifact/bake.ts <outDir>
pnpm exec tsx artifact/build.ts <outDir>
```

Then publish `<outDir>/index.html` with the other files in `<outDir>` beside it.

### Live IGN through Supabase

An artifact page cannot reach another site, but it can call the viewer's
claude.ai connectors. In live mode the page runs `execute_sql` through the
Supabase connector against the `sillon-tiles` project:

```
page ──connector: execute_sql──▶ sillon.proxy(keys) ──cache hit──▶ answer
                                        └─miss──▶ ign-proxy Edge Function ──▶ IGN Géoplateforme
```

- `supabase/keys.ts`: the key format (`kind=ortho&z=17&x=…&y=…`), shared by the
  page, Postgres and the Edge Function.
- `supabase/schema.sql`: the `sillon` schema, tile cache, `sillon.proxy()` and
  `sillon.field()`.
- `supabase/proxy.ts`, `supabase/functions/ign-proxy/`: the Edge Function. It
  serves imagery tiles, Terrarium elevation tiles (about 60 kB instead of 350 kB
  of float32), geocoding, LiDAR HD metadata and RPG fields, and measures a field
  on the native 0.5 m LiDAR HD grid. Bundle it with
  `pnpm exec tsx supabase/build-edge.ts <out.js>` and deploy the output as
  `index.ts`.

Viewers without the connector keep the Camargue pack.
