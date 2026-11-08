import { lambert93ToLngLat } from "../geo/lambert93";

/**
 * The cut/fill map: per-cell depth (existing − design: + cut, − fill) as
 * RGBA for a MapLibre image source, with its legend and its corners. Cut is
 * warm and fill cool so the two sides never read as one ramp; cells on grade
 * get a faint veil rather than nothing, so the field still shows where no
 * earth moves.
 */

/** A colour, 0..255 per channel. */
export type Rgb = [number, number, number];

/** Colour stops of each side from shallow to deep, and the RGBA of cells on grade. */
export type CutFillRamp = {
  cut: Rgb[];
  fill: Rgb[];
  grade: [number, number, number, number];
};

/**
 * Provisional GAïa colours: cut peach → signal orange → burnt (soil to take
 * off), fill periwinkle → cobalt → indigo (soil to bring), on grade a bone
 * veil at 18 % that leaves the imagery readable.
 */
export const DEFAULT_CUT_FILL_RAMP: CutFillRamp = {
  cut: [
    [0xff, 0xd2, 0xb8],
    [0xff, 0x9a, 0x66],
    [0xff, 0x6b, 0x26],
    [0xb8, 0x42, 0x0a],
  ],
  fill: [
    [0xc9, 0xd3, 0xff],
    [0x7c, 0x9a, 0xff],
    [0x3c, 0x62, 0xff],
    [0x1e, 0x1e, 0xa8],
  ],
  grade: [236, 232, 220, 46],
};

export type CutFillStyle = {
  /** Depth class width in metres, at least 1 µm; 0 for a continuous ramp. */
  bandM: number;
  /** Depth in metres where the colours reach the deep end and stay there. */
  maxM: number;
  /** |depth| below this is on grade, as in `earthworks`. */
  onGradeM: number;
  /** 0..1, multiplies every colour's opacity. */
  alpha: number;
};

/**
 * Depths are float32, so a 5 cm edge may be stored as 0.0499999: within a
 * micrometre of an edge counts as on it, and an edge belongs to the deeper
 * class (as `earthworks` counts |depth| = onGradeM as moved earth).
 */
const SLACK_M = 1e-6;

const AUTO_STEP_CM = 5;
/** Depths past this many steps (1 km) share the last bin. */
const AUTO_MAX_STEPS = 20_000;

/**
 * Saturation depth for a cut/fill map: the 98th percentile of |depth| (NaN
 * ignored, nearest rank as in `percentiles`), rounded up to 5 cm, at least
 * 5 cm. A percentile, so one ditch being filled does not wash the field out;
 * counted in 5 cm bins, so a 4-million-cell window takes one pass and no sort.
 */
export const autoMaxDepth = (depth: Float32Array): number => {
  const step = AUTO_STEP_CM / 100;
  const counts = new Uint32Array(AUTO_MAX_STEPS + 1);
  let n = 0;
  // Indexed: `for…of` over a typed array measured 3× slower here (60 ms vs
  // 20 ms on 4 M cells), and this runs on every design change.
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i];
    if (Number.isNaN(d)) continue;
    const s = Math.ceil((Math.abs(d) - SLACK_M) / step);
    counts[s <= 0 ? 0 : Math.min(s, AUTO_MAX_STEPS)]++;
    n++;
  }
  if (n === 0) return step;
  const rank = Math.round(0.98 * (n - 1));
  let s = 0;
  let seen = counts[0];
  while (seen <= rank) seen += counts[++s];
  return (Math.max(1, s) * AUTO_STEP_CM) / 100;
};

const checkStyle = ({ bandM, maxM, onGradeM, alpha }: CutFillStyle) => {
  if (!(maxM > 0 && maxM < Infinity))
    throw new RangeError(`cut/fill maxM must be a positive depth, got ${maxM}`);
  // Narrower than the micrometre edges are resolved to, a band means
  // nothing; a subnormal one overflows depth / bandM to Infinity.
  if (!(bandM === 0 || (bandM >= SLACK_M && bandM < Infinity)))
    throw new RangeError(
      `cut/fill bandM must be 0 (continuous) or at least 1 µm, got ${bandM}`,
    );
  if (!(onGradeM >= 0 && onGradeM < Infinity))
    throw new RangeError(
      `cut/fill onGradeM must be 0 or more, got ${onGradeM}`,
    );
  if (!(alpha >= 0 && alpha <= 1))
    throw new RangeError(`cut/fill alpha must be within 0..1, got ${alpha}`);
};

/**
 * The first band whose centre reaches maxM: it and every deeper band paint
 * the deep end. Settled with the same `(k + 0.5) · bandM >= maxM` the
 * painter evaluates, so the two agree at the edge.
 */
const saturatedBand = (bandM: number, maxM: number) => {
  let k = Math.max(0, Math.ceil(maxM / bandM - 0.5));
  if (k > 0 && (k - 0.5) * bandM >= maxM) k--;
  if ((k + 0.5) * bandM < maxM) k++;
  return k;
};

