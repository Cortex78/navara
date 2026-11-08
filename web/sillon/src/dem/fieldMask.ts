import {
  lambert93ScaleFactor,
  lngLatToLambert93,
  type LngLat,
  type XY,
} from "../geo/lambert93";

import { percentiles, type ElevationGrid } from "./elevationGrid";

/** A polygon as rings of lng/lat (outer ring first, then holes), as in GeoJSON. */
export type LngLatPolygon = LngLat[][];

/**
 * Indices of the grid cells whose centres fall inside the polygons, by
 * even-odd scanlines through each row of cell centres (holes and
 * multipolygons need no special case). Cells outside the grid are dropped.
 */
export const maskGridCells = (
  g: ElevationGrid,
  polygons: LngLatPolygon[],
): Uint32Array => {
  const rings: XY[][] = polygons.flatMap((p) =>
    p.map((ring) => ring.map(lngLatToLambert93)),
  );
  let minY = Infinity;
  let maxY = -Infinity;
  for (const r of rings)
    for (const p of r)
      [minY, maxY] = [Math.min(minY, p.y), Math.max(maxY, p.y)];
  const rowFrom = Math.max(
    0,
    Math.floor((g.originY - maxY) / g.cellSize - 0.5),
  );
  const rowTo = Math.min(
    g.height - 1,
    Math.ceil((g.originY - minY) / g.cellSize - 0.5),
  );

  const cells: number[] = [];
  const crossings: number[] = [];
  for (let row = rowFrom; row <= rowTo; row++) {
    const y = g.originY - (row + 0.5) * g.cellSize;
    crossings.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i];
        const b = ring[j];
        if (a.y > y !== b.y > y)
          crossings.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const c0 = Math.max(
        0,
        Math.ceil((crossings[k] - g.originX) / g.cellSize - 0.5),
      );
      const c1 = Math.min(
        g.width - 1,
        Math.floor((crossings[k + 1] - g.originX) / g.cellSize - 0.5),
      );
      for (let col = c0; col <= c1; col++) cells.push(row * g.width + col);
    }
  }
  return Uint32Array.from(cells);
};

export type FieldSurface = {
  /** Ground area of the cells inside, in hectares (projection-corrected). */
  areaHa: number;
  min: number;
  max: number;
  mean: number;
  /** 1st and 99th percentile: the relief without ditches and levee crests. */
  p1: number;
  p99: number;
  /** Share of the cells inside with no LiDAR value. */
  nodataShare: number;
};

export const fieldSurface = (
  g: ElevationGrid,
  polygons: LngLatPolygon[],
): FieldSurface | null => {
  const cells = maskGridCells(g, polygons);
  if (cells.length === 0) return null;
  const values = new Float32Array(cells.length);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let valid = 0;
  for (let i = 0; i < cells.length; i++) {
    const v = g.data[cells[i]];
    values[i] = v;
    if (Number.isNaN(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    valid++;
  }
  if (valid === 0) return null;
  const lat =
    polygons[0][0].reduce((s, p) => s + p.lat, 0) / polygons[0][0].length;
  const k = lambert93ScaleFactor(lat);
  const [p1, p99] = percentiles(values, [0.01, 0.99]);
  return {
    areaHa: (cells.length * (g.cellSize / k) ** 2) / 1e4,
    min,
    max,
    mean: sum / valid,
    p1,
    p99,
    nodataShare: 1 - valid / cells.length,
  };
};
