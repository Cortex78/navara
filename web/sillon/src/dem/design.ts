import { lambert93ScaleFactor } from "../geo/lambert93";

import type { ElevationGrid } from "./elevationGrid";
import { maskGridCells, type LngLatPolygon } from "./fieldMask";
import { fitPlaneBy, planeHeight, type PlaneFit } from "./planeFit";

/**
 * A field cut out of a loaded grid: the bounding box of its cells, with
 * heights kept only inside it. The design kernels loop over this window, not
 * over the whole grid, which may hold a block of farmland around the field.
 */
export type FieldWindow = {
  /** The cropped grid: heights inside the field, NaN outside it or with no data. */
  grid: ElevationGrid;
  /** 1 where the cell centre is inside the field, even if it has no height. */
  inside: Uint8Array;
  /** Ground m² per cell: (cellSize / k)². */
  cellArea: number;
  /** Lambert-93 scale factor at the field: a map metre covers 1 / k ground metres. */
  k: number;
  /** Ground area of the cells inside, m². */
  areaM2: number;
  /** Cells inside that have a height. */
  validCount: number;
};

const cellX = (g: ElevationGrid, col: number) =>
  g.originX + (col + 0.5) * g.cellSize;
const cellY = (g: ElevationGrid, row: number) =>
  g.originY - (row + 0.5) * g.cellSize;

/**
 * Crops `g` to the cells whose centres fall inside the polygons. Null when
 * the field covers no cell centre; a field with no heights at all still gets
 * a window (`validCount` 0) so its area can be shown.
 */
export const fieldWindow = (
  g: ElevationGrid,
  polygons: LngLatPolygon[],
): FieldWindow | null => {
  const cells = maskGridCells(g, polygons);
  if (cells.length === 0) return null;
  let c0 = g.width;
  let c1 = 0;
  let r0 = g.height;
  let r1 = 0;
  for (const i of cells) {
    const col = i % g.width;
    const row = (i - col) / g.width;
    if (col < c0) c0 = col;
    if (col > c1) c1 = col;
    if (row < r0) r0 = row;
    if (row > r1) r1 = row;
  }
  const width = c1 - c0 + 1;
  const height = r1 - r0 + 1;
  const data = new Float32Array(width * height).fill(NaN);
  const inside = new Uint8Array(width * height);
  for (const i of cells) {
    const col = i % g.width;
    const j = ((i - col) / g.width - r0) * width + col - c0;
    data[j] = g.data[i];
    inside[j] = 1;
  }
  // Counted on the window, so a cell listed twice by the mask counts once.
  let count = 0;
  let validCount = 0;
  for (let j = 0; j < inside.length; j++) {
    if (!inside[j]) continue;
    count++;
    if (!Number.isNaN(data[j])) validCount++;
  }
  const outer = polygons.flatMap((p) => p[0] ?? []);
  const pts = outer.length ? outer : polygons.flat(2);
  const k = lambert93ScaleFactor(
    pts.reduce((s, p) => s + p.lat, 0) / pts.length,
  );
  const cellArea = (g.cellSize / k) ** 2;
  return {
    grid: {
      crs: g.crs,
      layer: g.layer,
      cellSize: g.cellSize,
      originX: g.originX + c0 * g.cellSize,
      originY: g.originY - r0 * g.cellSize,
      width,
      height,
      data,
    },
    inside,
    cellArea,
    k,
    areaM2: count * cellArea,
    validCount,
  };
};

/**
 * Design surface z = z0 + gx·(x − x0) + gy·(y − y0) with gradients per
 * Lambert-93 (map) metre, so it is evaluated straight on grid coordinates.
 */
export type DesignPlane = {
  x0: number;
  y0: number;
  z0: number;
  gx: number;
  gy: number;
};

export const designHeight = (p: DesignPlane, x: number, y: number) =>
  p.z0 + p.gx * (x - p.x0) + p.gy * (y - p.y0);