/** Past this many bands a side, banding is as fine as continuous: no table. */
const MAX_TABLE_BANDS = 4096;

/**
 * The one colour rule, shared by `rampColor`, `cutFillRgba` and the legend
 * so they cannot drift apart. It writes to a Uint8ClampedArray, which rounds
 * and clamps as canvas ImageData does, and allocates nothing per cell.
 */
const colourRule = (ramp: CutFillRamp, style: CutFillStyle) => {
  checkStyle(style);
  if (ramp.cut.length === 0 || ramp.fill.length === 0)
    throw new RangeError("a cut/fill ramp needs at least one colour a side");
  const { bandM, maxM, onGradeM } = style;
  const { cut, fill, grade } = ramp;
  const opaque = 255 * style.alpha;
  // Exactly 0 is on grade even with no on-grade band: it is neither side.
  const gradeBelow = Math.max(onGradeM - SLACK_M, Number.MIN_VALUE);
  const band = (a: number) => Math.floor((a + SLACK_M) / bandM);

  /** One side's ramp at |depth| x, saturating at maxM. */
  const rampAt = (
    stops: Rgb[],
    x: number,
    out: Uint8ClampedArray,
    o: number,
  ) => {
    const p = (x >= maxM ? 1 : x / maxM) * (stops.length - 1);
    const k = Math.floor(p);
    const f = p - k;
    const lo = stops[k];
    const hi = stops[Math.min(k + 1, stops.length - 1)];
    out[o] = lo[0] + (hi[0] - lo[0]) * f;
    out[o + 1] = lo[1] + (hi[1] - lo[1]) * f;
    out[o + 2] = lo[2] + (hi[2] - lo[2]) * f;
    out[o + 3] = opaque;
  };

  /** Writes the RGBA of one depth to `out[o..o + 3]`. */
  const paint = (d: number, out: Uint8ClampedArray, o: number) => {
    if (Number.isNaN(d)) {
      out.fill(0, o, o + 4);
      return;
    }
    const a = Math.abs(d);
    if (a < gradeBelow) {
      out[o] = grade[0];
      out[o + 1] = grade[1];
      out[o + 2] = grade[2];
      out[o + 3] = grade[3] * style.alpha;
      return;
    }
    // A band paints the colour of its centre depth.
    rampAt(d > 0 ? cut : fill, bandM > 0 ? (band(a) + 0.5) * bandM : a, out, o);
  };

  /**
   * Paints a grid; NaN cells are left as they are. Banded, the few band
   * colours are worked out once and copied four bytes at a time: 4 M cells
   * in ~20 ms rather than ~80.
   */
  const paintAll = (depth: Float32Array, out: Uint8ClampedArray) => {
    const last = bandM > 0 ? saturatedBand(bandM, maxM) : Infinity;
    if (last > MAX_TABLE_BANDS) {
      for (let i = 0; i < depth.length; i++) {
        const d = depth[i];
        if (!Number.isNaN(d)) paint(d, out, i * 4);
      }
      return;
    }
    // Cut bands 0..last, then fill bands 0..last, then on grade.
    const table = new Uint8ClampedArray((2 * last + 3) * 4);
    for (let k = 0; k <= last; k++) {
      rampAt(cut, (k + 0.5) * bandM, table, k * 4);
      rampAt(fill, (k + 0.5) * bandM, table, (last + 1 + k) * 4);
    }
    const onGrade = 2 * last + 2;
    paint(0, table, onGrade * 4);
    // Whole pixels as 32-bit words: bytes keep their order, whatever the endianness.
    const pixels = new Uint32Array(table.buffer);
    const out32 = new Uint32Array(out.buffer, out.byteOffset, out.length / 4);
    for (let i = 0; i < depth.length; i++) {
      const d = depth[i];
      if (Number.isNaN(d)) continue;
      const a = Math.abs(d);
      out32[i] =
        pixels[
          a < gradeBelow
            ? onGrade
            : Math.min(band(a), last) + (d > 0 ? 0 : last + 1)
        ];
    }
  };

  return { paint, paintAll };
};

/**
 * RGBA of one depth: clear for NaN, the grade veil within ±onGradeM, else
 * the cut (d > 0) or fill (d < 0) ramp at min(|d|, maxM) / maxM — at the
 * band's centre depth when banded. Exactly what `cutFillRgba` paints.
 */
export const rampColor = (
  ramp: CutFillRamp,
  style: CutFillStyle,
  depth: number,
): [number, number, number, number] => {
  const px = new Uint8ClampedArray(4);
  colourRule(ramp, style).paint(depth, px, 0);
  return [px[0], px[1], px[2], px[3]];
};

/**
 * The map as straight-alpha RGBA, row 0 north like the depth grid, for
 * `encodePngRgba` or ImageData. Cells with no depth (outside the field)
 * stay clear.
 */
