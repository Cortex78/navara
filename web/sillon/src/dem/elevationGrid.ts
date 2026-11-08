import {
  lambert93ScaleFactor,
  lambert93ToLngLat,
  lngLatToLambert93,
  type LngLat,
  type XY,
} from "../geo/lambert93";
import type { Bbox } from "../geo/webMercator";
import { decodeBil32 } from "../ign/bil";
import {
  ELEVATION_LAYERS,
  geopfFetch,
  LIDAR_HD_CELL,
  wmsGetMapUrl,
  type FetchOptions,
} from "../ign/geoplateforme";

/**
 * A north-up elevation raster on the Lambert-93 grid: the analysis surface
 * for cut/fill, drainage and design. Cell (col, row) has its centre at
 * `(originX + (col + 0.5) · cellSize, originY − (row + 0.5) · cellSize)`.
 */
export type ElevationGrid = {
  crs: "EPSG:2154";
  layer: string;
  cellSize: number;
  /** Lambert-93 coordinates of the outer top-left corner. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Row-major, row 0 north; NaN = no data. */
  data: Float32Array;
};

/** Requests above this many cells are refused; ask for a coarser cell size. */
export const MAX_GRID_CELLS = 36_000_000;

/** Lambert-93 envelope of lng/lat points (a field outline, or bbox corners). */
export const lambert93Envelope = (points: LngLat[]): Bbox => {
  if (points.length === 0) throw new Error("empty point set");
  const bbox: Bbox = {
    minX: Infinity,
    minY: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
  };
  for (const p of points) {
    const { x, y } = lngLatToLambert93(p);
    bbox.minX = Math.min(bbox.minX, x);
    bbox.minY = Math.min(bbox.minY, y);
    bbox.maxX = Math.max(bbox.maxX, x);
    bbox.maxY = Math.max(bbox.maxY, y);
  }
  return bbox;
};

/**
 * Lambert-93 envelope of a lng/lat rectangle. Meridians converge in the conic
 * projection, so the edges are sampled rather than just the corners.
 */
export const lambert93EnvelopeOfLngLatBounds = (
  b: { west: number; south: number; east: number; north: number },
  samplesPerEdge = 8,
): Bbox => {
  const pts: LngLat[] = [];
  for (let i = 0; i <= samplesPerEdge; i++) {
    const f = i / samplesPerEdge;
    const lng = b.west + (b.east - b.west) * f;
    const lat = b.south + (b.north - b.south) * f;
    pts.push(
      { lng, lat: b.south },
      { lng, lat: b.north },
      { lng: b.west, lat },
      { lng: b.east, lat },
    );
  }
  return lambert93Envelope(pts);
};

/**
 * Grid layout covering `bbox`, with cell centres on multiples of `cellSize`
 * — the alignment of IGN's own LiDAR HD tiles, so at 0.5 m the service
 * returns its native cells without resampling.
 */
export const alignGrid = (bbox: Bbox, cellSize: number) => {
  const c0 = Math.floor(bbox.minX / cellSize + 0.5);
  const c1 = Math.ceil(bbox.maxX / cellSize - 0.5);
  const r0 = Math.floor(bbox.minY / cellSize + 0.5);
  const r1 = Math.ceil(bbox.maxY / cellSize - 0.5);
  return {
    originX: (c0 - 0.5) * cellSize,
    originY: (r1 + 0.5) * cellSize,
    width: c1 - c0 + 1,
    height: r1 - r0 + 1,
  };
};

export type GridLoadProgress = { done: number; total: number };

export type LoadElevationGridOptions = FetchOptions & {
  /** Lambert-93 area to cover. */
  bbox: Bbox;
  /** Metres; defaults to the native 0.5 m. */
  cellSize?: number;
  layer?: string;
  /** Max pixels per GetMap side. 2000 = one native 1 km LiDAR HD tile. */
  chunkPixels?: number;
  concurrency?: number;
  onProgress?: (p: GridLoadProgress) => void;
};

