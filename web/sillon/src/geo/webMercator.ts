import type { LngLat } from "./lambert93";

/** EPSG:3857 sphere radius. */
export const MERCATOR_RADIUS = 6378137;
const HALF_WORLD = Math.PI * MERCATOR_RADIUS;

export type TileXYZ = { z: number; x: number; y: number };
export type Bbox = { minX: number; minY: number; maxX: number; maxY: number };

export const lngLatToMercator = ({ lng, lat }: LngLat) => ({
  x: (lng * Math.PI * MERCATOR_RADIUS) / 180,
  y: Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * MERCATOR_RADIUS,
});

export const mercatorToLngLat = (x: number, y: number): LngLat => ({
  lng: (x / MERCATOR_RADIUS) * (180 / Math.PI),
  lat:
    (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) *
    (180 / Math.PI),
});

/** EPSG:3857 bounds of an XYZ (north-origin) tile. */
export const tileBboxMercator = ({ z, x, y }: TileXYZ): Bbox => {
  const size = (2 * HALF_WORLD) / 2 ** z;
  return {
    minX: -HALF_WORLD + x * size,
    maxX: -HALF_WORLD + (x + 1) * size,
    minY: HALF_WORLD - (y + 1) * size,
    maxY: HALF_WORLD - y * size,
  };
};

export const lngLatToTile = (p: LngLat, z: number): TileXYZ => {
  const n = 2 ** z;
  const { x, y } = lngLatToMercator(p);
  return {
    z,
    x: Math.min(
      n - 1,
      Math.max(0, Math.floor(((x + HALF_WORLD) / (2 * HALF_WORLD)) * n)),
    ),
    y: Math.min(
      n - 1,
      Math.max(0, Math.floor(((HALF_WORLD - y) / (2 * HALF_WORLD)) * n)),
    ),
  };
};

/** Ground metres per pixel of a `tileSize` tile at zoom `z` and latitude `lat`. */
export const groundResolution = (z: number, lat: number, tileSize = 256) =>
  ((2 * HALF_WORLD) / (tileSize * 2 ** z)) * Math.cos((lat * Math.PI) / 180);