export const cutFillRgba = (
  depth: Float32Array,
  width: number,
  height: number,
  ramp: CutFillRamp,
  style: CutFillStyle,
): Uint8ClampedArray<ArrayBuffer> => {
  if (depth.length !== width * height)
    throw new RangeError(
      `depth has ${depth.length} cells, not ${width}×${height}`,
    );
  const out = new Uint8ClampedArray(depth.length * 4);
  colourRule(ramp, style).paintAll(depth, out);
  return out;
};

export type LegendStop = {
  /** Signed depths in metres, from < to; the deepest classes run to ±Infinity. */
  from: number;
  to: number;
  /** CSS hex of the colour the map paints at the label's depth; #rrggbbaa if not opaque. */
  color: string;
  /** The depth the class starts at, nearest zero: "−0.15 m", "on grade ±2 cm", "+0.10 m". */
  label: string;
};

/** Classes a side, so a legend holds at most 11 entries. */
const LEGEND_CLASSES = 5;

/** Drops float noise (3 × 0.05 = 0.15000000000000002) from a class edge. */
const clean = (x: number) => Number(x.toPrecision(12));

/**
 * |depth| where each class starts, ascending: the on-grade edge, band edges
 * or round steps, and the depth past which the colour no longer changes.
 */
const legendTicks = ({ bandM, maxM, onGradeM }: CutFillStyle): number[] => {
  const deepest = bandM > 0 ? clean(saturatedBand(bandM, maxM) * bandM) : maxM;
  if (deepest <= onGradeM + SLACK_M) return [onGradeM];
  // Every band edge if they fit, else every 2nd, 5th, 10th… edge; a
  // continuous ramp steps 1, 2, 5, 10… cm.
  const base = bandM > 0 ? bandM : 0.01;
  for (let scale = 1; ; scale *= 10) {
    for (const m of [1, 2, 5]) {
      const step = base * m * scale;
      const first = Math.floor((onGradeM + SLACK_M) / step) + 1;
      const last = Math.ceil((deepest - SLACK_M) / step) - 1;
      if (last - first + 1 > LEGEND_CLASSES - 2) continue;
      const ticks = [onGradeM];
      for (let i = first; i <= last; i++) ticks.push(clean(i * step));
      ticks.push(deepest);
      return ticks;
    }
  }
};

/** "0.15", "0.025": two decimals, three when the depth needs them. */
const metres = (v: number) => {
  const s = v.toFixed(3);
  return s.endsWith("0") ? s.slice(0, -1) : s;
};

/**
 * The legend, from deepest fill to deepest cut with on grade between: at
 * most five classes a side, each labelled with the depth it starts at and
 * coloured as the map paints that depth. Bands too many for five are
 * merged, so a merged class shows its first band's colour.
 */
export const legendStops = (
  ramp: CutFillRamp,
  style: CutFillStyle,
): LegendStop[] => {
  const { paint } = colourRule(ramp, style);
  const px = new Uint8ClampedArray(4);
  const colorAt = (depth: number) => {
    paint(depth, px, 0);
    const channels = px[3] === 255 ? px.subarray(0, 3) : px;
    return `#${Array.from(channels, (v) => v.toString(16).padStart(2, "0")).join("")}`;
  };
  const ticks = legendTicks(style);
  const g = style.onGradeM;
  // With no on-grade band the first class starts at 0, which is on grade:
  // its colour is read just off it.
  const at = (tick: number) => Math.max(tick, SLACK_M);
  const fill = ticks.map((t, i) => ({
    from: i + 1 < ticks.length ? -ticks[i + 1] : -Infinity,
    to: 0 - t,
    color: colorAt(-at(t)),
    label: `−${metres(t)} m`,
  }));
  const cut = ticks.map((t, i) => ({
    from: t,
    to: i + 1 < ticks.length ? ticks[i + 1] : Infinity,
    color: colorAt(at(t)),
    label: `+${metres(t)} m`,
  }));
  const grade = {
    from: 0 - g,
    to: g,
    color: colorAt(0),
    label: g > 0 ? `on grade ±${Number((g * 100).toFixed(1))} cm` : "on grade",
  };
  return [...fill.reverse(), grade, ...cut];
};

/**
 * Lng/lat of a raster's outer corners — top-left, top-right, bottom-right,
 * bottom-left, the order a MapLibre image source takes. The Lambert-93
 * rectangle is a slightly skewed quad in lng/lat (meridians converge), so
 * all four are projected rather than read off a bounding box.
 */
export const windowCorners = (frame: {
  originX: number;
  originY: number;
  cellSize: number;
  width: number;
  height: number;
}): [
  [number, number],
  [number, number],
  [number, number],
  [number, number],
] => {
  const { originX: west, originY: north, cellSize } = frame;
  const east = west + frame.width * cellSize;
  const south = north - frame.height * cellSize;
  const at = (x: number, y: number): [number, number] => {
    const { lng, lat } = lambert93ToLngLat({ x, y });
    return [lng, lat];
  };
  return [at(west, north), at(east, north), at(east, south), at(west, south)];
};
