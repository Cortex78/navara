# Sillon — plan and sprint chain

Sillon is a proof-of-concept field leveling and drainage design tool for French farmland. It is
built on Navara and uses IGN LiDAR HD. It reproduces the workflow of the reference tools
(a LiDAR field viewer with drainage and cut/fill, a field-design workstation, and a drone-survey
driveway designer). It uses its own name, code and look, and swaps USGS 3DEP for IGN data.

## 1. Reference analysis

### 1.1 What the reference tools do

**Field viewer** (desktop and phone, Leaflet + three.js, single HTML file)

| Area         | Observed behaviour                                                                                                                                                                                                                                                                                                               |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map          | Go-to search (town, county, address, lat/lng); satellite basemap; zoom; locate-me.                                                                                                                                                                                                                                               |
| Rendering    | "Shaded relief (gray)" and a blue→red elevation ramp with an auto range (`228.3 – 236.0 ft`); a LiDAR opacity slider (0–100 %); "Relief & shadows" settings.                                                                                                                                                                     |
| Readout      | Cursor bar: `235.62 ft (71.82 m) · 35.69078, -90.04448`; in cut/fill mode it adds `Cut 0.32 ft (design 238.17)`.                                                                                                                                                                                                                 |
| Survey badge | `Lidar flown Dec 2023 – Feb 2024 · QL 1`, or `No USGS lidar flight here`.                                                                                                                                                                                                                                                        |
| Tools        | Draw elevation profile; draw field area (numbered vertex handles 1…n, prompt `6 corners · double-click or Done to calculate`, Undo / Cancel / Done).                                                                                                                                                                             |
| Field        | Area `150.2 ac`, elevation range `236.6 to 238.8 ft`, `2.2 ft relief`.                                                                                                                                                                                                                                                           |
| Drainage     | Flow lines thickening downstream; outlets on the boundary labelled with contributing area (`137.7 ac`, `18.1 ac`, …); standing-water fill.                                                                                                                                                                                       |
| Cut / Fill   | Best-fit plane (`Slope % 0.087`, `Heading 179.0°`, undo); Cut `25,081 yd³` / Fill `20,901 yd³`; cut per acre; cut:fill `1.20`; max cut/fill `7.18 / 3.37 ft`; cut/fill ramp ±0.7 ft; existing and design contours at 0.20 ft; flow arrow `0.09 %`; PDF report; existing and design CSV.                                          |
| 3D rain      | Satellite draped on the field DEM, or the depth colouring; Start/Pause, reset; existing or design surface; rain `3.25 in/hr`, storm length `1:45 (5.69 in total)`, height stretch `3×`, speed; flow streamlines; HUD `Raining 0:28 · 1.32 in fell / Over 1 in: 254.0 ac · deepest 67.1 in / Ran off 0.20 in · on field 1.80 in`. |

**Field-design workstation** (desktop)

- Left rail: Field → Surface → Paths → Water → Irrigate → Job & $ → Export.
- Views: Plan, 3D, Profile. Colour by cut/fill with styles (copper cut / slate fill) and a band width. Toggles for hillshade, existing contours (0.25), design contours, points, station values, flow arrow and satellite.
- Paths: four guidance-line types (hipper = planting line, levees for rice, drains = ditching, plus a fourth), laid out against existing ground or design, track point spacing 15 ft.
- Drains: "Find drain paths" with a balance slider ("ponds 0.080 ft, sweeps every 25 ft, keeps lines 90 ft or wider, drops any within 80 ft of a longer one"); "Connect every path to an outlet"; "Draw a ditch…"; reachability report ("87 of 94 paths carried on to the field edge; 94 need more than 1.00 ft of cut…"); a per-drain list with length.
- Drain profile: station along the flow vs elevation, existing ground vs design invert, uphill stretches flagged red (`1601 ft uphill (2.37 ft)`).
- Water depth legend at a time step (`Water depth at 3:30`); probe tooltip (`336° · 0.028 · 0.000`).

**Driveway designer** (drone survey, UTM 15N)

- Parametric alignments (circle drive, oval loop, half-moon, turnaround, line), stationing (`0+00 … 3+75`), typical section (width, crown, cross slope, shoulders, fill/cut slopes H:1, max/min grade, min inside-edge radius).
- Profile with auto-fit grade and vertical curves; cross-section at the cursor; Plan and 3D (proposed vs existing, vertical ×).
- Quantities: cut / fill (compacted) / fill hauled (+25 %) / surplus dirt / rock tons / 20-ton loads / footprint.
- Exports: Shapefile (WGS84 lines for Ops Center), KML, DXF (3D polylines, UTM), LandXML (alignments, profiles, design surface), GeoJSON. Guidance options: centerline, driving edges, shoulder edges, offset passes, pass spacing, run-in/run-out.

### 1.2 Source data mapped from the US to France

