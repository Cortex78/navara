import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type StyleSpecification,
} from "maplibre-gl";

import { formatAcquisition } from "../../src/app/format";
import {
  percentiles,
  sampleGrid,
  type ElevationGrid,
} from "../../src/dem/elevationGrid";
import { hillshade } from "../../src/dem/hillshade";
import { encodePngRgb } from "../../src/dem/png";
import { encodeTerrarium } from "../../src/dem/terrarium";
import {
  lambert93ToLngLat,
  lngLatLatticeToLambert93,
  lngLatToLambert93,
  type LngLat,
} from "../../src/geo/lambert93";
import {
  lngLatToMercator,
  lngLatToTile,
  mercatorToLngLat,
  tileBboxMercator,
} from "../../src/geo/webMercator";
import { parseLatLng, type Place } from "../../src/ign/geocode";
import {
  summarizeAcquisition,
  type LidarTileMetadata,
  type LngLatBounds,
} from "../../src/ign/lidarMetadata";
import { keyValue } from "../../supabase/keys";
import {
  decodeGrid,
  fromBase64,
  type PackGrid,
  type PackManifest,
  type PackTileLayer,
} from "../pack";

import { onActivity, track } from "./activity";
import {
  duotoneTile,
  GAIA_RELIEF,
  gaiaReliefCss,
  gaiaReliefGradient,
  MAP,
} from "./brand";
import { installWorkbench, overlayLayers, overlaySources } from "./fields";
import { installFullscreen } from "./fullscreen";
import {
  decodeDemPng,
  describeMcpError,
  LiveProxy,
  type McpLike,
} from "./live";
import { cutFillPng, surfaceLayers, surfaceSources } from "./surface";
import { grouped, height as formatHeight, l93, latLonDms } from "./units";

