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

**The wider tool family** (senterfarms.com/programs lists 30 browser tools; these are the ones that bear on Sillon)

| Tool                        | What it does                                                                                           | Sillon counterpart                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Elevation (South Shelton)   | 3D terrain with yield draped on it, sinks, flow simulation and ponding                                 | S4, S6; yield drape in S10                                                 |
| SiteRX yard planner         | LiDAR ground plus satellite, trace what stands, roads and loops, drainage, staking file for Ops Center | S5 (paths), S7 (exports)                                                   |
| Two-date drone comparison   | Two flights a year apart, aligned, with a swipe lever                                                  | IGN orthophotos by year (`ORTHOIMAGERY.ORTHOPHOTOS20xx`) with a swipe, S10 |
| One-foot yield, Rx grid map | Yield, height and loss layers; 895 prescription zones with seed rate, CEC, soil, P, K, lime            | S10                                                                        |
| Soil map, SkyRX radar       | Soil series by field; NEXRAD with rainfall totals and field boundaries                                 | S10 (soil maps, Météo-France radar as rain input to S6)                    |

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

### S2 — Field definition ✅ (artifact edition)

Built for the claude.ai artifact, where Sillon is used today; the Navara app
picks the same modules up when its shell grows a field panel.

- Field from an RPG parcel (one click, crop and declared area shown), drawn
  (numbered draggable corners, "+" to insert, double-click to remove,
  self-intersection refused), imported, or reopened from My fields.
- Field card: area (ha, ac) and perimeter from the outline; elevation, relief
  with and without ditches; **natural fall** (least-squares plane refitted
  without cells > 3 RMS off it, so ditches do not tilt it) as % toward a
  compass point, with a fall arrow on the map; evenness (RMS about the plane);
  **land-levelling volumes** to keep its fall and to dead level (rice basins).
- Elevation profile: free polyline, or one click down the fall line (along the
  long axis for a level basin); chart with a map-linked cursor, length, fall,
  grade, steepest 10 m, CSV.
- Import GeoJSON, KML, zipped shapefile (WGS84 or Lambert-93, as TELEPAC and
  Mes Parcelles export) or bare .shp; export one field or all saved fields as
  a WGS84 shapefile zip with a KML inside, or GeoJSON.
- My fields: saved per viewer in the artifact database (`data/users/<id>`),
  private to them.
- Live IGN: `sillon.field()` returns plane, slope and volumes; `sillon.profile()`
  reads only the 256 m blocks a line crosses on LiDAR HD and fills unflown
  stretches from RGE ALTI®.
- Verified: 136 unit tests (a tilted plane's fall to 0.01 %, a ditch kept out
  of the fit, shapefiles re-read by pyshp, zip CRCs); headless Chromium under
  the artifact CSP on desktop and phone, pack and live (a Camargue rice basin
  at 19.83 ha measured vs 19.83 declared; a Beauce maize field falling 0.63 %
  SE, 3.97 m over the 526 m fall line).
- Carried to later sprints: cadastre overlay and FR/EN strings (S10), ft/yd³
  units and the overlay tile server (S3).

### S3 — Surface design: cut/fill ✅ (artifact edition)

- Design surfaces for the selected field (`src/dem/design.ts`): **natural
  fall** (the robust best-fit plane of S2), **set slope** (a main fall in %
  toward a bearing plus a cross fall: a two-way plane) and **dead level**
  (rice basins). Each is balanced to a **cut:fill ratio** (1.0 to 1.5, for
  shrink and swell) by an exact histogram solve, then raised or lowered by hand
  in centimetres.
- Earthworks in ground units (the Lambert-93 scale factor applied): cut, fill,
  ratio, surplus to haul off or soil to bring in, m³/ha, mean and maximum
  depths, cut, fill and on-grade areas, and the **mean haul**. The haul is a
  lower bound: the transport distance between cut and fill projected on eight
  directions. The distance between the cut and fill centres collapses to zero
  around a best-fit plane; this bound does not.
- Map: a cut/fill raster (ember for cut, cyan for fill, 5 cm bands, on grade
  within ±2 cm), contours of the ground and of the design (marching squares on
  heights smoothed over about 2 m, automatic interval or 5 to 50 cm), the fall
  arrow and a haul wire from the cut centre to the fill centre. Elevation
  colour pauses while the cut/fill map is on.
- Readout under the cursor: `CUT 0.79 m · ground 0.87 m · design 0.08 m // …`.
- Cut sheet: a CSV of stakes on a 10 m Lambert-93 lattice (20 m over 50 ha)
  with existing, design and cut heights. GeoJSON and shapefile exports carry
  the design and its volumes.
- Live IGN: `sillon.field_grid()` sends the field's height grid (LiDAR HD, or
  RGE ALTI® where LiDAR HD covers under half the field or fails to load) at the
  finest of 0.5 to 5 m that fits 250 000 cells, as deflated int16 deltas. The
  page runs the same design on it. Edge errors (a field over 4 km², too long
  for the grid) reach the viewer as plain sentences.
- GAïa instrument UI: dark-first tokens with a bone daylight variant, imagery
  graded to the bone/ultramarine duotone, signal blue only for what is
  selected or active, ember only for intensity readings, Chakra Petch /
  JetBrains Mono, surveyor typography (true minus, narrow no-break thousands,
  DMS, L93 E/N), a link register (PACK · ACTIVE, LIVE · IDLE / ACTIVE /
  SEVERED). Full screen: native where the page may, otherwise an immersive
  layout; F toggles. The panel collapses to a spine.
- Verified: 250 unit tests, among them the analytic volumes of a field
  tilted on both axes, the ratio solve, contours, the PNG encoder, the field
  grid round trip and the haul bound. Headless Chromium under the artifact CSP,
  desktop and phone, dark and light: the Camargue "Riz" basin (19.83 ha) gives
  15 136 m³ each way on its natural fall with a mean haul of at least 166 m;
  dead level at 1.30 gives 18 912 / 14 548 m³, balanced at that ratio with
  4 364 m³ allowed for shrinkage; 0.15 % toward 120° at 1.30 holds 1.30;
  raising it 5 cm leaves 11 485 m³ to bring in; 532 contour lines; a 125 kB
  cut sheet. Live, on a Beauce field (15.25 ha, RGE ALTI® 1 m): 25 665 m³ each way
  on its natural fall and 54 352 m³ to dead level, against 25 681 / 25 641 and
  54 345 m³ measured server-side at 0.5 m. The deployed Edge Function (v6)
  matches the local handlers: identical field statistics, identical grid.
- Reviewed: an adversarial review in five dimensions (page integration, live
  data, GAïa fidelity, accessibility, artifact contract), each finding
  challenged by a second agent, confirmed 36 findings. All are fixed, among
  them the balance read against the target ratio (shrinkage is not surplus),
  the hand-set design kept when a field is measured again, the first
  data-source switch, keyboard selection of a field at a centre mark, and
  duotone shaded relief.
- Carried to later sprints: ft and yd³ units and a printable cut sheet (S7),
  design surfaces other than planes (S5).

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

### S10 — Farm data layers

- Yield maps (CSV/Shapefile from the combine) draped on terrain and checked against ponding.
- Prescription zones on a grid, with soil attributes.
- Orthophoto history by year with a swipe comparison.
- Soil maps; Météo-France radar rainfall as rain-simulation input.

### S11 — Hardening

- Hot kernels moved to Rust/WASM inside the Navara workspace where the profile justifies it.
- PWA offline packs; validation against RTK survey shots; e2e scenarios in CI; user and developer docs.
