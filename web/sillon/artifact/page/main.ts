import maplibregl, {
  type ExpressionSpecification,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";

import {
  formatAcquisition,
  formatHeight,
  formatLngLat,
} from "../../src/app/format";
import {
  RELIEF_STOPS,
  reliefCss,
  reliefGradientCss,
} from "../../src/app/relief";
import {
  percentiles,
  sampleGrid,
  type ElevationGrid,
} from "../../src/dem/elevationGrid";
import { fieldSurface, type LngLatPolygon } from "../../src/dem/fieldMask";
import { hillshade } from "../../src/dem/hillshade";
import { encodePngRgb } from "../../src/dem/png";
import { encodeTerrarium } from "../../src/dem/terrarium";
import {
  lambert93ToLngLat,
  lngLatLatticeToLambert93,
  lngLatToLambert93,
  type LngLat,
} from "../../src/geo/lambert93";
import { mercatorToLngLat, tileBboxMercator } from "../../src/geo/webMercator";
import { parseLatLng } from "../../src/ign/geocode";
import {
  summarizeAcquisition,
  type LngLatBounds,
} from "../../src/ign/lidarMetadata";
import {
  decodeGrid,
  fromBase64,
  type PackGrid,
  type PackManifest,
  type PackTileLayer,
} from "../pack";

/*
 * Sillon, artifact edition. The page may fetch only its own files, so the
 * IGN data comes from a baked field pack published beside it, and a
 * `sillon://` protocol serves MapLibre its tiles: imagery from the pack's
 * bundles, terrain as Terrarium tiles generated here from the LiDAR grid.
 */

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const ui = {
  panel: $("panel"),
  collapse: $<HTMLButtonElement>("collapse"),
  status: $("status"),
  packName: $("pack-name"),
  gotoForm: $<HTMLFormElement>("goto-form"),
  goto: $<HTMLInputElement>("goto"),
  imagery: $<HTMLSelectElement>("imagery"),
  viewPlan: $<HTMLButtonElement>("view-plan"),
  view3d: $<HTMLButtonElement>("view-3d"),
  fieldsOn: $<HTMLInputElement>("fields-on"),
  mode: $<HTMLSelectElement>("mode"),
  opacity: $<HTMLInputElement>("opacity"),
  opacityOut: $("opacity-out"),
  stretch: $<HTMLInputElement>("stretch"),
  stretchOut: $("stretch-out"),
  legend: $("legend"),
  ramp: $("ramp"),
  fit: $<HTMLButtonElement>("fit"),
  rangeMin: $("range-min"),
  rangeMax: $("range-max"),
  fieldCard: $("field-card"),
  fieldHint: $("field-hint"),
  fieldCrop: $("field-crop"),
  fieldArea: $("field-area"),
  fieldRange: $("field-range"),
  fieldRelief: $("field-relief"),
  fieldMean: $("field-mean"),
  fieldFit: $<HTMLButtonElement>("field-fit"),
  fieldClear: $<HTMLButtonElement>("field-clear"),
  analyse: $<HTMLButtonElement>("analyse"),
  gridInfo: $("grid-info"),
  packInfo: $("pack-info"),
  readout: $("readout"),
  badge: $("badge"),
};

const setStatus = (text: string, kind: "info" | "error" = "info") => {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
};

// ── Pack loading ────────────────────────────────────────────────────────────

const loadGrid = async ({
  file,
  scale,
  ...layout
}: PackGrid): Promise<ElevationGrid> => {
  const res = await fetch(file);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const deflated = fromBase64(await res.text());
  const inflated = await new Response(
    new Blob([deflated as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate")),
  ).arrayBuffer();
  return {
    ...layout,
    data: decodeGrid(new Uint8Array(inflated), layout.width, scale),
  };
};

const bundles = new Map<string, Promise<ArrayBuffer>>();
const bundle = (file: string) => {
  let p = bundles.get(file);
  if (!p) {
    p = fetch(file).then(async (r) => {
      if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
      return fromBase64(await r.text()).buffer as ArrayBuffer;
    });
    bundles.set(file, p);
  }
  return p;
};

// ── Tile protocol ───────────────────────────────────────────────────────────

const TRANSPARENT_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
).buffer;

const packTile = async (
  layer: PackTileLayer,
  z: number,
  x: number,
  y: number,
) => {
  const entry = layer.tiles[`${z}/${x}/${y}`];
  if (!entry) return null;
  const [b, offset, length] = entry;
  return (await bundle(layer.bundles[b])).slice(offset, offset + length);
};

/** Outside the pack's detailed area, cut the tile out of the nearest baked ancestor. */
const ancestorTile = async (
  layer: PackTileLayer,
  z: number,
  x: number,
  y: number,
) => {
  for (let dz = 1; dz <= Math.min(8, z - layer.minZoom); dz++) {
    const parent = await packTile(layer, z - dz, x >> dz, y >> dz);
    if (!parent) continue;
    const size = 256 / 2 ** dz;
    const bitmap = await createImageBitmap(
      new Blob([parent]),
      (x - ((x >> dz) << dz)) * size,
      (y - ((y >> dz) << dz)) * size,
      size,
      size,
      { resizeWidth: 256, resizeHeight: 256, resizeQuality: "high" },
    );
    const canvas = new OffscreenCanvas(256, 256);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await canvas.convertToBlob({
      type: layer.format === "png" ? "image/png" : "image/jpeg",
      quality: 0.9,
    });
    return blob.arrayBuffer();
  }
  return null;
};

type Grids = { fine: ElevationGrid; context: ElevationGrid };

/** LiDAR HD where the 1 m grid has it, the 20 m context grid elsewhere. */
const heightAt = (g: Grids, p: { x: number; y: number }) => {
  const fine = sampleGrid(g.fine, p);
  if (!Number.isNaN(fine)) return { h: fine, source: "LiDAR HD 1 m" };
  const ctx = sampleGrid(g.context, p);
  if (!Number.isNaN(ctx)) return { h: ctx, source: "context 20 m" };
  return null;
};

/**
 * Heights on a tile's pixel centres, plus `border` pixels around it, from
 * the LiDAR grid where it has data and the context grid elsewhere.
 */
const tileHeights = (
  g: Grids,
  z: number,
  x: number,
  y: number,
  size: number,
  border = 0,
) => {
  const b = tileBboxMercator({ z, x, y });
  const step = (b.maxX - b.minX) / size;
  const n = size + 2 * border;
  const lngs = Float64Array.from(
    { length: n },
    (_, i) => mercatorToLngLat(b.minX + (i - border + 0.5) * step, 0).lng,
  );
  const lats = Float64Array.from(
    { length: n },
    (_, j) => mercatorToLngLat(0, b.maxY - (j - border + 0.5) * step).lat,
  );
  const { xs, ys } = lngLatLatticeToLambert93(lngs, lats);
  const heights = new Float32Array(n * n);
  for (let k = 0; k < heights.length; k++) {
    const p = { x: xs[k], y: ys[k] };
    const fine = sampleGrid(g.fine, p);
    heights[k] = Number.isNaN(fine) ? sampleGrid(g.context, p) : fine;
  }
  // Ground metres per pixel at the tile's middle latitude.
  const cell = step * Math.cos((lats[n >> 1] * Math.PI) / 180);
  return { heights, cell };
};

const demTile = async (g: Grids, z: number, x: number, y: number) => {
  const { heights } = tileHeights(g, z, x, y, 256);
  return (await encodePngRgb(encodeTerrarium(heights), 256, 256))
    .buffer as ArrayBuffer;
};

/** Grey relief, 4× vertical: the delta's 1–2 m levees and ditches stand out. */
const hillshadeTile = async (g: Grids, z: number, x: number, y: number) => {
  const { heights, cell } = tileHeights(g, z, x, y, 256, 1);
  const shade = hillshade(heights, 256, 256, cell, { zFactor: 4 });
  const rgb = new Uint8Array(256 * 256 * 3);
  for (let k = 0; k < shade.length; k++) {
    const v = Number.isNaN(shade[k]) ? 0.7 : shade[k];
    // A faint warm cast keeps the grey from reading as cold concrete.
    rgb[k * 3] = Math.min(255, Math.round(v * 255 + 6));
    rgb[k * 3 + 1] = Math.min(255, Math.round(v * 255 + 3));
    rgb[k * 3 + 2] = Math.round(v * 255);
  }
  return (await encodePngRgb(rgb, 256, 256)).buffer as ArrayBuffer;
};

const demCache = new Map<string, Promise<ArrayBuffer>>();

const installProtocol = (pack: PackManifest, grids: Promise<Grids>) => {
  maplibregl.addProtocol("sillon", async ({ url }) => {
    const m = /^sillon:\/\/(\w+)\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    if (!m) throw new Error(`bad tile url ${url}`);
    const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
    if (m[1] === "dem" || m[1] === "hillshade") {
      const make = m[1] === "dem" ? demTile : hillshadeTile;
      const key = `${m[1]}/${z}/${x}/${y}`;
      let tile = demCache.get(key);
      if (!tile) {
        tile = grids.then((g) => make(g, z, x, y));
        demCache.set(key, tile);
        if (demCache.size > 800)
          demCache.delete(demCache.keys().next().value as string);
      }
      return { data: await tile };
    }
    const layer = pack.layers[m[1] as keyof PackManifest["layers"]];
    if (!layer) throw new Error(`unknown layer ${m[1]}`);
    const data =
      (await packTile(layer, z, x, y)) ?? (await ancestorTile(layer, z, x, y));
    return { data: data ?? TRANSPARENT_PNG };
  });
};

// ── Map ─────────────────────────────────────────────────────────────────────

type Mode = "relief" | "hillshade" | "ign-shade" | "off";

const state = {
  mode: "relief" as Mode,
  opacity: 0.7,
  range: { min: -0.5, max: 2.5 },
  autoRange: true,
  selected: -1,
  field: null as null | { p1: number; p99: number },
};

const reliefExpression = (
  min: number,
  max: number,
): ExpressionSpecification => {
  const span = Math.max(max - min, 0.01);
  const stops = RELIEF_STOPS.flatMap((c, i) => [
    min + (span * i) / (RELIEF_STOPS.length - 1),
    reliefCss(c),
  ]);
  return [
    "interpolate",
    ["linear"],
    ["elevation"],
    ...stops,
  ] as ExpressionSpecification;
};

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const bboxPolygon = (b: LngLatBounds): GeoJSON.Feature => ({
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [b.west, b.south],
        [b.east, b.south],
        [b.east, b.north],
        [b.west, b.north],
        [b.west, b.south],
      ],
    ],
  },
});

