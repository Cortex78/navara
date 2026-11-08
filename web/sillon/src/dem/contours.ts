import { lambert93ToLngLat } from "../geo/lambert93";

/** Contour steps a surveyor would pick, in metres, finest first. */
const NICE_STEPS = [
  0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100,
];

/**
 * The finest nice step (0.02 m … 100 m) that puts at most `target` levels —
 * multiples of the step — across [min, max]: as many lines as still read as
 * relief. The coarsest step when none does, or when the range is not finite
 * (a grid with no data).
 */
export const autoInterval = (min: number, max: number, target = 12): number => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  // A hair of slack, so a bound that is itself a level (0.3 / 0.1 = 2.999…)
  // counts as one.
  const levels = (step: number) =>
    Math.floor(hi / step + 1e-9) - Math.ceil(lo / step - 1e-9) + 1;
  return (
    NICE_STEPS.find((step) => levels(step) <= target) ??
    NICE_STEPS[NICE_STEPS.length - 1]
  );
};

/**
 * Mean over ±r cells along each row, of the window's valid cells. Only
 * finite heights are valid: one Infinity in a running sum would leave
 * Inf − Inf = NaN in every cell after it.
 */
const meanAlongRows = (
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
) => {
  for (let row = 0; row < height; row++) {
    const o = row * width;
    let sum = 0;
    let count = 0;
    for (let col = 0; col < Math.min(r, width); col++) {
      const v = src[o + col];
      if (!Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    for (let col = 0; col < width; col++) {
      if (col + r < width) {
        const v = src[o + col + r];
        if (Number.isFinite(v)) {
          sum += v;
          count++;
        }
      }
      if (col > r) {
        const v = src[o + col - r - 1];
        if (Number.isFinite(v)) {
          sum -= v;
          count--;
        }
      }
      const v = src[o + col];
      dst[o + col] = Number.isFinite(v) ? sum / count : v;
    }
  }
};

/**
 * Mean over ±r cells along each column, sliding one running sum per column
 * down the rows so memory is read in order.
 */
const meanAlongColumns = (
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
) => {
  const sum = new Float64Array(width);
  const count = new Int32Array(width);
  const take = (row: number, sign: 1 | -1) => {
    const o = row * width;
    for (let col = 0; col < width; col++) {
      const v = src[o + col];
      if (!Number.isFinite(v)) continue;
      sum[col] += sign * v;
      count[col] += sign;
    }
  };
  for (let row = 0; row < Math.min(r, height); row++) take(row, 1);
  for (let row = 0; row < height; row++) {
    if (row + r < height) take(row + r, 1);
    if (row > r) take(row - r - 1, -1);
    const o = row * width;
    for (let col = 0; col < width; col++) {
      const v = src[o + col];
      dst[o + col] = Number.isFinite(v) ? sum[col] / count[col] : v;
    }
  }
};

/**
 * Smooths a height raster before contouring: raw 0.5 m LiDAR contoured at
 * 0.1 m draws stipple, not lines. A box mean over ±`radiusCells` along rows
 * then columns, both twice — close to a gaussian of σ = √(2r(r+1)/3) cells,
 * at a cost per cell independent of the radius. No-data cells (NaN, or any
 * non-finite height) neither take nor lend a value and come out unchanged:
 * each mean runs over the valid cells of its window, so a field's edge is
 * not pulled toward the NaN outside it and the mask is unchanged. A radius
 * under 0.5 returns a copy.
 */
export const smoothValues = (
  values: Float32Array,
  width: number,
  height: number,
  radiusCells: number,
): Float32Array => {
  if (values.length !== width * height)
    throw new RangeError(
      `${values.length} values for a ${width}x${height} grid`,
    );
  const r = Math.round(radiusCells);
  if (!(r > 0)) return values.slice();
  const a = new Float32Array(values.length);
  const b = new Float32Array(values.length);
  meanAlongRows(values, a, width, height, r);
  meanAlongColumns(a, b, width, height, r);
  meanAlongRows(b, a, width, height, r);
  meanAlongColumns(a, b, width, height, r);
  return b;
};

/** Past this many segments `contourLines` refuses rather than freeze the map. */
export const MAX_CONTOUR_SEGMENTS = 400_000;

export type ContourOptions = {
  /** Height between levels, in the values' unit (metres). */
  interval: number;
  /** Levels sit at base + n·interval; default 0. */
  base?: number;
  /** Every n-th level from `base` is major (drawn heavier); default 5, 0 for none. */
  majorEvery?: number;
};

/** Where a raster's cells lie, as in `ElevationGrid` (which is one). */
export type GridFrame = {
  originX: number;
  originY: number;
  cellSize: number;
  width: number;
  height: number;
};

export type ContourFeature = GeoJSON.Feature<
  GeoJSON.LineString,
  { level: number; major: boolean }
>;

// Square edges: 0 top, 1 right, 2 bottom, 3 left. Indexed by corner case
// (bits 8 top-left, 4 top-right, 2 bottom-right, 1 bottom-left, set when at
// or above the level): the segments as [from, to] edge pairs, run with higher
// ground on their left. Saddles 5 and 10 are given for a centre below.
const SEGMENTS: readonly (readonly number[])[] = [
  [],
  [2, 3],
  [1, 2],
  [1, 3],
  [0, 1],
  [0, 1, 2, 3],
  [0, 2],
  [0, 3],
  [3, 0],
  [2, 0],
  [3, 0, 1, 2],
  [1, 0],
  [3, 1],
  [2, 1],
  [3, 2],
  [],
];
// Saddles with the centre at or above the level: the high corners join.
const SADDLE_5_HIGH = [0, 3, 2, 1];
const SADDLE_10_HIGH = [1, 0, 3, 2];

/**
 * Chains one level's segments (`from[s]` → `to[s]`, point ids) into maximal
 * polylines. A point has as many segments in as out except where a line
 * meets the grid's or a no-data edge, so walks start where more leave than
 * enter and can only end where more enter; what is left are rings, which
 * end on their first point. A cell-centre point can have several segments
 * each way (lines touching there); any pairing makes valid lines.
 */
const joinSegments = (from: Int32Array, to: Int32Array): number[][] => {
  const n = from.length;
  // Each point's unused outgoing segments, as a list popped while walking.
  const head = new Map<number, number>();
  const next = new Int32Array(n);
  const surplus = new Map<number, number>();
  for (let s = n - 1; s >= 0; s--) {
    next[s] = head.get(from[s]) ?? -1;
    head.set(from[s], s);
    surplus.set(from[s], (surplus.get(from[s]) ?? 0) + 1);
    surplus.set(to[s], (surplus.get(to[s]) ?? 0) - 1);
  }
  const chains: number[][] = [];
  const walk = (start: number) => {
    const chain = [start];
    let p = start;
    let s = head.get(p) ?? -1;
    while (s >= 0) {
      head.set(p, next[s]);
      p = to[s];
      chain.push(p);
      s = head.get(p) ?? -1;
    }
    chains.push(chain);
  };
  for (let s = 0; s < n; s++) {
    const extra = surplus.get(from[s]) ?? 0;
    if (extra > 0) {
      surplus.set(from[s], extra - 1);
      walk(from[s]);
    }
  }
  for (let s = 0; s < n; s++) if ((head.get(from[s]) ?? -1) >= 0) walk(from[s]);
  return chains;
};

/**
 * Twice the area a closed line encloses, counted exactly on the 1e-7° grid
 * its points were rounded to: 0 for a ring that rounding flattened into a
 * speck or a sliver running out and back.
 */
const twiceRoundedArea = (ring: GeoJSON.Position[]) => {
  const [lng0, lat0] = ring[0];
  const step = (v: number, v0: number) => Math.round((v - v0) * 1e7);
  let twice = 0;
  for (let i = 2; i < ring.length; i++)
    twice +=
      step(ring[i - 1][0], lng0) * step(ring[i][1], lat0) -
      step(ring[i][0], lng0) * step(ring[i - 1][1], lat0);
  return twice;
};

/** Digits after the point in x's shortest decimal form: 0.25 → 2, 1e-7 → 7. */
const decimalsOf = (x: number) => {
  const [digits, exponent = "0"] = String(Math.abs(x)).split("e");
  return Math.max(0, (digits.split(".")[1]?.length ?? 0) - Number(exponent));
};

/**
 * Contour lines of a raster by marching squares over the cell centres
 * (Lambert-93), joined into maximal lines per level and returned in lng/lat
 * rounded to 1e-7° (≈ 1 cm), ordered by level.
 *
 * - A square with a no-data corner draws nothing, so lines stop at the edge
 *   of a field whose outside is NaN instead of diving toward it.
 * - Higher ground lies on each line's left: a ring round a summit runs
 *   counter-clockwise (like a GeoJSON outer ring), round a hollow clockwise.
 * - A height exactly on a level counts as just above it (an ε nudge, the
 *   same for every square), so a line through a cell centre is drawn once,
 *   and a summit or ridge crest that only touches a level draws nothing:
 *   no stretch is ever drawn twice, so a crest on the level between two
 *   hills leaves each hill its own ring. Lines that touch at such a cell
 *   centre may be paired either way there.
 * - Saddles take the side of the square's centre average.
 *
 * Throws a RangeError past MAX_CONTOUR_SEGMENTS: an interval finer than the
 * relief or its noise would produce a hairball too heavy to draw.
 */
export const contourLines = (
  frame: GridFrame,
  values: Float32Array,
  { interval, base = 0, majorEvery = 5 }: ContourOptions,
): ContourFeature[] => {
  const { originX, originY, cellSize, width: w, height: h } = frame;
  if (values.length !== w * h)
    throw new RangeError(`${values.length} values for a ${w}x${h} grid`);
  if (!(interval > 0 && interval < Infinity))
    throw new RangeError(`contour interval must be positive, not ${interval}`);
  if (!Number.isFinite(base))
    throw new RangeError(`contour base must be finite, not ${base}`);
  if (w < 2 || h < 2) return [];

  // Crossings are named by grid edge, so lines join exactly, never by
  // comparing coordinates: first the h·(w − 1) edges between cells k and
  // k + 1, then the (h − 1)·w between cells k and k + w. A crossing on a
  // cell centre (a height exactly on the level) is the same point by
  // whichever edge it came, so once the squares are done it is renamed
  // after its cell: onCell + k.
  const hEdges = h * (w - 1);
  const onCell = hEdges + (h - 1) * w;
  const byLevel = new Map<number, number[]>();
  const edge = new Int32Array(4);
  const tooMany = () =>
    new RangeError(
      `contours every ${interval} would take over ${MAX_CONTOUR_SEGMENTS} segments; use a larger interval`,
    );
  let count = 0;
  for (let row = 0; row + 1 < h; row++) {
    for (let col = 0; col + 1 < w; col++) {
      const k = row * w + col;
      const tl = values[k];
      const tr = values[k + 1];
      const br = values[k + w + 1];
      const bl = values[k + w];
      const lo = Math.min(tl, tr, br, bl);
      const hi = Math.max(tl, tr, br, bl);
      // A no-data or infinite corner (NaN fails every comparison), or a
      // flat square.
      if (!(lo < hi && hi - lo < Infinity)) continue;
      edge[0] = row * (w - 1) + col;
      edge[1] = hEdges + k + 1;
      edge[2] = edge[0] + w - 1;
      edge[3] = hEdges + k;
      // Only the levels in (lo, hi] cross; the bounds from division may
      // take in one more on either side, so each level is checked exactly.
      // All but those two would add a segment, so a wider span is refused
      // before looping (a counter, not n++, which stalls past 2^53).
      const first = Math.floor((lo - base) / interval);
      const span = Math.ceil((hi - base) / interval) - first;
      if (span > MAX_CONTOUR_SEGMENTS + 1) throw tooMany();
      for (let i = 0; i <= span; i++) {
        const n = first + i;
        const level = base + n * interval;
        if (!(level > lo && level <= hi)) continue;
        const c =
          (tl >= level ? 8 : 0) |
          (tr >= level ? 4 : 0) |
          (br >= level ? 2 : 0) |
          (bl >= level ? 1 : 0);
        let pairs = SEGMENTS[c];
        if ((c === 5 || c === 10) && (tl + tr + br + bl) / 4 >= level)
          pairs = c === 5 ? SADDLE_5_HIGH : SADDLE_10_HIGH;
        let segs = byLevel.get(n);
        if (!segs) byLevel.set(n, (segs = []));
        for (let p = 0; p < pairs.length; p += 2)
          segs.push(edge[pairs[p]], edge[pairs[p + 1]]);
        count += pairs.length / 2;
        if (count > MAX_CONTOUR_SEGMENTS) throw tooMany();
      }
    }
  }

  /** The point where `level` crosses edge `e`: the edge, or a cell on it. */
  const pointOf = (e: number, level: number) => {
    const k = e < hEdges ? e + Math.floor(e / (w - 1)) : e - hEdges;
    const k2 = e < hEdges ? k + 1 : k + w;
    if (values[k] === level) return onCell + k;
    if (values[k2] === level) return onCell + k2;
    return e;
  };

  /** Where point `p` lies at `level`, in lng/lat rounded to 1e-7°. */
  const position = (p: number, level: number): GeoJSON.Position => {
    let x: number;
    let y: number;
    if (p >= onCell) {
      const k = p - onCell;
      const row = Math.floor(k / w);
      x = originX + (k - row * w + 0.5) * cellSize;
      y = originY - (row + 0.5) * cellSize;
    } else if (p < hEdges) {
      const row = Math.floor(p / (w - 1));
      const k = p + row; // the edge's west cell
      const t = (level - values[k]) / (values[k + 1] - values[k]);
      x = originX + (k - row * w + 0.5 + t) * cellSize;
      y = originY - (row + 0.5) * cellSize;
    } else {
      const k = p - hEdges; // the edge's north cell
      const row = Math.floor(k / w);
      const t = (level - values[k]) / (values[k + w] - values[k]);
      x = originX + (k - row * w + 0.5) * cellSize;
      y = originY - (row + 0.5 + t) * cellSize;
    }
    const { lng, lat } = lambert93ToLngLat({ x, y });
    return [Math.round(lng * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
  };

  /**
   * One level's segments as points, without what a height exactly on the
   * level leaves behind: a segment from a cell centre to itself, and a crest
   * one cell wide lying on the level, which the line runs along once each
   * way. Both have zero width; kept, they would draw lines on top of each
   * other. Only two cell-centre points can be linked both ways: a crossing
   * inside an edge has one square on each side, each running the line
   * through it once.
   */
  const netSegments = (segs: number[], level: number) => {
    const m = segs.length / 2;
    const from = new Int32Array(m);
    const to = new Int32Array(m);
    const alive = new Uint8Array(m);
    // Cell-to-cell segments waiting for their reverse, by (from, to) cells:
    // under 2^53 for any grid below 94 million cells.
    const awaiting = new Map<number, number>();
    const pair = (a: number, b: number) => (a - onCell) * w * h + (b - onCell);
    for (let s = 0; s < m; s++) {
      const a = (from[s] = pointOf(segs[2 * s], level));
      const b = (to[s] = pointOf(segs[2 * s + 1], level));
      if (a === b) continue;
      alive[s] = 1;
      if (a < onCell || b < onCell) continue;
      const twin = awaiting.get(pair(b, a));
      if (twin === undefined) awaiting.set(pair(a, b), s);
      else {
        awaiting.delete(pair(b, a));
        alive[s] = alive[twin] = 0;
      }
    }
    let n = 0;
    for (let s = 0; s < m; s++) {
      if (!alive[s]) continue;
      from[n] = from[s];
      to[n] = to[s];
      n++;
    }
    return [from.subarray(0, n), to.subarray(0, n)] as const;
  };

  // Levels as the decimals they stand for: 3 × 0.1 reads 0.3, not
  // 0.30000000000000004, and base 0.3 − 3 × 0.1 reads 0, not -5.55e-17.
  const decimals = Math.max(decimalsOf(base), decimalsOf(interval));
  const label = (level: number) =>
    (decimals <= 15
      ? Number(level.toFixed(decimals))
      : Number(level.toPrecision(15))) + 0; // + 0: no -0

  const features: ContourFeature[] = [];
  for (const [n, segs] of [...byLevel].sort((a, b) => a[0] - b[0])) {
    const level = base + n * interval;
    const [from, to] = netSegments(segs, level);
    for (const chain of joinSegments(from, to)) {
      // Points closer than the rounding (a crossing a hair from a cell
      // centre) collapse into one.
      const coordinates: GeoJSON.Position[] = [];
      for (const p of chain) {
        const q = position(p, level);
        const last = coordinates[coordinates.length - 1];
        if (!last || last[0] !== q[0] || last[1] !== q[1]) coordinates.push(q);
      }
      // A ring with no area once rounded is a speck under the rounding (a
      // cell a hair past the level), not a line to draw.
      const closed = chain[0] === chain[chain.length - 1];
      if (closed ? twiceRoundedArea(coordinates) === 0 : coordinates.length < 2)
        continue;
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {
          level: label(level),
          major: majorEvery > 0 && n % majorEvery === 0,
        },
      });
    }
  }
  return features;
};