| Reference (US)                | Sillon (France), verified against the live Géoplateforme                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USGS 3DEP 1 m DEM             | LiDAR HD MNT 0.5 m: WMS-R `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` (native) / `.WGS84G`, `image/x-bil;bits=32`, LE float32, no-data −9999 |
| Gap fill                      | `IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G` (LiDAR HD, else RGE ALTI®)                                                                                       |
| 3DEP flight metadata ("QL 1") | WFS `IGNF_LIDAR-HD_METADONNEE:metadata`: per-km² dates, sensor, point count, COPC URL, MNT/MNS/MNH GeoTIFF URLs                                             |
| Esri World Imagery            | IGN BD ORTHO® (`ORTHOIMAGERY.ORTHOPHOTOS`, z ≤ 19), infrared colour (`.IRC`), Esri kept as an option                                                        |
| Server shaded relief          | WMTS `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW` (z ≤ 18)                                                                                    |
| Hand-drawn field boundary     | RPG `RPG.LATEST:parcelles_graphiques` (declared farm fields with crop codes), cadastre `CADASTRALPARCELS.PARCELLAIRE_EXPRESS`                               |
| Geocoder                      | `data.geopf.fr/geocodage/search` (returns Lambert-93 x/y too)                                                                                               |
| Raw point cloud               | LiDAR HD COPC LAZ, about 10–14 pts/m², classified                                                                                                           |
| Vertical datum NAVD88, ft     | NGF-IGN69 (IGN69 heights), metres; feet available as a display unit                                                                                         |
| Machine CRS (UTM)             | Lambert-93 (EPSG:2154) for analysis; RGF93 CC zones / UTM 31N on export                                                                                     |

All of these send `Access-Control-Allow-Origin: *` and need no key.

## 2. Architecture

```
IGN Géoplateforme ──WMS-R BIL──▶ DEM service worker ──Terrarium PNG {z}/{x}/{y}──▶ Navara raster-dem
                                   (src/sw, Cache API)                              ├ terrain mesh
                  ──WMS-R BIL (EPSG:2154)──▶ loadElevationGrid ──▶ ElevationGrid ─▶ analysis kernels
                  ──WMTS──▶ imagery / IGN shaded relief / point classes (raster-tile)
                  ──WFS───▶ LiDAR HD metadata, RPG fields
```

- **Display path**: Navara's `raster-dem` source only takes `{x}/{y}/{z}` RGB tiles. The service worker answers `/__sillon/dem/{product}/{size}/{z}/{x}/{y}.png`: it fetches the tile's EPSG:3857 bbox as float32 and re-encodes it as Terrarium (1/256 m steps). The engine itself is unchanged.
- **Analysis path**: `ElevationGrid` is a north-up Lambert-93 raster aligned on IGN's native 0.5 m cells, fetched in 1 km blocks with NaN for no-data. Every later kernel (cut/fill, drainage, design, exports) reads from it.
- **Overlay path** (from S2): analysis rasters (cut/fill, ponding, flow accumulation) are posted to the same service worker, which serves them as coloured `raster-tile` tiles, so results drape over the terrain like any basemap.

## 3. Sprint chain

Each sprint runs a fixed chain of agents with explicit hand-offs, so it can run unattended and be
resumed:

1. **Spec agent** (Plan): reads this file's sprint section and the code, then writes the task
   breakdown, module interfaces and acceptance scenarios into the sprint PR description.
2. **Implementer agents** (parallel, one git worktree each): pure kernels with unit tests in one
   lane, UI and Navara integration in another. Kernels never import the engine.
3. **Verifier agent**: `pnpm -C web/sillon test`, `test:live`, `lint:check`, `format:check`,
   `build`; drives the acceptance scenarios in headless Chromium and attaches screenshots.
4. **Reviewer agent** (`/code-review`): correctness pass; fixes go back to lane 2.
5. **Hand-off**: update the sprint's status here, list the follow-ups, and open the PR.

Definition of done for every sprint: unit tests for all new kernels, a live test against IGN for
every new endpoint, a screenshot of each acceptance scenario, and no engine regressions
(`cargo make test` when Rust changes).

### S1 — Core LiDAR data and imagery ✅

The IGN data layer and a Navara map shell.

- Lambert-93 projection (matches PROJ to the mm), Web-Mercator tile math.
- WMS-R/WMTS URL builders, a fetch wrapper with timeout and backoff that surfaces OGC exceptions.
- BIL float32 decoding (no-data → NaN), Terrarium encoding, an exact PNG encoder.
- DEM service worker bridge with a Cache API store; only France is requested, z ≥ 8. When IGN answers 5xx or times out (cold-cache 504s happen on low-zoom LiDAR mosaics), the tile falls back to RGE ALTI® and is not cached.
- `loadElevationGrid`: native 0.5 m Lambert-93 grid in 1 km blocks, progress and abort; sampling, stats, percentiles.
- LiDAR HD acquisition metadata (dates, sensor, density, COPC link); IGN geocoder.
- Imagery catalog: BD ORTHO®, IRC, Esri; LiDAR overlays: IGN shaded relief, point classes.
- Verified: 72 unit tests, 9 live tests against data.geopf.fr and Esri, and a headless Chromium walkthrough (393 DEM tiles, none failed; a 649 ha native grid in about 4 s).
- App: terrain from LiDAR HD, imagery picker, LiDAR rendering (elevation colour with auto range, hillshade, IGN shade, classes), LiDAR opacity, height stretch, plan/3D, cursor readout (m, lat/lng, L93), acquisition badge, go-to, "Load LiDAR grid for view".