const buildStyle = (
  pack: PackManifest,
  fields: GeoJSON.FeatureCollection,
): StyleSpecification => {
  const bounds: [number, number, number, number] = [
    pack.context.west,
    pack.context.south,
    pack.context.east,
    pack.context.north,
  ];
  const raster = (id: string, layer: PackTileLayer) => ({
    type: "raster" as const,
    tiles: [`sillon://${id}/{z}/{x}/{y}`],
    tileSize: 256,
    minzoom: layer.minZoom,
    maxzoom: layer.maxZoom,
    bounds,
  });
  const dem = (maxzoom: number) => ({
    type: "raster-dem" as const,
    tiles: ["sillon://dem/{z}/{x}/{y}"],
    tileSize: 256,
    encoding: "terrarium" as const,
    minzoom: 8,
    maxzoom,
    bounds,
  });
  return {
    version: 8,
    sources: {
      // Terrain and the DEM-drawn layers get separate sources, as MapLibre advises.
      terrain: dem(16),
      relief: dem(17),
      ortho: raster("ortho", pack.layers.ortho),
      irc: raster("irc", pack.layers.irc),
      shade: raster("shade", pack.layers.shade),
      hillshade: {
        type: "raster",
        tiles: ["sillon://hillshade/{z}/{x}/{y}"],
        tileSize: 256,
        minzoom: 8,
        maxzoom: 17,
        bounds,
      },
      fields: { type: "geojson", data: fields },
      pack: { type: "geojson", data: bboxPolygon(pack.core) },
    },
    layers: [
      {
        id: "ground",
        type: "background",
        paint: { "background-color": cssVar("--ground") || "#101413" },
      },
      { id: "ortho", type: "raster", source: "ortho" },
      {
        id: "irc",
        type: "raster",
        source: "irc",
        layout: { visibility: "none" },
      },
      {
        id: "relief",
        type: "color-relief",
        source: "relief",
        paint: {
          "color-relief-color": reliefExpression(
            state.range.min,
            state.range.max,
          ),
          "color-relief-opacity": state.opacity,
        },
      },
      {
        id: "hillshade",
        type: "raster",
        source: "hillshade",
        layout: { visibility: "none" },
      },
      {
        id: "ign-shade",
        type: "raster",
        source: "shade",
        layout: { visibility: "none" },
      },
      {
        id: "fields-hit",
        type: "fill",
        source: "fields",
        paint: { "fill-color": "#000000", "fill-opacity": 0.01 },
      },
      {
        id: "fields-line",
        type: "line",
        source: "fields",
        paint: {
          "line-color": "#f6ecc4",
          "line-width": 1.2,
          "line-opacity": 0.85,
        },
      },
      {
        id: "field-selected",
        type: "line",
        source: "fields",
        filter: ["==", ["get", "fid"], -1],
        paint: { "line-color": "#ffcf3f", "line-width": 3.2 },
      },
      {
        id: "pack-edge",
        type: "line",
        source: "pack",
        paint: {
          "line-color": "#ffffff",
          "line-width": 1.4,
          "line-dasharray": [3, 2],
          "line-opacity": 0.75,
        },
      },
    ],
    terrain: { source: "terrain", exaggeration: 1 },
  };
};