/*
 * Sillon, artifact edition. Two data sources:
 * - the Camargue pack, baked from IGN and published beside the page, works
 *   for every viewer;
 * - Live IGN, for all of France, goes through the viewer's Supabase
 *   connector to the sillon-tiles project (see live.ts).
 * A `sillon://` protocol serves MapLibre its tiles from either.
 */

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const ui = {
  panel: $("panel"),
  collapse: $<HTMLButtonElement>("collapse"),
  fsBtn: $<HTMLButtonElement>("fs-btn"),
  fsExit: $<HTMLButtonElement>("fs-exit"),
  linkStatus: $("link-status"),
  linkText: $("link-text"),
  boot: $("boot"),
  spine: $<HTMLButtonElement>("spine"),
  status: $("status"),
  packName: $("pack-name"),
  srcPack: $<HTMLButtonElement>("src-pack"),
  srcLive: $<HTMLButtonElement>("src-live"),
  liveStatus: $("live-status"),
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

/** Metropolitan France and Corsica: where IGN LiDAR HD and RGE ALTI® exist. */
const FRANCE: LngLatBounds = {
  west: -5.5,
  south: 41.2,
  east: 9.9,
  north: 51.2,
};

const boundsArray = (b: LngLatBounds): [number, number, number, number] => [
  b.west,
  b.south,
  b.east,
  b.north,
];
const inside = (b: LngLatBounds, p: LngLat) =>
  p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north;

// ── Pack data ───────────────────────────────────────────────────────────────

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

/**
 * Heights on a tile's pixel centres, plus `border` pixels around it, from
 * the pack's LiDAR grid where it has data and its context grid elsewhere.
 */
const packTileHeights = (
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
  return heights;
};

/** Ground metres per pixel of a 256 px tile, at the tile's middle latitude. */
const tileCellSize = (z: number, x: number, y: number) => {
  const b = tileBboxMercator({ z, x, y });
  const lat = mercatorToLngLat(0, (b.minY + b.maxY) / 2).lat;
  return ((b.maxX - b.minX) / 256) * Math.cos((lat * Math.PI) / 180);
};

/** Grey relief, 4× vertical: the delta's 1–2 m levees and ditches stand out. */
const shadePng = async (heightsWithBorder: Float32Array, cell: number) => {
  const shade = hillshade(heightsWithBorder, 256, 256, cell, { zFactor: 4 });
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

/** A one-pixel border by repeating the edge, for shading a lone tile. */
const withEdgeBorder = (h: Float32Array, n: number) => {
  const m = n + 2;
  const out = new Float32Array(m * m);
  for (let r = 0; r < m; r++) {
    const sr = Math.min(n - 1, Math.max(0, r - 1));
    for (let c = 0; c < m; c++)
      out[r * m + c] = h[sr * n + Math.min(n - 1, Math.max(0, c - 1))];
  }
  return out;
};

// ── Live data ───────────────────────────────────────────────────────────────

let live: LiveProxy | null = null;
let mcp: McpLike | null = null;

/** Recent live answers, so a tile MapLibre drops and asks again costs nothing. */
const liveCache = new Map<string, Promise<ArrayBuffer>>();
const liveBytes = (key: string) => {
  let p = liveCache.get(key);
  if (!p) {
    if (!live) return Promise.reject(new Error("live data is off"));
    p = track(live.bytes(key));
    p.catch(() => liveCache.delete(key));
    liveCache.set(key, p);
    if (liveCache.size > 900)
      liveCache.delete(liveCache.keys().next().value as string);
  }
  return p;
};

/** Decoded live elevation tiles, for the readout, the colour range and hillshade. */
const liveHeights = new Map<string, { heights: Float32Array; size: number }>();
const liveDem = async (z: number, x: number, y: number) => {
  const bytes = await liveBytes(`kind=dem&z=${z}&x=${x}&y=${y}`);
  const key = `${z}/${x}/${y}`;
  if (!liveHeights.has(key)) {
    liveHeights.set(key, await decodeDemPng(bytes.slice(0)));
    if (liveHeights.size > 160)
      liveHeights.delete(liveHeights.keys().next().value as string);
  }
  return bytes;
};

const LIVE_DEM_MAX_ZOOM = 16;

const liveHeightAt = (p: LngLat, zoom: number) => {
  const m = lngLatToMercator(p);
  // 256 px tiles are requested a level or two finer than the map zoom.
  for (let z = Math.min(LIVE_DEM_MAX_ZOOM, Math.floor(zoom) + 2); z >= 9; z--) {
    const t = lngLatToTile(p, z);
    const tile = liveHeights.get(`${z}/${t.x}/${t.y}`);
    if (!tile) continue;
    const b = tileBboxMercator(t);
    const col = Math.min(
      tile.size - 1,
      Math.floor(((m.x - b.minX) / (b.maxX - b.minX)) * tile.size),
    );
    const row = Math.min(
      tile.size - 1,
      Math.floor(((b.maxY - m.y) / (b.maxY - b.minY)) * tile.size),
    );
    return {
      h: tile.heights[row * tile.size + col],
      source: `IGN terrain, z${z}`,
    };
  }
  return null;
};

// ── Protocol ────────────────────────────────────────────────────────────────

const generated = new Map<string, Promise<ArrayBuffer>>();
const memo = (key: string, make: () => Promise<ArrayBuffer>) => {
  let tile = generated.get(key);
  if (!tile) {
    tile = make();
    tile.catch(() => generated.delete(key));
    generated.set(key, tile);
    if (generated.size > 800)
      generated.delete(generated.keys().next().value as string);
  }
  return tile;
};

const installProtocol = (pack: PackManifest, grids: Promise<Grids>) => {
  maplibregl.addProtocol("sillon", async ({ url }) => {
    const m = /^sillon:\/\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)/.exec(url);
    if (!m) throw new Error(`bad tile url ${url}`);
    const [layer, z, x, y] = [m[1], Number(m[2]), Number(m[3]), Number(m[4])];
    const key = `${layer}/${z}/${x}/${y}`;
    switch (layer) {
      case "dem":
        return {
          data: await memo(key, async () => {
            const heights = packTileHeights(await grids, z, x, y, 256);
            return (await encodePngRgb(encodeTerrarium(heights), 256, 256))
              .buffer as ArrayBuffer;
          }),
        };
      case "hillshade":
        return {
          data: await memo(key, async () =>
            shadePng(
              packTileHeights(await grids, z, x, y, 256, 1),
              tileCellSize(z, x, y),
            ),
          ),
        };
      case "live-dem":
        return { data: await liveDem(z, x, y) };
      case "live-hillshade":
        return {
          data: await memo(key, async () => {
            await liveDem(z, x, y);
            const tile = liveHeights.get(`${z}/${x}/${y}`);
            if (!tile) throw new Error("elevation tile not decoded");
            return shadePng(
              withEdgeBorder(tile.heights, tile.size),
              tileCellSize(z, x, y),
            );
          }),
        };
      case "cutfill": {
        // The design's cut/fill map, rendered by surface.ts.
        const png = cutFillPng(z);
        if (!png) throw new Error("cut/fill image expired");
        return { data: png.slice(0) };
      }
      case "ortho-duo":
        // GAïa duotone of the pack orthophoto (bone ↔ ultramarine).
        return {
          data: (
            await memo(key, async () => {
              const raw =
                (await packTile(pack.layers.ortho, z, x, y)) ??
                (await ancestorTile(pack.layers.ortho, z, x, y));
              return raw ? duotoneTile(raw) : TRANSPARENT_PNG;
            })
          ).slice(0),
        };
      case "live-ortho-duo":
        try {
          return {
            data: (
              await memo(key, async () =>
                duotoneTile(await liveBytes(`kind=ortho&z=${z}&x=${x}&y=${y}`)),
              )
            ).slice(0),
          };
        } catch {
          return { data: TRANSPARENT_PNG };
        }
      case "live-ortho":
      case "live-irc":
      case "live-shade":
        try {
          return {
            data: await liveBytes(
              `kind=${layer.slice(5)}&z=${z}&x=${x}&y=${y}`,
            ),
          };
        } catch {
          return { data: TRANSPARENT_PNG };
        }
      default: {
        const packLayer = pack.layers[layer as keyof PackManifest["layers"]];
        if (!packLayer) throw new Error(`unknown layer ${layer}`);
        const data =
          (await packTile(packLayer, z, x, y)) ??
          (await ancestorTile(packLayer, z, x, y));
        return { data: data ?? TRANSPARENT_PNG };
      }
    }
  });
};

// ── Map state ───────────────────────────────────────────────────────────────

type Mode = "relief" | "hillshade" | "ign-shade" | "off";
type Source = "pack" | "live";

const state = {
  source: "pack" as Source,
  mode: "relief" as Mode,
  imagery: "ortho",
  opacity: 0.7,
  stretch: 1,
  fieldsOn: true,
  range: { min: -0.5, max: 2.5 },
  autoRange: true,
  /** The cut/fill map is on: elevation colour pauses so it reads alone. */
  designMap: false,
};

const reliefExpression = (
  min: number,
  max: number,
): ExpressionSpecification => {
  const span = Math.max(max - min, 0.01);
  const stops = GAIA_RELIEF.flatMap((c, i) => [
    min + (span * i) / (GAIA_RELIEF.length - 1),
    gaiaReliefCss(c),
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

const emptyFields = (): GeoJSON.FeatureCollection => ({
  type: "FeatureCollection",
  features: [],
});

/** Source zoom ranges: [min, max] per layer, for the pack and for live IGN. */
const ZOOMS = {
  pack: (pack: PackManifest) => ({
    ortho: [pack.layers.ortho.minZoom, pack.layers.ortho.maxZoom],
    irc: [pack.layers.irc.minZoom, pack.layers.irc.maxZoom],
    shade: [pack.layers.shade.minZoom, pack.layers.shade.maxZoom],
    terrain: [8, 16],
    relief: [8, 17],
  }),
  live: () => ({
    ortho: [6, 19],
    irc: [6, 19],
    shade: [6, 18],
    terrain: [9, 15],
    relief: [9, LIVE_DEM_MAX_ZOOM],
  }),
};

const buildStyle = (
  source: Source,
  pack: PackManifest,
  fields: GeoJSON.FeatureCollection,
): StyleSpecification => {
  const prefix = source === "live" ? "live-" : "";
  const bounds = boundsArray(source === "live" ? FRANCE : pack.context);
  const zooms = source === "live" ? ZOOMS.live() : ZOOMS.pack(pack);
  const raster = (id: string, [minzoom, maxzoom]: number[]) => ({
    type: "raster" as const,
    tiles: [`sillon://${prefix}${id}/{z}/{x}/{y}`],
    tileSize: 256,
    minzoom,
    maxzoom,
    bounds,
  });
  const dem = ([minzoom, maxzoom]: number[]) => ({
    type: "raster-dem" as const,
    tiles: [`sillon://${prefix}dem/{z}/{x}/{y}`],
    tileSize: 256,
    encoding: "terrarium" as const,
    minzoom,
    maxzoom,
    bounds,
  });
  const hidden = { visibility: "none" as const };
  const style: StyleSpecification = {
    version: 8,
    sources: {
      // Terrain and the DEM-drawn layers get separate sources, as MapLibre advises.
      terrain: dem(zooms.terrain),
      relief: dem(zooms.relief),
      orthoDuo: raster("ortho-duo", zooms.ortho),
      ortho: raster("ortho", zooms.ortho),
      irc: raster("irc", zooms.irc),
      shade: raster("shade", zooms.shade),
      hillshade: raster("hillshade", zooms.relief),
      fields: { type: "geojson", data: fields },
      ...surfaceSources(),
      ...overlaySources(),
    },
    layers: [
      {
        id: "ground",
        type: "background",
        paint: { "background-color": cssVar("--night") || MAP.ground },
      },
      // Imagery in the GAïa duotone by default (bone highlights, ultramarine
      // shadows), so the LiDAR and the instrument's marks carry the colour.
      { id: "ortho-duo", type: "raster", source: "orthoDuo" },
      { id: "ortho", type: "raster", source: "ortho", layout: hidden },
      {
        id: "irc",
        type: "raster",
        source: "irc",
        layout: hidden,
        paint: { "raster-saturation": -0.1, "raster-brightness-max": 0.86 },
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
      { id: "hillshade", type: "raster", source: "hillshade", layout: hidden },
      { id: "ign-shade", type: "raster", source: "shade", layout: hidden },
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
          "line-color": MAP.bone,
          "line-width": 1,
          "line-opacity": 0.6,
        },
      },
    ],
    terrain: { source: "terrain", exaggeration: state.stretch },
  };
  if (source === "pack") {
    style.sources.pack = { type: "geojson", data: bboxPolygon(pack.core) };
    style.layers.push({
      id: "pack-edge",
      type: "line",
      source: "pack",
      paint: {
        "line-color": MAP.signalLight,
        "line-width": 1.4,
        "line-dasharray": [3, 2],
        "line-opacity": 0.85,
      },
    });
  }
  style.layers.push(...surfaceLayers(), ...overlayLayers());
  return style;
};

const applyLayers = (map: MapLibreMap) => {
  const show = (id: string, on: boolean) =>
    map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("ortho-duo", state.imagery === "ortho");
  show("ortho", state.imagery === "natural");
  show("irc", state.imagery === "irc");
  show("relief", state.mode === "relief" && !state.designMap);
  show("hillshade", state.mode === "hillshade");
  show("ign-shade", state.mode === "ign-shade");
  for (const id of ["fields-hit", "fields-line"]) show(id, state.fieldsOn);
  map.setPaintProperty("relief", "color-relief-opacity", state.opacity);
  map.setPaintProperty("ign-shade", "raster-opacity", state.opacity);
  map.setPaintProperty("hillshade", "raster-opacity", state.opacity);
  ui.legend.hidden = state.mode !== "relief";
  ui.legend.dataset.paused = String(state.designMap);
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

const acquisitionText = (tiles: LidarTileMetadata[], tileId?: string) => {
  const summary = summarizeAcquisition(tiles);
  if (!summary)
    return "No LiDAR HD flight record for this tile in IGN metadata";
  return `${formatAcquisition(summary)}${tileId ? ` · tile ${tileId}` : ""}`;
};

const packBadge = (pack: PackManifest, centre: LngLat) => {
  const { x, y } = lngLatToLambert93(centre);
  const id = `${String(Math.floor(x / 1000)).padStart(4, "0")}_${String(Math.ceil(y / 1000)).padStart(4, "0")}`;
  const tile = pack.lidarTiles.find((t) => t.tileId === id);
  if (!tile)
    return "Outside the LiDAR pack · context terrain at 20 m (LiDAR HD + RGE ALTI®)";
  return acquisitionText([tile], id);
};

// ── App ─────────────────────────────────────────────────────────────────────

const getMcp = async (): Promise<McpLike | null> => {
  const host = (
    window as unknown as { claude?: { use(name: string): Promise<unknown> } }
  ).claude;
  if (!host?.use) return null;
  try {
    return (await host.use("mcp")) as McpLike | null;
  } catch {
    return null;
  }
};

const READOUT_IDLE = "Move over the map to read heights";

/** Remembers which panel sections the viewer closed (this browser only). */
const rememberSections = () => {
  const key = "sillon.sections";
  let closed: string[] = [];
  try {
    closed = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
  } catch {
    closed = [];
  }
  for (const d of document.querySelectorAll<HTMLDetailsElement>(
    "details.gx-sec",
  )) {
    if (closed.includes(d.id)) d.open = false;
    d.addEventListener("toggle", () => {
      closed = closed.filter((id) => id !== d.id);
      if (!d.open) closed.push(d.id);
      try {
        localStorage.setItem(key, JSON.stringify(closed));
      } catch {
        // Storage refused (private window, preview): nothing to keep.
      }
    });
  }
};

/** The boot frame turns into the error report when the pack cannot load. */
const bootFailed = (why: string) => {
  ui.boot.dataset.kind = "error";
  const title = ui.boot.querySelector(".gx-boot-title");
  const text = ui.boot.querySelector(".gx-boot-text");
  if (title) title.textContent = "The gaze finds nothing here";
  if (text) text.textContent = why;
};

const start = async () => {
  ui.ramp.style.background = gaiaReliefGradient();
  const togglePanel = () => {
    const off = document.body.classList.toggle("panel-off");
    ui.collapse.setAttribute("aria-expanded", String(!off));
  };
  ui.collapse.addEventListener("click", togglePanel);
  ui.spine.addEventListener("click", togglePanel);
  rememberSections();

  let pack: PackManifest;
  let packFields: GeoJSON.FeatureCollection;
  try {
    pack = (await (await fetch("pack.json")).json()) as PackManifest;
    packFields = (await (
      await fetch(pack.rpg)
    ).json()) as GeoJSON.FeatureCollection;
  } catch (e) {
    const why = `The field pack did not load: ${e instanceof Error ? e.message : e}`;
    setStatus(why, "error");
    bootFailed(why);
    return;
  }
  packFields.features.forEach((f, i) => {
    f.properties = { ...f.properties, fid: i };
  });
  const packInfo =
    `Offline pack of IGN Géoplateforme data, baked ${pack.bakedAt}: LiDAR HD terrain at 1 m over 3 × 3 km ` +
    `(${pack.place}), 20 m context over 24 km, BD ORTHO® to zoom 18, infrared to 17, ` +
    `${packFields.features.length} RPG fields. Licence Ouverte 2.0.`;
  const liveInfo =
    "Live IGN Géoplateforme data for all of France: BD ORTHO®, infrared, LiDAR HD terrain (RGE ALTI® where " +
    "LiDAR HD is not yet flown) and RPG fields, fetched through your Supabase connector and cached in the " +
    "sillon-tiles database. Licence Ouverte 2.0.";

  /** Fields shown now: the pack's, or those loaded live around the view. */
  let fields = packFields;
  const liveFieldIds = new Set<string>();

  const gridsPromise = Promise.all([
    loadGrid(pack.grids.fine),
    loadGrid(pack.grids.context),
  ]).then(([fine, context]) => ({ fine, context }));
  installProtocol(pack, gridsPromise);

  const map = new maplibregl.Map({
    container: "map",
    style: buildStyle("pack", pack, fields),
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
  map.addControl(
    new maplibregl.ScaleControl({ unit: "metric" }),
    "bottom-left",
  );
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
    const why = `The LiDAR grid did not load: ${e instanceof Error ? e.message : e}`;
    setStatus(why, "error");
    bootFailed(why);
    return;
  }
  await new Promise<void>((resolve) =>
    map.loaded() ? resolve() : map.once("load", () => resolve()),
  );
  setStatus("");
  applyLayers(map);
  ui.packInfo.textContent = packInfo;
  ui.boot.classList.add("done");
  window.setTimeout(() => (ui.boot.hidden = true), 700);
  installFullscreen([ui.fsBtn, ui.fsExit], () => {
    // The map's own observer catches most box changes; nudge it once more.
    window.setTimeout(() => map.resize(), 60);
  });
  let linkBroken = false;
  const renderLink = (busy: number) => {
    const isLive = state.source === "live";
    ui.linkStatus.dataset.state = linkBroken
      ? "error"
      : isLive
        ? busy > 0
          ? "busy"
          : "live"
        : "pack";
    ui.linkText.textContent = linkBroken
      ? "Live · severed"
      : isLive
        ? busy > 0
          ? `Live · active · ${busy} in flight`
          : "Live · idle"
        : "Pack · active";
  };
  let busyNow = 0;
  onActivity((n) => {
    busyNow = n;
    renderLink(n);
  });
  // A handle for debugging and automated checks, as in the Navara app.
  Object.assign(window, { sillon: { map, liveHeights } });

  const heightAt = (p: LngLat) => {
    if (state.source === "live") return liveHeightAt(p, map.getZoom());
    const l93 = lngLatToLambert93(p);
    const fine = sampleGrid(grids.fine, l93);
    if (!Number.isNaN(fine)) return { h: fine, source: "LiDAR HD 1 m" };
    const ctx = sampleGrid(grids.context, l93);
    return Number.isNaN(ctx) ? null : { h: ctx, source: "context 20 m" };
  };

  /** Heights under a lattice of screen points: what the colour ramp is applied to. */
  const viewHeights = (n = 20) => {
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const ll = map.unproject([
          (width * (i + 0.5)) / n,
          (height * (j + 0.5)) / n,
        ]);
        const s = heightAt({ lng: ll.lng, lat: ll.lat });
        if (s && !Number.isNaN(s.h)) out.push(s.h);
      }
    }
    return out;
  };

  const fitView = () => {
    if (!state.autoRange) return;
    const [lo, hi] = percentiles(viewHeights(), [0.01, 0.99]);
    applyRange(map, lo, hi);
  };

  // Live extras that follow the view: the acquisition badge and RPG fields.
  let liveSeq = 0;
  const refreshLive = async () => {
    if (state.source !== "live" || !live) return;
    const seq = ++liveSeq;
    const c = map.getCenter();
    live
      .json<LidarTileMetadata[]>(
        `kind=meta&lng=${c.lng.toFixed(3)}&lat=${c.lat.toFixed(3)}`,
      )
      .then((tiles) => {
        if (seq === liveSeq && state.source === "live")
          ui.badge.textContent = acquisitionText(tiles, tiles[0]?.tileId);
      })
      .catch(() => {});
    if (map.getZoom() < 13.5 || !state.fieldsOn) return;
    // Snap the request to a 0.02° grid so nearby views share cached answers.
    const b = map.getBounds();
    const snap = (v: number, up: boolean) =>
      (up ? Math.ceil(v * 50) : Math.floor(v * 50)) / 50;
    const w = snap(b.getWest(), false);
    const s = snap(b.getSouth(), false);
    const e = Math.min(snap(b.getEast(), true), w + 0.08);
    const n = Math.min(snap(b.getNorth(), true), s + 0.06);
    try {
      const fc = await live.json<GeoJSON.FeatureCollection>(
        `kind=rpg&w=${w.toFixed(2)}&s=${s.toFixed(2)}&e=${e.toFixed(2)}&n=${n.toFixed(2)}`,
      );
      if (state.source !== "live") return;
      for (const f of fc.features) {
        const id = String(f.id);
        if (liveFieldIds.has(id) || fields.features.length > 4000) continue;
        liveFieldIds.add(id);
        f.properties = { ...f.properties, fid: fields.features.length };
        fields.features.push(f);
      }
      (map.getSource("fields") as GeoJSONSource | undefined)?.setData(fields);
    } catch {
      // A failed lookup leaves the fields already shown; the next move retries.
    }
  };

  const onSettled = () => {
    fitView();
    const c = map.getCenter();
    if (state.source === "pack")
      ui.badge.textContent = packBadge(pack, { lng: c.lng, lat: c.lat });
    else void refreshLive();
  };
  map.on("moveend", onSettled);
  // Live tiles arrive after the camera stops; refit once they have.
  map.on("idle", () => {
    if (state.source === "live") fitView();
  });
  onSettled();

  // ── Field workbench ──
  const workbench = installWorkbench({
    map,
    source: () => state.source,
    live: () => live,
    grids,
    packArea: pack.context,
    setStatus,
    colourTo: (lo, hi) => {
      state.autoRange = false;
      if (state.mode !== "relief") {
        ui.mode.value = state.mode = "relief";
        applyLayers(map);
      }
      applyRange(map, lo, hi);
    },
    colourAuto: () => {
      state.autoRange = true;
      fitView();
    },
    useLive: () => {
      if (!mcp) return false;
      setSource("live");
      return true;
    },
    onDesignMap: (on) => {
      state.designMap = on;
      applyLayers(map);
    },
  });

  // ── Data source ──
  const setSource = (source: Source) => {
    if (source === "live" && !mcp) return;
    if (source === "live" && (!live || live.failure)) {
      live = new LiveProxy(mcp as McpLike);
      liveCache.clear();
      linkBroken = false;
      live.onFailure = (e) => {
        ui.liveStatus.textContent = describeMcpError(e);
        setStatus(describeMcpError(e), "error");
        linkBroken = true;
        renderLink(busyNow);
      };
    }
    state.source = source;
    ui.srcPack.classList.toggle("on", source === "pack");
    ui.srcLive.classList.toggle("on", source === "live");
    ui.srcPack.setAttribute("aria-pressed", String(source === "pack"));
    ui.srcLive.setAttribute("aria-pressed", String(source === "live"));
    ui.packName.textContent =
      source === "live"
        ? "Land instrument · Live IGN · France"
        : `Land instrument · ${pack.name} · LiDAR HD`;
    renderLink(busyNow);
    ui.packInfo.textContent = source === "live" ? liveInfo : packInfo;
    ui.goto.placeholder =
      source === "live"
        ? "Commune, address, or lat, lng"
        : "43.585, 4.553 or 825500 6277500";
    ui.gridInfo.textContent = "";
    setStatus(
      source === "live" ? "Loading live IGN tiles through Supabase…" : "",
    );
    fields = source === "live" ? emptyFields() : packFields;
    liveFieldIds.clear();
    const b = source === "live" ? FRANCE : pack.context;
    map.setMaxBounds([
      [b.west - 0.05, b.south - 0.05],
      [b.east + 0.05, b.north + 0.05],
    ]);
    const c = map.getCenter();
    if (
      source === "pack" &&
      !inside(pack.context, { lng: c.lng, lat: c.lat })
    ) {
      map.jumpTo({
        center: [pack.centre.lng, pack.centre.lat],
        zoom: 15.2,
        pitch: 0,
        bearing: 0,
      });
    }
    map.setStyle(buildStyle(source, pack, fields));
    map.once("style.load", () => {
      applyLayers(map);
      applyRange(map, state.range.min, state.range.max);
      onSettled();
    });
    workbench.onSourceChange();
    if (source === "live") {
      map.once("idle", () => {
        if (!live?.failure) setStatus("");
      });
    }
  };
  ui.srcPack.addEventListener("click", () => setSource("pack"));
  ui.srcLive.addEventListener("click", () => setSource("live"));

  void getMcp().then((found) => {
    mcp = found;
    ui.srcLive.disabled = !found;
    ui.liveStatus.textContent = found
      ? "Live IGN covers all of France through your Supabase connector (sillon-tiles project). The first use asks your permission."
      : "Live IGN works when this page is open on claude.ai and your Supabase connector is added. The Camargue pack works everywhere.";
  });

  // ── Map controls ──
  const flyTo = (p: LngLat, zoom = 16) =>
    map.flyTo({ center: [p.lng, p.lat], zoom, duration: 1500 });
  ui.gotoForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ui.goto.value.trim();
    if (!text) return;
    const l93 = text.match(/^(\d{6}(?:\.\d+)?)[\s,;]+(\d{7}(?:\.\d+)?)$/);
    const target = l93
      ? lambert93ToLngLat({ x: Number(l93[1]), y: Number(l93[2]) })
      : parseLatLng(text);
    const area = state.source === "live" ? FRANCE : pack.context;
    if (target) {
      if (!inside(area, target)) {
        setStatus(
          state.source === "live"
            ? "That point is outside metropolitan France and Corsica, where IGN data exists."
            : "That point is outside the Camargue pack. Switch to Live IGN to go anywhere in France.",
          "error",
        );
        return;
      }
      setStatus("");
      flyTo(target);
      return;
    }
    if (state.source !== "live" || !live) {
      setStatus(
        "Place search needs Live IGN. In the pack, enter “lat, lng” or Lambert-93 “x y”.",
        "error",
      );
      return;
    }
    setStatus(`Searching “${text}”…`);
    live
      .json<Place[]>(`kind=geocode&q=${keyValue(text)}`)
      .then((places) => {
        const hit = places.find((p) => inside(FRANCE, p));
        if (!hit) {
          setStatus(`Nothing found in France for “${text}”.`, "error");
          return;
        }
        setStatus(hit.label);
        flyTo(hit, hit.kind === "municipality" ? 14 : 16);
      })
      .catch((err) => setStatus(describeMcpError(err), "error"));
  });

  ui.imagery.addEventListener("change", () => {
    state.imagery = ui.imagery.value;
    applyLayers(map);
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
    state.fieldsOn = ui.fieldsOn.checked;
    applyLayers(map);
    if (state.fieldsOn) void refreshLive();
  });

  // ── LiDAR controls ──
  ui.mode.addEventListener("change", () => {
    state.mode = ui.mode.value as Mode;
    applyLayers(map);
  });
  ui.opacity.addEventListener("input", () => {
    state.opacity = Number(ui.opacity.value) / 100;
    ui.opacityOut.textContent = `${ui.opacity.value} %`;
    applyLayers(map);
  });
  ui.stretch.addEventListener("input", () => {
    state.stretch = Number(ui.stretch.value);
    ui.stretchOut.textContent = `${ui.stretch.value}×`;
    map.setTerrain({ source: "terrain", exaggeration: state.stretch });
  });
  ui.fit.addEventListener("click", () => {
    state.autoRange = true;
    fitView();
  });

  // ── Cursor readout ──
  const readout = (lng: number, lat: number) => {
    const p = lngLatToLambert93({ lng, lat });
    const s = heightAt({ lng, lat });
    const design = workbench.describeAt({ lng, lat });
    ui.readout.textContent = [
      design,
      s && !Number.isNaN(s.h)
        ? `${formatHeight(s.h)} ${s.source}`
        : "loading heights…",
      latLonDms(lat, lng),
      l93(p.x, p.y),
    ]
      .filter(Boolean)
      .join(" // ");
  };
  map.on("mousemove", (e: MapMouseEvent) =>
    readout(e.lngLat.lng, e.lngLat.lat),
  );
  map
    .getCanvas()
    .addEventListener(
      "mouseleave",
      () => (ui.readout.textContent = READOUT_IDLE),
    );

  // ── RPG fields ──
  map.on("click", "fields-hit", (e) => {
    const fid = e.features?.[0]?.properties?.fid;
    const f = typeof fid === "number" ? fields.features[fid] : undefined;
    // The full outline from the source data, not the tile-clipped one.
    if (f) workbench.selectRpg(f);
  });
  map.on("click", (e) => {
    if (!workbench.isEditing()) readout(e.lngLat.lng, e.lngLat.lat);
  });
  map.on("mouseenter", "fields-hit", () => {
    if (!workbench.isEditing()) map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "fields-hit", () => {
    if (!workbench.isEditing()) map.getCanvas().style.cursor = "";
  });

  // ── Data ──
  ui.analyse.addEventListener("click", () => {
    const hs = viewHeights(60);
    const [p1, p50, p99] = percentiles(hs, [0.01, 0.5, 0.99]);
    if (state.source === "live") {
      ui.gridInfo.textContent = hs.length
        ? [
            `${hs.length} height samples across the view (live IGN terrain tiles)`,
            `${formatHeight(Math.min(...hs))} to ${formatHeight(Math.max(...hs))}`,
            `Median ${formatHeight(p50)} · 1–99 % ${formatHeight(p1)} to ${formatHeight(p99)}`,
            "Click or draw a field for its area, natural fall and levelling volumes on the native 0.5 m grid.",
          ].join("\n")
        : "Heights are still loading. Try again once the map has settled.";
      return;
    }
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
    ui.gridInfo.textContent = n
      ? [
          `${grouped(n, 0)} LiDAR cells of 1 m in view (${(n / 1e4).toFixed(1)} ha)`,
          `${formatHeight(lo)} to ${formatHeight(hi)} · relief ${formatHeight(hi - lo)}`,
          `Median ${formatHeight(p50)} · 1–99 % ${formatHeight(p1)} to ${formatHeight(p99)}`,
          "Heights NGF-IGN69, Lambert-93 grid (EPSG:2154)",
        ].join("\n")
      : "No 1 m LiDAR cells in view. Pan to the dashed square.";
  });
};

void start();