/**
 * Ground slope of a design in percent, and the bearing it falls toward in
 * degrees clockwise from grid north (0 when flat). A ground metre spans k
 * map metres, so the ground slope is k times the map gradient.
 */
export const planeFall = (
  p: DesignPlane,
  k: number,
): { slopePct: number; fallDeg: number } => {
  const grad = Math.hypot(p.gx, p.gy);
  if (!(grad > 0)) return { slopePct: 0, fallDeg: 0 };
  const deg = (Math.atan2(-p.gx, -p.gy) * 180) / Math.PI;
  return { slopePct: grad * k * 100, fallDeg: (deg + 360) % 360 };
};

/**
 * What the design surface keeps: the field's natural fall (`fit`, the least
 * earth moved), dead level (`level`, rice basins), or a set fall (`slope`):
 * `mainPct` % per ground metre toward `bearingDeg` (clockwise from grid
 * north) plus `crossPct` % toward `bearingDeg + 90°`, for surface drainage
 * to a chosen side. Negative percentages rise.
 */
export type DesignSpec =
  | { mode: "fit" }
  | { mode: "level" }
  | { mode: "slope"; mainPct: number; bearingDeg: number; crossPct: number };

/**
 * The field's natural fall by the rule `fieldSurface` uses: least squares on
 * the cells with a height, refitted once without those more than 3 RMS off
 * the first plane, so ditches, levees and trees left in the DTM do not tilt
 * it. Null with fewer than three cells or when their centres are collinear.
 */
export const robustFit = (w: FieldWindow): PlaneFit | null => {
  const { grid: g, inside } = w;
  const n = g.data.length;
  const x = (i: number) => cellX(g, i % g.width);
  const y = (i: number) => cellY(g, Math.floor(i / g.width));
  const z = (i: number) => g.data[i];
  const valid = (i: number) => inside[i] !== 0 && !Number.isNaN(g.data[i]);
  const first = fitPlaneBy(n, x, y, z, valid);
  if (!first || !(first.rms > 0)) return first;
  const limit = 3 * first.rms;
  return (
    fitPlaneBy(
      n,
      x,
      y,
      z,
      (i) =>
        valid(i) &&
        Math.abs(g.data[i] - planeHeight(first, x(i), y(i))) <= limit,
    ) ?? first
  );
};

/** Map gradients of a spec; `fit` is used only in `fit` mode. */
const specGradients = (
  spec: DesignSpec,
  k: number,
  fit: PlaneFit | null,
): { gx: number; gy: number } => {
  switch (spec.mode) {
    case "level":
      return { gx: 0, gy: 0 };
    case "fit":
      return fit ? { gx: fit.dzdx, gy: fit.dzdy } : { gx: 0, gy: 0 };
    case "slope": {
      const { mainPct, bearingDeg, crossPct } = spec;
      if (![mainPct, bearingDeg, crossPct].every(Number.isFinite))
        throw new RangeError(
          `slope design needs finite numbers, got ${mainPct} % toward ${bearingDeg}°, cross ${crossPct} %`,
        );
      // Per-ground-metre falls become per-map-metre gradients (÷ k). The
      // design drops `main` along the bearing (sin θ, cos θ) and `cross`
      // along the bearing turned 90° clockwise (cos θ, −sin θ).
      const t = (bearingDeg * Math.PI) / 180;
      const main = mainPct / 100 / k;
      const cross = crossPct / 100 / k;
      return {
        gx: -(main * Math.sin(t) + cross * Math.cos(t)),
        gy: -(main * Math.cos(t) - cross * Math.sin(t)),
      };
    }
  }
};

/**
 * The design plane for a spec, through the centroid of the cells with a
 * height at their mean height: there cut equals fill, so `balance` only
 * moves it for another ratio. `fit` reuses an earlier `robustFit` (null:
 * none could be fitted, so the design is level); left out, it is fitted
 * here. With no heights at all, z0 is NaN.
 */