const applyLidar = (map: MapLibreMap) => {
  const show = (id: string, on: boolean) =>
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("relief", state.mode === "relief");
  show("hillshade", state.mode === "hillshade");
  show("ign-shade", state.mode === "ign-shade");
  map.setPaintProperty("relief", "color-relief-opacity", state.opacity);
  map.setPaintProperty("ign-shade", "raster-opacity", state.opacity);
  map.setPaintProperty("hillshade", "raster-opacity", state.opacity);
  ui.legend.hidden = state.mode !== "relief";
};

const applyRange = (map: MapLibreMap, min: number, max: number) => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return;
  if (max - min < 0.05) [min, max] = [min - 0.025, max + 0.025];
  state.range = { min, max };
  map.setPaintProperty(
    "relief",
    "color-relief-color",
    reliefExpression(min, max),
  );
  ui.rangeMin.textContent = min.toFixed(2);
  ui.rangeMax.textContent = max.toFixed(2);
};

/** Heights under a lattice of screen points: what the colour ramp is applied to. */
const viewHeights = (map: MapLibreMap, g: Grids, n = 20) => {
  const { width, height } = map.getCanvas().getBoundingClientRect();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const ll = map.unproject([
        (width * (i + 0.5)) / n,
        (height * (j + 0.5)) / n,
      ]);
      const s = heightAt(g, lngLatToLambert93({ lng: ll.lng, lat: ll.lat }));
      if (s) out.push(s.h);
    }
  }
  return out;
};