export const loadElevationGrid = async ({
  bbox,
  cellSize = LIDAR_HD_CELL,
  layer = ELEVATION_LAYERS.lidarMntL93,
  chunkPixels = 2000,
  concurrency = 4,
  onProgress,
  ...fetchOptions
}: LoadElevationGridOptions): Promise<ElevationGrid> => {
  const { originX, originY, width, height } = alignGrid(bbox, cellSize);
  if (width * height > MAX_GRID_CELLS) {
    throw new RangeError(
      `${width}x${height} cells at ${cellSize} m exceeds ${MAX_GRID_CELLS}; use a coarser cell size`,
    );
  }
  const data = new Float32Array(width * height);

  const chunks: { col: number; row: number; w: number; h: number }[] = [];
  for (let row = 0; row < height; row += chunkPixels) {
    for (let col = 0; col < width; col += chunkPixels) {
      chunks.push({
        col,
        row,
        w: Math.min(chunkPixels, width - col),
        h: Math.min(chunkPixels, height - row),
      });
    }
  }

  // The first failure cancels the blocks still in flight.
  const failed = new AbortController();
  const signal = fetchOptions.signal
    ? AbortSignal.any([fetchOptions.signal, failed.signal])
    : failed.signal;

  let done = 0;
  onProgress?.({ done, total: chunks.length });
  const loadChunk = async ({ col, row, w, h }: (typeof chunks)[number]) => {
    const left = originX + col * cellSize;
    const top = originY - row * cellSize;
    const url = wmsGetMapUrl({
      layer,
      crs: "EPSG:2154",
      bbox: [left, top - h * cellSize, left + w * cellSize, top],
      width: w,
      height: h,
    });
    const res = await geopfFetch(url, { ...fetchOptions, signal });
    const tile = decodeBil32(await res.arrayBuffer(), w, h);
    for (let r = 0; r < h; r++) {
      data.set(tile.subarray(r * w, (r + 1) * w), (row + r) * width + col);
    }
    onProgress?.({ done: ++done, total: chunks.length });
  };

  const queue = [...chunks];
  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      for (let next = queue.shift(); next; next = queue.shift())
        await loadChunk(next);
    },
  );
  try {
    await Promise.all(workers);
  } catch (e) {
    failed.abort(e);
    throw e;
  }

  return {
    crs: "EPSG:2154",
    layer,
    cellSize,
    originX,
    originY,
    width,
    height,
    data,
  };
};

export const gridCellCenter = (
  g: ElevationGrid,
  col: number,
  row: number,
): XY => ({
  x: g.originX + (col + 0.5) * g.cellSize,
  y: g.originY - (row + 0.5) * g.cellSize,
});

/**
 * Bilinear elevation at a Lambert-93 point. Returns the nearest valid cell
 * when a neighbour is no-data, and NaN outside the grid.
 */
export const sampleGrid = (g: ElevationGrid, { x, y }: XY): number => {
  const fc = (x - g.originX) / g.cellSize - 0.5;
  const fr = (g.originY - y) / g.cellSize - 0.5;
  if (fc < -0.5 || fr < -0.5 || fc > g.width - 0.5 || fr > g.height - 0.5)
    return NaN;
  const c0 = Math.max(0, Math.min(g.width - 1, Math.floor(fc)));
  const r0 = Math.max(0, Math.min(g.height - 1, Math.floor(fr)));
  const c1 = Math.min(g.width - 1, c0 + 1);
  const r1 = Math.min(g.height - 1, r0 + 1);
  const tx = Math.max(0, Math.min(1, fc - c0));
  const ty = Math.max(0, Math.min(1, fr - r0));
  const v00 = g.data[r0 * g.width + c0];
  const v10 = g.data[r0 * g.width + c1];
  const v01 = g.data[r1 * g.width + c0];
  const v11 = g.data[r1 * g.width + c1];
  const v =
    (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
  if (!Number.isNaN(v)) return v;
  const nc = Math.round(fc) <= c0 ? c0 : c1;
  const nr = Math.round(fr) <= r0 ? r0 : r1;
  return g.data[nr * g.width + nc];
};

export const sampleGridLngLat = (g: ElevationGrid, p: LngLat) =>
  sampleGrid(g, lngLatToLambert93(p));

/** Percentiles (`qs` in 0..1) of the non-NaN `values`; NaN for each if none. */
export const percentiles = (
  values: ArrayLike<number>,
  qs: number[],
): number[] => {
  const valid = Array.from(values).filter((v) => !Number.isNaN(v));
  if (valid.length === 0) return qs.map(() => NaN);
  const sorted = Float64Array.from(valid).sort();
  return qs.map(
    (q) =>
      sorted[
        Math.min(
          sorted.length - 1,
          Math.max(0, Math.round(q * (sorted.length - 1))),
        )
      ],
  );
};

/**
 * Elevation percentiles over valid cells, from an evenly strided sample of
 * at most `maxSamples` cells. Used to fit a colour ramp to a field without
 * one ditch or levee crest stretching it.
 */
export const gridPercentiles = (
  g: ElevationGrid,
  qs: number[],
  maxSamples = 250_000,
): number[] => {
  const stride = Math.max(1, Math.floor(g.data.length / maxSamples));
  const sample: number[] = [];
  for (let i = 0; i < g.data.length; i += stride) sample.push(g.data[i]);
  return percentiles(sample, qs);
};

export type GridStats = {
  min: number;
  max: number;
  mean: number;
  validCells: number;
  nodataCells: number;
  /** Ground area of one cell in m², corrected for the Lambert-93 scale factor. */
  cellAreaM2: number;
};

export const gridStats = (g: ElevationGrid): GridStats => {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let valid = 0;
  for (const v of g.data) {
    if (Number.isNaN(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    valid++;
  }
  const centre = lambert93ToLngLat({
    x: g.originX + (g.width * g.cellSize) / 2,
    y: g.originY - (g.height * g.cellSize) / 2,
  });
  const k = lambert93ScaleFactor(centre.lat);
  return {
    min: valid ? min : NaN,
    max: valid ? max : NaN,
    mean: valid ? sum / valid : NaN,
    validCells: valid,
    nodataCells: g.data.length - valid,
    cellAreaM2: (g.cellSize / k) ** 2,
  };
};