export const designPlane = (
  w: FieldWindow,
  spec: DesignSpec,
  fit?: PlaneFit | null,
): DesignPlane => {
  const { grid: g, inside } = w;
  // Sums in cells from the window corner stay small at Lambert-93 magnitudes.
  let n = 0;
  let sc = 0;
  let sr = 0;
  let sz = 0;
  for (let row = 0, i = 0; row < g.height; row++) {
    for (let col = 0; col < g.width; col++, i++) {
      const z = g.data[i];
      if (!inside[i] || Number.isNaN(z)) continue;
      n++;
      sc += col;
      sr += row;
      sz += z;
    }
  }
  const gradients = specGradients(
    spec,
    w.k,
    spec.mode === "fit" ? (fit === undefined ? robustFit(w) : fit) : null,
  );
  return n
    ? {
        x0: cellX(g, sc / n),
        y0: cellY(g, sr / n),
        z0: sz / n,
        ...gradients,
      }
    : {
        x0: cellX(g, (g.width - 1) / 2),
        y0: cellY(g, (g.height - 1) / 2),
        z0: NaN,
        ...gradients,
      };
};

/** Existing minus design height at each cell inside with a height, and their range. */
const residuals = (w: FieldWindow, p: DesignPlane) => {
  const { grid: g, inside } = w;
  const out = new Float64Array(g.data.length);
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let row = 0, i = 0; row < g.height; row++) {
    const y = cellY(g, row);
    for (let col = 0; col < g.width; col++, i++) {
      const z = g.data[i];
      if (!inside[i] || Number.isNaN(z)) continue;
      const d = z - designHeight(p, cellX(g, col), y);
      out[n++] = d;
      if (d < min) min = d;
      if (d > max) max = d;
    }
  }
  return { r: out.subarray(0, n), min, max };
};

const BINS = 1024;
/** Bins this small are sorted outright. */
const SORT_AT = 4096;

const binOf = (v: number, lo: number, scale: number) =>
  Math.min(BINS - 1, Math.floor((v - lo) * scale));

/**
 * The shift δ of the design for which cut = ratio × fill, with r the
 * residuals (existing − design) spanning [min, max]:
 * Σ max(r − δ, 0) = ratio · Σ max(δ − r, 0). Cut falls and fill grows with
 * δ, so the root is unique, inside one linear piece between two sorted
 * residuals. Sorting a million residuals takes over 100 ms, so histograms
 * narrow the root to one bin in linear passes and only that bin is sorted
 * to solve its piece exactly.
 */