### S2 — App shell and field definition

- State store (field, surfaces, settings), units (m/ft, ha/ac), FR/EN strings, a mobile bottom sheet, and the left rail from the workstation (Field · Surface · Paths · Water · Irrigate · Job · Export).
- Field: draw/edit a polygon with numbered vertex handles; **pick an RPG field with one click** (WFS `RPG.LATEST:parcelles_graphiques`, crop code shown); cadastre overlay; import/export GeoJSON/KML.
- Grid masked to the field (scanline polygon rasterisation); area, elevation range, relief.
- Elevation profile tool (polyline → sampled profile chart).
- Overlay tile server in the service worker (`/__sillon/overlay/{id}/...`) with grid → colour LUT.
- Persistence in IndexedDB; offline re-open of a visited field.
- Accept: pick a Camargue rice field and get its area within 1 % of the RPG `surf_parc`, plus a profile across it.

### S3 — Surface design: cut/fill

- Best-fit plane (least squares, volume-balanced) with slope % and heading; locked slope/heading; a two-way slope plane; a zero-slope plane for rice basins.
- Cut/fill per cell → volumes (m³, yd³), cut:fill ratio with shrink/swell, cut per ha, max cut/fill, balance solve (offset for a target ratio).
- Existing and design contours (marching squares) as GeoJSON layers; cut/fill colour styles and band width; flow arrow along the design slope.
- Readout: `cut 0.10 m (design 1.42)`.
- Accept: the volumes of a synthetic tilted plane equal the analytic value to 0.1 %.

### S4 — Drainage and ponding

- Priority-flood depression filling, D8 and D∞ directions, flow accumulation (in a worker).
- Drainage network above a threshold, drawn thicker downstream; outlets on the field boundary with contributing area; standing-water depth = filled − DTM; ponded area and volume.
- Accept: on a synthetic V-valley all flow reaches one outlet and the contributing area equals the field area.

### S5 — Paths: drains, ditches, levees, hippers

- "Find drain paths" with the balance slider semantics (pond threshold, sweep spacing, minimum spacing, merge distance).
- Least-cost connection to outlets; non-rising invert design; cut depth along the path; uphill stretches flagged; per-drain list; station values; profile view.
- Rice levees on contour intervals (Camargue basins); hipper/planting lines at a set track spacing.
- Accept: every generated drain has a non-increasing invert, and the uphill report matches its profile.

### S6 — 3D and rain simulation

- Existing vs design surface in 3D with height stretch.
- Rain on a shallow-water grid (GPU ping-pong or worker): rate mm/h, duration, speed; depth colour, flow streamlines; HUD (rain fallen, area over 25 mm, deepest, ran off, on field).
- Accept: with no outlet, a closed basin holds rain volume minus 0 to 1 %.

### S7 — Reports and machine exports

- PDF cut sheet; CSV grids (existing, design); GeoJSON/KML/Shapefile/DXF/LandXML (surface TIN, alignments).
- Machine formats for land-levelling controllers (Trimble, John Deere, Topcon, Ag Leader): points with design elevation, boundary, benchmark.
- CRS: Lambert-93, RGF93 CC zones, UTM 31N; vertical NGF-IGN69 ↔ ellipsoidal heights for RTK (RAF20 grid).
- Accept: the LandXML and Shapefile outputs open in QGIS on the right spot, and a round trip changes no elevation by more than 1 mm.

### S8 — LiDAR HD point cloud

- Stream the COPC LAZ tiles under the field (HTTP range requests, laz-perf), view classified points in Navara.
- Rebuild a custom ground grid (class 2) at 0.25 m; MNS/MNH for tree lines, buildings and levee crests.
- Accept: the custom ground grid agrees with the IGN MNT to RMS < 5 cm on open ground.

### S9 — Irrigation and job costing

- Rice basin flooding (levee heights, water depth), furrow/flood run lengths, pivot fit.
- Earthmoving: mass-haul assignment (cut → fill transport problem), haul distances, scraper loads, hours, € cost per ha.

### S10 — Hardening

- Hot kernels moved to Rust/WASM inside the Navara workspace where the profile justifies it.
- PWA offline packs; validation against RTK survey shots; e2e scenarios in CI; user and developer docs.
