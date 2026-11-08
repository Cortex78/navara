/**
 * Bakes an offline field pack for the Sillon artifact: a page published on
 * claude.ai may only fetch its own files, so the IGN data it shows is
 * fetched here and published beside it.
 *
 *   NODE_USE_ENV_PROXY=1 tsx artifact/bake.ts <outDir>
 *
 * Writes pack.json (layout, metadata, tile index), two elevation grids and
 * tile bundles (concatenated tiles, at most BUNDLE_BYTES each), the binary
 * parts base64-encoded in .txt files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import {
  loadElevationGrid,
  type ElevationGrid,
} from "../src/dem/elevationGrid";
import { lambert93ToLngLat } from "../src/geo/lambert93";
import { lngLatToTile, type Bbox } from "../src/geo/webMercator";
import {
  ELEVATION_LAYERS,
  GEOPF,
  geopfFetch,
  wmtsTemplate,
} from "../src/ign/geoplateforme";
import {
  fetchLidarMetadata,
  type LngLatBounds,
} from "../src/ign/lidarMetadata";

import {
  BUNDLE_BYTES,
  encodeGrid,
  type PackGrid,
  type PackManifest,
  type PackTileLayer,
} from "./pack";

const out = process.argv[2];
if (!out) throw new Error("usage: bake.ts <outDir>");
mkdirSync(out, { recursive: true });

/** Rice basins north of Saintes-Maries-de-la-Mer: three LiDAR HD km tiles square. */
const CORE: Bbox = { minX: 824000, minY: 6276000, maxX: 827000, maxY: 6279000 };
/** Surroundings for zoomed-out and 3D views. */
const CONTEXT: Bbox = {
  minX: 813500,
  minY: 6265500,
  maxX: 837500,
  maxY: 6289500,
};

const writeBase64 = (file: string, bytes: Uint8Array) =>
  writeFileSync(
    join(out, file),
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
      "base64",
    ),
  );

const lngLatBounds = (b: Bbox): LngLatBounds => {
  const corners = [
    lambert93ToLngLat({ x: b.minX, y: b.minY }),
    lambert93ToLngLat({ x: b.minX, y: b.maxY }),
    lambert93ToLngLat({ x: b.maxX, y: b.minY }),
    lambert93ToLngLat({ x: b.maxX, y: b.maxY }),
  ];
  return {
    west: Math.min(...corners.map((c) => c.lng)),
    east: Math.max(...corners.map((c) => c.lng)),
    south: Math.min(...corners.map((c) => c.lat)),
    north: Math.max(...corners.map((c) => c.lat)),
  };
};

const log = (msg: string) => console.log(`[bake] ${msg}`);

const writeGrid = (
  name: string,
  grid: ElevationGrid,
  scale: number,
): PackGrid => {
  const bytes = deflateSync(encodeGrid(grid.data, grid.width, scale), {
    level: 9,
  });
  const file = `${name}.grid.txt`;
  writeBase64(file, bytes);
  log(
    `${file}: ${grid.width}x${grid.height} @ ${grid.cellSize} m, ${(bytes.length / 1e6).toFixed(1)} MB`,
  );
  const { data: _data, ...layout } = grid;
  return { ...layout, file, scale };
};

type TileSpec = {
  layer: string;
  format: "image/jpeg" | "image/png";
  style?: string;
};

const tilesFor = (b: LngLatBounds, z: number) => {
  const nw = lngLatToTile({ lng: b.west, lat: b.north }, z);
  const se = lngLatToTile({ lng: b.east, lat: b.south }, z);
  const list: [number, number, number][] = [];
  for (let x = nw.x; x <= se.x; x++)
    for (let y = nw.y; y <= se.y; y++) list.push([z, x, y]);
  return list;
};