const balanceShift = (
  r: Float64Array,
  min: number,
  max: number,
  ratio: number,
): number => {
  if (r.length === 0) return 0;
  if (ratio === 0) return max;
  if (ratio === Infinity) return min;
  // Weighted as wc·cut = wf·fill, which no finite ratio can overflow.
  const wc = 1 / (1 + ratio);
  const wf = ratio / (1 + ratio);
  // Residuals already known to lie below / above the bin being narrowed.
  let nLo = 0;
  let sLo = 0;
  let nHi = 0;
  let sHi = 0;
  let bin = r;
  // A few levels reach a small bin on any real field; the cap bounds the
  // passes when a spike crowds everything else into one bin level after level.
  for (let level = 0; bin.length > SORT_AT && level < 8; level++) {
    const scale = BINS / (max - min);
    // All equal, or too close together to bin: sort what is left.
    if (!(scale < Infinity)) break;
    const lo = min;
    const count = new Uint32Array(BINS);
    const sum = new Float64Array(BINS);
    let total = 0;
    // Indexed: `for…of` over a typed array runs several times slower until
    // the JIT warms up, and this pass sees every cell of the field.
    // eslint-disable-next-line @typescript-eslint/prefer-for-of
    for (let i = 0; i < bin.length; i++) {
      const v = bin[i];
      const b = binOf(v, lo, scale);
      count[b]++;
      sum[b] += v;
      total += v;
    }
    // First bin whose upper edge leaves fill outweighing cut.
    let pick = 0;
    let nBelow = nLo;
    let sBelow = sLo;
    for (; pick < BINS - 1; pick++) {
      const nB = nBelow + count[pick];
      const sB = sBelow + sum[pick];
      const e = lo + (pick + 1) / scale;
      const nA = nHi + nLo + bin.length - nB;
      const sA = sHi + sLo + total - sB;
      if (wc * (sA - nA * e) - wf * (nB * e - sB) <= 0) break;
      nBelow = nB;
      sBelow = sB;
    }
    nLo = nBelow;
    sLo = sBelow;
    for (let b = pick + 1; b < BINS; b++) {
      nHi += count[b];
      sHi += sum[b];
    }
    const next = new Float64Array(count[pick]);
    min = Infinity;
    max = -Infinity;
    for (let i = 0, j = 0; i < bin.length; i++) {
      const v = bin[i];
      if (binOf(v, lo, scale) !== pick) continue;
      next[j++] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    bin = next;
  }
  // Piece j lies between the j-th and (j+1)-th sorted residuals of the bin;
  // on it both sums are linear in δ. The first piece whose own root falls
  // at or before its upper end holds the root.
  bin.sort();
  let sAll = 0;
  for (const v of bin) sAll += v;
  let sBin = 0;
  for (let j = 0; j <= bin.length; j++) {
    const d =
      (wc * (sHi + sAll - sBin) + wf * (sLo + sBin)) /
      (wc * (nHi + bin.length - j) + wf * (nLo + j));
    if (j === bin.length || d <= bin[j])
      return j > 0 ? Math.max(d, bin[j - 1]) : d;
    sBin += bin[j];
  }
  return 0;
};

/**
 * At ratio 0 (Infinity) the shift lays the design exactly on the highest
 * (lowest) cell, but adding it to z0 rounds, which can leave that cell
 * 1e-16 m on the wrong side as `earthworks` recomputes it: a sliver of cut
 * (fill) that makes the ratio finite and puts the haul's end on it. Moves
 * the design `up` (or down) past it, a few units in the last place at a
 * time and doubling, until no cell is left on the wrong side.
 */
const clearExtreme = (
  w: FieldWindow,
  plane: DesignPlane,
  up: boolean,
): DesignPlane => {
  let z0 = plane.z0;
  for (let step = 1; step <= 64; step++) {
    const { min, max } = residuals(w, { ...plane, z0 });
    const over = up ? max : -min;
    if (!(over > 0)) break;
    z0 += (up ? 1 : -1) * (over + Math.abs(z0) * Number.EPSILON) * 2 ** step;
  }
  return { ...plane, z0 };
};

/**
 * Raises or lowers the design until cut = ratio × fill: 1 balances them,
 * above 1 leaves spare cut for fill that shrinks as it is compacted, 0
 * allows no cut and Infinity no fill. The plane is returned unchanged when
 * the field has no heights; on a field the design already meets everywhere,
 * cut = fill = 0 whatever the ratio.
 */
export const balance = (
  w: FieldWindow,
  plane: DesignPlane,
  ratio = 1,
): DesignPlane => {
  if (!(ratio >= 0))
    throw new RangeError(`cut:fill ratio must be 0 or more, got ${ratio}`);
  const { r, min, max } = residuals(w, plane);
  if (r.length === 0) return plane;
  const shifted = {
    ...plane,
    z0: plane.z0 + balanceShift(r, min, max, ratio),
  };
  return ratio === 0 || ratio === Infinity
    ? clearExtreme(w, shifted, ratio === 0)
    : shifted;
};

/** Earth moved to bring the field to a design. Volumes in ground m³. */
export type Earthworks = {
  cutM3: number;
  fillM3: number;
  /** cut / fill: Infinity when only cut, 1 when neither. */
  ratio: number;
  /** cut − fill: positive is surplus soil to haul off, negative soil to bring in. */
  netM3: number;
  /** Area cut or filled by `onGradeM` or more, and the rest. */
  cutAreaHa: number;
  fillAreaHa: number;
  onGradeAreaHa: number;
  /** Deepest cut and fill, as positive depths in metres. */
  maxCutM: number;
  maxFillM: number;
  /** Mean earth moved per square metre with data: (cut + fill) / area. */
  meanDepthM: number;
  /** Cut per hectare of field. */
  m3PerHa: number;
  /**
   * Ground distance between the volume-weighted centroids of cut and of
   * fill: the mean haul if every load went centroid to centroid. 0 if
   * either is 0.
   */
  haulM: number;
  /** Per window cell: existing − design (+ cut, − fill); NaN outside or no data. */
  depth: Float32Array;
};

/**
 * Cut and fill per cell for a design, summed into volumes, areas and haul.
 * Cells within ±`onGradeM` of the design count as on grade, a band a
 * levelling blade does not resolve; volumes still count every millimetre.
 */
export const earthworks = (
  w: FieldWindow,
  plane: DesignPlane,
  onGradeM = 0.02,
): Earthworks => {
  const { grid: g, inside, cellArea } = w;
  const depth = new Float32Array(g.data.length).fill(NaN);
  let n = 0;
  let cut = 0;
  let fill = 0;
  let nCut = 0;
  let nFill = 0;
  let maxCut = 0;
  let maxFill = 0;
  // Volume-weighted positions in cells, so the haul needs no Lambert-93 sums.
  let cutCol = 0;
  let cutRow = 0;
  let fillCol = 0;
  let fillRow = 0;
  for (let row = 0, i = 0; row < g.height; row++) {
    const y = cellY(g, row);
    for (let col = 0; col < g.width; col++, i++) {
      const z = g.data[i];
      if (!inside[i] || Number.isNaN(z)) continue;
      const d = z - designHeight(plane, cellX(g, col), y);
      if (Number.isNaN(d)) continue;
      depth[i] = d;
      n++;
      if (d > 0) {
        cut += d;
        cutCol += d * col;
        cutRow += d * row;
        if (d > maxCut) maxCut = d;
        if (d >= onGradeM) nCut++;
      } else if (d < 0) {
        fill -= d;
        fillCol -= d * col;
        fillRow -= d * row;
        if (-d > maxFill) maxFill = -d;
        if (-d >= onGradeM) nFill++;
      }
    }
  }
  const cutM3 = cut * cellArea;
  const fillM3 = fill * cellArea;
  const ha = cellArea / 1e4;
  return {
    cutM3,
    fillM3,
    ratio: fill > 0 ? cut / fill : cut > 0 ? Infinity : 1,
    netM3: cutM3 - fillM3,
    cutAreaHa: nCut * ha,
    fillAreaHa: nFill * ha,
    onGradeAreaHa: (n - nCut - nFill) * ha,
    maxCutM: maxCut,
    maxFillM: maxFill,
    meanDepthM: n ? (cut + fill) / n : 0,
    m3PerHa: w.areaM2 > 0 ? cutM3 / (w.areaM2 / 1e4) : 0,
    haulM:
      cut > 0 && fill > 0
        ? (Math.hypot(
            cutCol / cut - fillCol / fill,
            cutRow / cut - fillRow / fill,
          ) *
            g.cellSize) /
          w.k
        : 0,
    depth,
  };
};

/**
 * Design heights over the field's cells (NaN outside it), where the
 * existing ground has no height too: the surface design contours trace.
 */
export const designGrid = (w: FieldWindow, p: DesignPlane): ElevationGrid => {
  const { grid: g, inside } = w;
  const data = new Float32Array(g.data.length).fill(NaN);
  for (let row = 0, i = 0; row < g.height; row++) {
    const y = cellY(g, row);
    for (let col = 0; col < g.width; col++, i++)
      if (inside[i]) data[i] = designHeight(p, cellX(g, col), y);
  }
  return { ...g, data };
};

/**
 * One design pass: the spec's plane balanced to `ratio` (default 1), then
 * raised (+) or lowered (−) by `offsetM`, with its earthworks and its fall.
 * `fit` reuses an earlier `robustFit`, so dragging a slider does not refit.
 */
export const design = (
  w: FieldWindow,
  spec: DesignSpec,
  opts: { ratio?: number; offsetM?: number; onGradeM?: number } = {},
  fit?: PlaneFit | null,
): {
  plane: DesignPlane;
  works: Earthworks;
  fall: { slopePct: number; fallDeg: number };
} => {
  const { ratio = 1, offsetM = 0, onGradeM } = opts;
  if (!Number.isFinite(offsetM))
    throw new RangeError(`design offset must be finite, got ${offsetM}`);
  const balanced = balance(w, designPlane(w, spec, fit), ratio);
  const plane = offsetM ? { ...balanced, z0: balanced.z0 + offsetM } : balanced;
  return {
    plane,
    works: earthworks(w, plane, onGradeM),
    fall: planeFall(plane, w.k),
  };
};

/** Directions the haul estimate projects on (spread over 180°). */
const HAUL_DIRECTIONS = 8;

/**
 * A lower bound on the mean haul, in ground metres: the largest, over
 * eight directions, of the one-dimensional transport distance
 * (Wasserstein-1) between the cut and the fill projected on that direction,
 * each scaled to unit volume. The centroid distance (`haulM`) collapses to
 * zero when cut and fill interleave, as they always do around a best-fit
 * plane, yet the soil still travels from each hump to the nearby dips; this
 * does not. Any true assignment of cut to fill hauls at least this far on
 * average, so the instrument reads it as "≥".
 */
export const transportHaulM = (w: FieldWindow, depth: Float32Array): number => {
  const g = w.grid;
  const cs = g.cellSize;
  let cut = 0;
  let fill = 0;
  for (const v of depth) {
    if (v > 0) cut += v;
    else if (v < 0) fill -= v;
  }
  if (!(cut > 0) || !(fill > 0)) return 0;
  const W = g.width * cs;
  const H = g.height * cs;
  let best = 0;
  for (let k = 0; k < HAUL_DIRECTIONS; k++) {
    const a = (k * Math.PI) / HAUL_DIRECTIONS;
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    // Window-relative coordinates: x to the east, y up (rows run south).
    const corners = [0, W * ux, -H * uy, W * ux - H * uy];
    const lo = Math.min(...corners);
    const n = Math.ceil((Math.max(...corners) - lo) / cs) + 2;
    const hc = new Float64Array(n);
    const hf = new Float64Array(n);
    for (let row = 0, i = 0; row < g.height; row++) {
      const y = -(row + 0.5) * cs;
      for (let col = 0; col < g.width; col++, i++) {
        const v = depth[i];
        if (!(v > 0 || v < 0)) continue; // zero or NaN
        // Cloud-in-cell: split the volume between the two nearest bins.
        const t = ((col + 0.5) * cs * ux + y * uy - lo) / cs;
        const b = Math.floor(t);
        const f = t - b;
        const h = v > 0 ? hc : hf;
        const m = Math.abs(v);
        h[b] += m * (1 - f);
        h[b + 1] += m * f;
      }
    }
    let cc = 0;
    let cf = 0;
    let w1 = 0;
    for (let b = 0; b < n; b++) {
      cc += hc[b] / cut;
      cf += hf[b] / fill;
      w1 += Math.abs(cc - cf);
    }
    best = Math.max(best, w1 * cs);
  }
  return best / w.k;
};
