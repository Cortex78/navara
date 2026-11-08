import {
  lambert93ScaleFactor,
  lngLatToLambert93,
  type LngLat,
  type XY,
} from "../geo/lambert93";

import { percentiles, type ElevationGrid } from "./elevationGrid";
import { fitPlaneBy, planeHeight, type PlaneFit } from "./planeFit";

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

/** Earth to move to reach a target surface, in m³ of ground volume. */
export type Earthwork = { cutM3: number; fillM3: number };

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
  /**
   * The field's natural fall: a least-squares plane, refitted once without
   * the cells more than 3 RMS off it (ditches, levees, trees left in a DTM).
   */
  plane: PlaneFit | null;
  /** Steepest ground slope of that plane, in percent. */
  slopePct: number;
  /** Direction the field falls toward, degrees clockwise from north. */
  fallDeg: number;
  /** RMS of the heights about the plane: how far from even the field is. */
  rmsM: number;
  /** Land levelling to the plane (keep the natural fall). */
  toPlane: Earthwork;
  /** Land levelling to dead level at the mean height (rice, basins). */
  toLevel: Earthwork;
};

const earthwork = (
  n: number,
  x: (i: number) => number,
  y: (i: number) => number,
  z: (i: number) => number,
  target: (x: number, y: number) => number,
  cellArea: number,
): Earthwork => {
  let cut = 0;
  let fill = 0;
  for (let i = 0; i < n; i++) {
    const h = z(i);
    if (Number.isNaN(h)) continue;
    const d = h - target(x(i), y(i));
    if (d > 0) cut += d;
    else fill -= d;
  }
  return { cutM3: cut * cellArea, fillM3: fill * cellArea };
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
  const cellArea = (g.cellSize / k) ** 2;
  const [p1, p99] = percentiles(values, [0.01, 0.99]);
  const mean = sum / valid;

  // Cell centres in Lambert-93, read from the cell index: no per-cell
  // coordinate arrays, so a large field stays within an Edge worker's memory.
  const n = cells.length;
  const x = (i: number) =>
    g.originX + ((cells[i] % g.width) + 0.5) * g.cellSize;
  const y = (i: number) =>
    g.originY - (Math.floor(cells[i] / g.width) + 0.5) * g.cellSize;
  const z = (i: number) => values[i];
  const isValid = (i: number) => !Number.isNaN(values[i]);
  let plane = fitPlaneBy(n, x, y, z, isValid);
  if (plane && plane.rms > 0) {
    const first = plane;
    const limit = 3 * first.rms;
    plane =
      fitPlaneBy(
        n,
        x,
        y,
        z,
        (i) =>
          isValid(i) &&
          Math.abs(values[i] - planeHeight(first, x(i), y(i))) <= limit,
      ) ?? first;
  }
  let rms = 0;
  if (plane) {
    for (let i = 0; i < n; i++)
      if (isValid(i)) rms += (values[i] - planeHeight(plane, x(i), y(i))) ** 2;
    rms = Math.sqrt(rms / valid);
  }
  const fitted = plane;
  return {
    areaHa: (cells.length * cellArea) / 1e4,
    min,
    max,
    mean,
    p1,
    p99,
    nodataShare: 1 - valid / cells.length,
    plane,
    // Plane gradients are per map metre; ground metres are k times shorter.
    slopePct: fitted ? fitted.slopePct * k : 0,
    fallDeg: fitted ? fitted.fallDeg : 0,
    rmsM: fitted ? rms : 0,
    toPlane: fitted
      ? earthwork(n, x, y, z, (px, py) => planeHeight(fitted, px, py), cellArea)
      : { cutM3: 0, fillM3: 0 },
    toLevel: earthwork(n, x, y, z, () => mean, cellArea),
  };
};
