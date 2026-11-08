import { tileBboxMercator, type TileXYZ } from "../geo/webMercator";
import { decodeBil32 } from "../ign/bil";
import {
  ELEVATION_LAYERS,
  GeoplateformeError,
  geopfFetch,
  wmsGetMapUrl,
  type FetchOptions,
} from "../ign/geoplateforme";

import { encodePngRgb } from "./png";
import { encodeTerrarium } from "./terrarium";

/**
 * The IGN elevation services return float32 rasters for a bounding box, but
 * a map engine's `raster-dem` source wants `{z}/{x}/{y}` image tiles. The
 * bridge serves a same-origin virtual endpoint, `/__sillon/dem/...`, that
 * the DEM service worker answers by fetching the tile's EPSG:3857 bbox as
 * BIL and re-encoding it as Terrarium PNG.
 */

export const DEM_PRODUCTS = {
  /** LiDAR HD DTM, RGE ALTI where LiDAR HD is missing. The default for terrain. */
  mnt: ELEVATION_LAYERS.lidarMntMixed,
  /** LiDAR HD DTM only; gaps encode as 0 m. */
  "mnt-lidar": ELEVATION_LAYERS.lidarMnt,
  /** LiDAR HD surface model (vegetation, buildings, levee crests). */
  mns: ELEVATION_LAYERS.lidarMns,
} as const;

export type DemProduct = keyof typeof DEM_PRODUCTS;

export type DemTileRequest = TileXYZ & {
  product: DemProduct;
  tileSize: number;
};

const PATH_PREFIX = "/__sillon/dem/";
const PATH_RE =
  /\/__sillon\/dem\/([a-z-]+)\/(256|512)\/(\d+)\/(\d+)\/(\d+)\.png$/;

/** Engine URL template for a product, relative to `base` (the app origin + base path). */
export const demTileTemplate = (
  base: string,
  product: DemProduct = "mnt",
  tileSize: 256 | 512 = 256,
) =>
  `${base.replace(/\/$/, "")}${PATH_PREFIX}${product}/${tileSize}/{z}/{x}/{y}.png`;

export const parseDemTilePath = (pathname: string): DemTileRequest | null => {
  const m = PATH_RE.exec(pathname);
  if (!m || !(m[1] in DEM_PRODUCTS)) return null;
  const [z, x, y] = [Number(m[3]), Number(m[4]), Number(m[5])];
  if (z > 24 || x >= 2 ** z || y >= 2 ** z) return null;
  return { product: m[1] as DemProduct, tileSize: Number(m[2]), z, x, y };
};

/**
 * Metropolitan France plus Corsica, in lng/lat — the extent of the WMS-R
 * LiDAR HD layers. Tiles entirely outside it are answered without a request.
 */
export const IGN_COVERAGE = { west: -5.2, south: 41.3, east: 9.6, north: 51.1 };

const tileOutsideCoverage = ({ z, x, y }: TileXYZ) => {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return (
    east < IGN_COVERAGE.west ||
    west > IGN_COVERAGE.east ||
    lat(y) < IGN_COVERAGE.south ||
    lat(y + 1) > IGN_COVERAGE.north
  );
};

/** Below this zoom the services return empty rasters; the tile is drawn flat. */
export const DEM_MIN_ZOOM = 8;

/**
 * Served for a tile when its product's request fails or times out. Under
 * load the Géoplateforme answers LiDAR HD mosaics with 504s or a transient
 * "layer unknown" exception; RGE ALTI® comes from a lighter pyramid.
 */
export const FALLBACK_LAYER = ELEVATION_LAYERS.rgeAlti;

const fetchLayerHeights = async (
  layer: string,
  req: DemTileRequest,
  options?: FetchOptions,
) => {
  const b = tileBboxMercator(req);
  const url = wmsGetMapUrl({
    layer,
    crs: "EPSG:3857",
    bbox: [b.minX, b.minY, b.maxX, b.maxY],
    width: req.tileSize,
    height: req.tileSize,
  });
  const res = await geopfFetch(url, options);
  return decodeBil32(await res.arrayBuffer(), req.tileSize, req.tileSize);
};

const isServiceFailure = (e: unknown) =>
  e instanceof GeoplateformeError ||
  (e instanceof DOMException && e.name === "TimeoutError");

export type DemTileHeights = {
  /** Row-major, north first, NaN = no data. */
  heights: Float32Array;
  /** True when the fallback layer stood in for the product; do not cache. */
  degraded: boolean;
};

export const fetchDemTileHeights = async (
  req: DemTileRequest,
  options?: FetchOptions,
): Promise<DemTileHeights> => {
  const size = req.tileSize;
  if (req.z < DEM_MIN_ZOOM || tileOutsideCoverage(req)) {
    return {
      heights: new Float32Array(size * size).fill(NaN),
      degraded: false,
    };
  }
  try {
    return {
      heights: await fetchLayerHeights(DEM_PRODUCTS[req.product], req, options),
      degraded: false,
    };
  } catch (e) {
    if (options?.signal?.aborted || !isServiceFailure(e)) throw e;
    return {
      heights: await fetchLayerHeights(FALLBACK_LAYER, req, options),
      degraded: true,
    };
  }
};

export const renderDemTile = async (
  req: DemTileRequest,
  options?: FetchOptions,
): Promise<{ png: Uint8Array; degraded: boolean }> => {
  const { heights, degraded } = await fetchDemTileHeights(req, options);
  return {
    png: await encodePngRgb(
      encodeTerrarium(heights),
      req.tileSize,
      req.tileSize,
    ),
    degraded,
  };
};