const polygonsOf = (f: GeoJSON.Feature): LngLatPolygon[] => {
  const g = f.geometry;
  const toRings = (poly: GeoJSON.Position[][]) =>
    poly.map((ring) => ring.map(([lng, lat]) => ({ lng, lat })));
  if (g.type === "Polygon") return [toRings(g.coordinates)];
  if (g.type === "MultiPolygon") return g.coordinates.map(toRings);
  return [];
};

const lidarBadge = (pack: PackManifest, centre: LngLat | null) => {
  if (!centre) return "";
  const { x, y } = lngLatToLambert93(centre);
  const id = `${String(Math.floor(x / 1000)).padStart(4, "0")}_${String(Math.ceil(y / 1000)).padStart(4, "0")}`;
  const tile = pack.lidarTiles.find((t) => t.tileId === id);
  if (!tile)
    return "Outside the LiDAR pack · context terrain at 20 m (LiDAR HD + RGE ALTI®)";
  const summary = summarizeAcquisition([tile]);
  return summary ? `${formatAcquisition(summary)} · tile ${id}` : "";
};

const start = async () => {
  ui.ramp.style.background = reliefGradientCss();
  ui.collapse.addEventListener("click", () => {
    const collapsed = ui.panel.classList.toggle("collapsed");
    ui.collapse.setAttribute("aria-expanded", String(!collapsed));
  });

  let pack: PackManifest;
  let fields: GeoJSON.FeatureCollection;
  try {
    pack = (await (await fetch("pack.json")).json()) as PackManifest;
    fields = (await (
      await fetch(pack.rpg)
    ).json()) as GeoJSON.FeatureCollection;
  } catch (e) {
    setStatus(
      `The field pack did not load: ${e instanceof Error ? e.message : e}`,
      "error",
    );
    return;
  }
  fields.features.forEach((f, i) => {
    f.properties = { ...f.properties, fid: i };
  });
  ui.packName.textContent = `${pack.name} · LiDAR HD`;
  ui.packInfo.textContent =
    `Offline pack of IGN Géoplateforme data, baked ${pack.bakedAt}: LiDAR HD terrain at 1 m over 3 × 3 km ` +
    `(${pack.place}), 20 m context over 24 km, BD ORTHO® to zoom 18, infrared to 17, ` +
    `${fields.features.length} RPG fields. Licence Ouverte 2.0.`;

  const gridsPromise = Promise.all([
    loadGrid(pack.grids.fine),
    loadGrid(pack.grids.context),
  ]).then(([fine, context]) => ({ fine, context }));
  installProtocol(pack, gridsPromise);

  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle(pack, fields),
    center: [pack.centre.lng, pack.centre.lat],
    zoom: 15.2,
    maxPitch: 80,
    maxBounds: [
      [pack.context.west - 0.05, pack.context.south - 0.05],
      [pack.context.east + 0.05, pack.context.north + 0.05],
    ] as LngLatBoundsLike,
    attributionControl: false,
  });
  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    "top-right",
  );
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "top-right");
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution:
        "© IGN Géoplateforme: LiDAR HD, BD ORTHO®, RPG · MapLibre",
    }),
    "bottom-right",
  );

  let grids: Grids;
  try {
    grids = await gridsPromise;
  } catch (e) {
    setStatus(
      `The LiDAR grid did not load: ${e instanceof Error ? e.message : e}`,
      "error",
    );
    return;
  }
  await new Promise<void>((resolve) =>
    map.loaded() ? resolve() : map.once("load", () => resolve()),
  );
  setStatus("");
  applyLidar(map);

  const fitView = () => {
    if (!state.autoRange) return;
    const [lo, hi] = percentiles(viewHeights(map, grids), [0.01, 0.99]);
    applyRange(map, lo, hi);
  };
  const onSettled = () => {
    fitView();
    const c = map.getCenter();
    ui.badge.textContent = lidarBadge(pack, { lng: c.lng, lat: c.lat });
  };
  map.on("moveend", onSettled);
  onSettled();

  // Map controls
  ui.gotoForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ui.goto.value.trim();
    const l93 = text.match(/^(\d{6}(?:\.\d+)?)[\s,;]+(\d{7}(?:\.\d+)?)$/);
    const target = l93
      ? lambert93ToLngLat({ x: Number(l93[1]), y: Number(l93[2]) })
      : parseLatLng(text);
    if (!target)
      return setStatus(
        "Enter “lat, lng” (43.585, 4.553) or Lambert-93 “x y” (825500 6277500).",
        "error",
      );
    const c = pack.context;
    if (
      target.lng < c.west ||
      target.lng > c.east ||
      target.lat < c.south ||
      target.lat > c.north
    ) {
      return setStatus(
        `That point is outside this offline pack, which covers ${c.south.toFixed(2)}–${c.north.toFixed(2)}° N, ` +
          `${c.west.toFixed(2)}–${c.east.toFixed(2)}° E.`,
        "error",
      );
    }
    setStatus("");
    map.flyTo({ center: [target.lng, target.lat], zoom: 16.5, duration: 1500 });
  });

  ui.imagery.addEventListener("change", () => {
    map.setLayoutProperty(
      "ortho",
      "visibility",
      ui.imagery.value === "ortho" ? "visible" : "none",
    );
    map.setLayoutProperty(
      "irc",
      "visibility",
      ui.imagery.value === "irc" ? "visible" : "none",
    );
  });

  const setView = (mode: "plan" | "3d") => {
    ui.viewPlan.classList.toggle("on", mode === "plan");
    ui.view3d.classList.toggle("on", mode === "3d");
    ui.viewPlan.setAttribute("aria-pressed", String(mode === "plan"));
    ui.view3d.setAttribute("aria-pressed", String(mode === "3d"));
    map.easeTo(
      mode === "plan"
        ? { pitch: 0, bearing: 0, duration: 1000 }
        : { pitch: 62, bearing: -25, duration: 1000 },
    );
  };
  ui.viewPlan.addEventListener("click", () => setView("plan"));
  ui.view3d.addEventListener("click", () => setView("3d"));

  ui.fieldsOn.addEventListener("change", () => {
    for (const id of ["fields-hit", "fields-line", "field-selected"]) {
      map.setLayoutProperty(
        id,
        "visibility",
        ui.fieldsOn.checked ? "visible" : "none",
      );
    }
  });

  // LiDAR controls
  ui.mode.addEventListener("change", () => {
    state.mode = ui.mode.value as Mode;
    applyLidar(map);
  });
  ui.opacity.addEventListener("input", () => {
    state.opacity = Number(ui.opacity.value) / 100;
    ui.opacityOut.textContent = `${ui.opacity.value} %`;
    applyLidar(map);
  });
  ui.stretch.addEventListener("input", () => {
    ui.stretchOut.textContent = `${ui.stretch.value}×`;
    map.setTerrain({
      source: "terrain",
      exaggeration: Number(ui.stretch.value),
    });
  });
  ui.fit.addEventListener("click", () => {
    state.autoRange = true;
    fitView();
  });

  // Cursor readout
  const readout = (lng: number, lat: number) => {
    const p = lngLatToLambert93({ lng, lat });
    const s = heightAt(grids, p);
    ui.readout.hidden = false;
    ui.readout.textContent =
      `${s ? `${formatHeight(s.h)} (${s.source})` : "no data"} · ${formatLngLat(lng, lat)} · ` +
      `L93 ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  };
  map.on("mousemove", (e: MapMouseEvent) =>
    readout(e.lngLat.lng, e.lngLat.lat),
  );
  map
    .getCanvas()
    .addEventListener("mouseleave", () => (ui.readout.hidden = true));

  // Fields
  const showField = (fid: number) => {
    const f = fields.features[fid];
    const props = f.properties as {
      crop: string;
      code: string;
      ha: number;
      organic: boolean;
    };
    const s = fieldSurface(grids.fine, polygonsOf(f));
    state.selected = fid;
    map.setFilter("field-selected", ["==", ["get", "fid"], fid]);
    ui.fieldHint.hidden = true;
    ui.fieldCard.hidden = false;
    ui.fieldCrop.textContent = `${props.crop} (${props.code})${props.organic ? " · organic" : ""}`;
    if (!s) {
      ui.fieldArea.textContent = `${props.ha} ha declared`;
      ui.fieldRange.textContent = "outside the 1 m LiDAR grid";
      ui.fieldRelief.textContent = ui.fieldMean.textContent = "–";
      state.field = null;
      return;
    }
    ui.fieldArea.textContent = `${s.areaHa.toFixed(2)} ha measured · ${props.ha} ha declared`;
    ui.fieldRange.textContent = `${formatHeight(s.min)} to ${formatHeight(s.max)}`;
    ui.fieldRelief.textContent = `${formatHeight(s.max - s.min)} (${formatHeight(s.p99 - s.p1)} without ditches)`;
    ui.fieldMean.textContent = formatHeight(s.mean);
    state.field = { p1: s.p1, p99: s.p99 };
  };
  map.on("click", "fields-hit", (e) => {
    const fid = e.features?.[0]?.properties?.fid;
    if (typeof fid === "number") showField(fid);
  });
  map.on("click", (e) => readout(e.lngLat.lng, e.lngLat.lat));
  map.on(
    "mouseenter",
    "fields-hit",
    () => (map.getCanvas().style.cursor = "pointer"),
  );
  map.on("mouseleave", "fields-hit", () => (map.getCanvas().style.cursor = ""));
  ui.fieldFit.addEventListener("click", () => {
    if (!state.field) return;
    state.autoRange = false;
    if (state.mode !== "relief") {
      ui.mode.value = state.mode = "relief";
      applyLidar(map);
    }
    applyRange(map, state.field.p1, state.field.p99);
  });
  ui.fieldClear.addEventListener("click", () => {
    state.selected = -1;
    state.field = null;
    map.setFilter("field-selected", ["==", ["get", "fid"], -1]);
    ui.fieldCard.hidden = true;
    ui.fieldHint.hidden = false;
    state.autoRange = true;
    fitView();
  });

  // Data
  ui.analyse.addEventListener("click", () => {
    const hs = viewHeights(map, grids, 60);
    const fine = (() => {
      const b = map.getBounds();
      const corners = [
        lngLatToLambert93({ lng: b.getWest(), lat: b.getSouth() }),
        lngLatToLambert93({ lng: b.getEast(), lat: b.getNorth() }),
      ];
      const g = grids.fine;
      const c0 = Math.max(
        0,
        Math.floor(
          (Math.min(corners[0].x, corners[1].x) - g.originX) / g.cellSize,
        ),
      );
      const c1 = Math.min(
        g.width - 1,
        Math.ceil(
          (Math.max(corners[0].x, corners[1].x) - g.originX) / g.cellSize,
        ),
      );
      const r0 = Math.max(
        0,
        Math.floor(
          (g.originY - Math.max(corners[0].y, corners[1].y)) / g.cellSize,
        ),
      );
      const r1 = Math.min(
        g.height - 1,
        Math.ceil(
          (g.originY - Math.min(corners[0].y, corners[1].y)) / g.cellSize,
        ),
      );
      let n = 0;
      let lo = Infinity;
      let hi = -Infinity;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const v = g.data[r * g.width + c];
          if (Number.isNaN(v)) continue;
          n++;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      return { n, lo, hi };
    })();
    const [p1, p50, p99] = percentiles(hs, [0.01, 0.5, 0.99]);
    ui.gridInfo.textContent = fine.n
      ? [
          `${fine.n.toLocaleString("en-GB")} LiDAR cells of 1 m in view (${(fine.n / 1e4).toFixed(1)} ha)`,
          `${formatHeight(fine.lo)} to ${formatHeight(fine.hi)} · relief ${formatHeight(fine.hi - fine.lo)}`,
          `Median ${formatHeight(p50)} · 1–99 % ${formatHeight(p1)} to ${formatHeight(p99)}`,
          "Heights NGF-IGN69, Lambert-93 grid (EPSG:2154)",
        ].join("\n")
      : "No 1 m LiDAR cells in view. Pan to the dashed square.";
  });
};

void start();
