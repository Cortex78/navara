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