const bakeTiles = async (
  id: string,
  spec: TileSpec,
  ranges: { bounds: LngLatBounds; minZoom: number; maxZoom: number }[],
): Promise<PackTileLayer> => {
  const template = wmtsTemplate(spec.layer, spec.format, spec.style);
  const wanted = ranges.flatMap(({ bounds, minZoom, maxZoom }) =>
    Array.from({ length: maxZoom - minZoom + 1 }, (_, i) =>
      tilesFor(bounds, minZoom + i),
    ).flat(),
  );
  const unique = [...new Map(wanted.map((t) => [t.join("/"), t])).values()];
  const fetched = new Map<string, Uint8Array>();
  const queue = [...unique];
  let done = 0;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const [z, x, y] = t;
        const url = template
          .replace("{z}", String(z))
          .replace("{x}", String(x))
          .replace("{y}", String(y));
        try {
          const res = await geopfFetch(url, { retries: 3 });
          fetched.set(t.join("/"), new Uint8Array(await res.arrayBuffer()));
        } catch (e) {
          log(
            `${id} ${t.join("/")} skipped: ${e instanceof Error ? e.message : e}`,
          );
        }
        if (++done % 200 === 0) log(`${id}: ${done}/${unique.length}`);
      }
    }),
  );

  const bundles: string[] = [];
  const tiles: Record<string, [number, number, number]> = {};
  let parts: Uint8Array[] = [];
  let size = 0;
  const flush = () => {
    if (!parts.length) return;
    const file = `${id}-${bundles.length}.txt`;
    writeBase64(file, Buffer.concat(parts));
    bundles.push(file);
    parts = [];
    size = 0;
  };
  // Zoom order keeps each bundle to a band of zooms, so a view loads few bundles.
  for (const key of [...fetched.keys()].sort(
    (a, b) => Number(a.split("/")[0]) - Number(b.split("/")[0]),
  )) {
    const bytes = fetched.get(key) as Uint8Array;
    if (size + bytes.length > BUNDLE_BYTES) flush();
    tiles[key] = [bundles.length, size, bytes.length];
    parts.push(bytes);
    size += bytes.length;
  }
  flush();
  log(
    `${id}: ${Object.keys(tiles).length} tiles in ${bundles.length} bundle(s)`,
  );
  return {
    format: spec.format === "image/png" ? "png" : "jpeg",
    minZoom: Math.min(...ranges.map((r) => r.minZoom)),
    maxZoom: Math.max(...ranges.map((r) => r.maxZoom)),
    bundles,
    tiles,
  };
};

const fetchJson = async (path: string) =>
  (await geopfFetch(`${GEOPF}${path}`)).json();

const main = async () => {
  const core = lngLatBounds(CORE);
  const context = lngLatBounds(CONTEXT);

  log("LiDAR HD grid (1 m, Lambert-93)…");
  const fine = await loadElevationGrid({ bbox: CORE, cellSize: 1 });
  log("Context grid (20 m, LiDAR HD + RGE ALTI)…");
  const coarse = await loadElevationGrid({
    bbox: CONTEXT,
    cellSize: 20,
    layer: ELEVATION_LAYERS.lidarMntMixed,
  });

  log("LiDAR HD acquisition metadata…");
  const lidarTiles = await fetchLidarMetadata(core);

  log("RPG fields…");
  const q = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    OUTPUTFORMAT: "application/json",
    TYPENAMES: "RPG.LATEST:parcelles_graphiques",
    COUNT: "2000",
    BBOX: `${core.west},${core.south},${core.east},${core.north},urn:ogc:def:crs:OGC:1.3:CRS84`,
  });
  const rpg = (await fetchJson(`/wfs/ows?${q}`)) as GeoJSON.FeatureCollection;
  const codes = (await fetchJson(
    `/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json&COUNT=1000&TYPENAMES=RPG.LATEST:codes_cultures`,
  )) as GeoJSON.FeatureCollection;
  const cropNames: Record<string, string> = {};
  for (const f of codes.features) {
    const p = f.properties as Record<string, string>;
    cropNames[p.code_culture] = p.libelle_culture;
  }
  for (const f of rpg.features) {
    const p = f.properties as Record<string, unknown>;
    f.properties = {
      code: p.code_cultu,
      crop: cropNames[String(p.code_cultu)] ?? String(p.code_cultu),
      ha: p.surf_parc,
      organic: p.bio === true,
    };
  }
  writeFileSync(join(out, "rpg.json"), JSON.stringify(rpg));
  log(`rpg.json: ${rpg.features.length} fields`);

  log("Imagery tiles…");
  const ortho = await bakeTiles(
    "ortho",
    { layer: "ORTHOIMAGERY.ORTHOPHOTOS", format: "image/jpeg" },
    [
      { bounds: context, minZoom: 9, maxZoom: 14 },
      { bounds: core, minZoom: 15, maxZoom: 18 },
    ],
  );
  const irc = await bakeTiles(
    "irc",
    { layer: "ORTHOIMAGERY.ORTHOPHOTOS.IRC", format: "image/jpeg" },
    [
      { bounds: context, minZoom: 9, maxZoom: 13 },
      { bounds: core, minZoom: 14, maxZoom: 17 },
    ],
  );
  const shade = await bakeTiles(
    "shade",
    {
      layer: "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW",
      format: "image/png",
    },
    [
      { bounds: context, minZoom: 10, maxZoom: 12 },
      { bounds: core, minZoom: 13, maxZoom: 17 },
    ],
  );

  const manifest: PackManifest = {
    name: "Camargue rice basins",
    place: "Saintes-Maries-de-la-Mer, Bouches-du-Rhône",
    bakedAt: new Date().toISOString().slice(0, 10),
    core,
    context,
    centre: {
      lng: (core.west + core.east) / 2,
      lat: (core.south + core.north) / 2,
    },
    grids: {
      fine: writeGrid("lidar-1m", fine, 0.01),
      context: writeGrid("context-20m", coarse, 0.1),
    },
    lidarTiles,
    rpg: "rpg.json",
    layers: { ortho, irc, shade },
  };
  writeFileSync(join(out, "pack.json"), JSON.stringify(manifest));
  log("pack.json written");
};

await main();
