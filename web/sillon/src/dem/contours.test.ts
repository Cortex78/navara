import { describe, expect, it } from "vitest";

import { lngLatToLambert93, type XY } from "../geo/lambert93";

import {
  autoInterval,
  contourLines,
  MAX_CONTOUR_SEGMENTS,
  smoothValues,
  type ContourFeature,
  type GridFrame,
} from "./contours";

const frame = (width: number, height: number, cellSize = 1): GridFrame => ({
  originX: 825000,
  originY: 6277100,
  cellSize,
  width,
  height,
});

/** Lambert-93 centre of cell (col, row). */
const centreOf = (f: GridFrame, col: number, row: number): XY => ({
  x: f.originX + (col + 0.5) * f.cellSize,
  y: f.originY - (row + 0.5) * f.cellSize,
});

/** Values from a function of each cell's centre and indices. */
const raster = (f: GridFrame, z: (p: XY, col: number, row: number) => number) =>
  Float32Array.from({ length: f.width * f.height }, (_, k) => {
    const col = k % f.width;
    const row = Math.floor(k / f.width);
    return z(centreOf(f, col, row), col, row);
  });

/** A line's vertices back in Lambert-93. */
const xyOf = (line: ContourFeature) =>
  line.geometry.coordinates.map(([lng, lat]) =>
    lngLatToLambert93({ lng, lat }),
  );

const lengthOf = (pts: XY[]) =>
  pts
    .slice(1)
    .reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

/** Shoelace area of a closed line, positive when counter-clockwise. */
const signedArea = (pts: XY[]) => {
  let twice = 0;
  for (let i = 1; i < pts.length; i++)
    twice +=
      (pts[i - 1].x - pts[0].x) * (pts[i].y - pts[0].y) -
      (pts[i].x - pts[0].x) * (pts[i - 1].y - pts[0].y);
  return twice / 2;
};

const repeatedPoints = (line: ContourFeature) =>
  line.geometry.coordinates.filter(
    (p, i, all) => i > 0 && p[0] === all[i - 1][0] && p[1] === all[i - 1][1],
  ).length;

/** Segments drawn more than once, either way round, across all `lines`. */
const repeatedSegments = (lines: ContourFeature[]) => {
  const keys = lines.flatMap(({ geometry: { coordinates: c } }) =>
    c.slice(1).map((p, i) =>
      [p, c[i]]
        .map((q) => q.join(","))
        .sort()
        .join("|"),
    ),
  );
  return keys.length - new Set(keys).size;
};

/** Deterministic uniform noise in [0, 1), so the tests cannot flake. */
const noise = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const variance = (a: ArrayLike<number>) => {
  const values = Array.from(a);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
};

describe("autoInterval", () => {
  it("picks the finest nice step giving at most 12 levels", () => {
    expect(autoInterval(0, 1)).toBe(0.1); // 0, 0.1 … 1: 11 levels
    expect(autoInterval(100.13, 100.61)).toBe(0.05); // 0.02 would give 24
    expect(autoInterval(52, 340)).toBe(25); // 20 would give 15
  });

  it("honours the target, in either argument order", () => {
    expect(autoInterval(0, 10, 3)).toBe(5); // 0, 5, 10
    expect(autoInterval(1, 0)).toBe(0.1);
  });

  it("falls back to the ends of the list", () => {
    expect(autoInterval(42, 42)).toBe(0.02);
    expect(autoInterval(0, 5000)).toBe(100);
    expect(autoInterval(NaN, NaN)).toBe(100);
  });
});

describe("smoothValues", () => {
  it("returns a copy at radius 0", () => {
    const v = Float32Array.of(1, NaN, 3, 4);
    const out = smoothValues(v, 2, 2, 0);
    expect(out).not.toBe(v);
    expect(Array.from(out)).toEqual(Array.from(v));
  });

  it("keeps a constant exactly, and the no-data mask", () => {
    const [w, h] = [40, 30];
    const v = Float32Array.from({ length: w * h }, (_, k) =>
      Math.hypot((k % w) - 20, Math.floor(k / w) - 15) < 12 ? 7.25 : NaN,
    );
    const out = smoothValues(v, w, h, 3);
    let kept = 0;
    let masked = 0;
    for (let k = 0; k < v.length; k++) {
      if (Number.isNaN(v[k])) masked += Number(Number.isNaN(out[k]));
      else kept += Number(out[k] === 7.25);
    }
    expect(kept + masked).toBe(v.length);
  });

  it("reduces noise variance", () => {
    const rand = noise(1);
    const [w, h] = [80, 80];
    const v = Float32Array.from({ length: w * h }, () => 100 + rand());
    const out = smoothValues(v, w, h, 2);
    expect(variance(out)).toBeLessThan(variance(v) / 20);
    expect(variance(smoothValues(v, w, h, 1))).toBeGreaterThan(variance(out));
  });

  it("leaves a plane alone away from the edges", () => {
    const [w, h, r] = [30, 20, 2];
    const v = Float32Array.from(
      { length: w * h },
      (_, k) => 50 + 0.1 * (k % w) - 0.05 * Math.floor(k / w),
    );
    const out = smoothValues(v, w, h, r);
    let worst = 0;
    for (let row = 2 * r; row < h - 2 * r; row++)
      for (let col = 2 * r; col < w - 2 * r; col++)
        worst = Math.max(
          worst,
          Math.abs(out[row * w + col] - v[row * w + col]),
        );
    expect(worst).toBeLessThan(1e-4);
  });

  it("checks the grid size", () => {
    expect(() => smoothValues(new Float32Array(5), 2, 2, 1)).toThrow(
      RangeError,
    );
  });

  it("treats an infinite height as no data instead of spreading it", () => {
    const [w, h] = [8, 3];
    const v = new Float32Array(w * h).fill(1);
    v[w + 2] = Infinity;
    const out = smoothValues(v, w, h, 1);
    // Inf − Inf = NaN would otherwise poison every running sum past it.
    expect(out[w + 2]).toBe(Infinity);
    expect(Array.from(out).filter((x) => x !== 1)).toEqual([Infinity]);
  });
});

describe("contourLines", () => {
  it("rings a hill once per level at the analytic radius, closed and counter-clockwise", () => {
    // A paraboloid: 10 m on the centre cell, 2 m at 20 m out; no data past
    // 19.75 m. Some cells sit exactly on a level (a² + b² = 200 at level 9).
    const f = frame(81, 81, 0.5);
    const top = centreOf(f, 40, 40);
    const z = raster(f, ({ x, y }) => {
      const r2 = (x - top.x) ** 2 + (y - top.y) ** 2;
      return r2 > 19.75 ** 2 ? NaN : 10 - r2 / 50;
    });
    const lines = contourLines(f, z, { interval: 1 });
    // The summit only touches level 10; level 2 lies outside the data.
    expect(lines.map((l) => l.properties.level)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    for (const line of lines) {
      const { coordinates } = line.geometry;
      expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
      expect(repeatedPoints(line)).toBe(0);
      const pts = xyOf(line);
      const radius = Math.sqrt(50 * (10 - line.properties.level));
      const worst = Math.max(
        ...pts.map((p) =>
          Math.abs(Math.hypot(p.x - top.x, p.y - top.y) - radius),
        ),
      );
      expect(worst).toBeLessThan(f.cellSize / 2);
      expect(lengthOf(pts) / (2 * Math.PI * radius)).toBeCloseTo(1, 2);
      expect(signedArea(pts)).toBeGreaterThan(0);
    }
  });

  it("rings a hollow clockwise", () => {
    const f = frame(21, 21);
    const pit = centreOf(f, 10, 10);
    const z = raster(f, ({ x, y }) => Math.hypot(x - pit.x, y - pit.y) + 0.5);
    const [ring] = contourLines(f, z, { interval: 5 }).filter(
      (l) => l.properties.level === 5,
    );
    expect(signedArea(xyOf(ring))).toBeLessThan(0);
  });

  it("draws a ramp's levels as one straight line each, at the right x", () => {
    // 0.25 m per column eastward: every other column sits exactly on a level.
    const f = frame(40, 30);
    const z = raster(f, (_, col) => 0.25 * col);
    // Levels on the columns (0.5 … 9.5), then between them (0.1 … 9.6).
    for (const [base, lowest, count] of [
      [0, 0.5, 19],
      [0.1, 0.1, 20],
    ]) {
      const lines = contourLines(f, z, { interval: 0.5, base });
      expect(lines.map((l) => l.properties.level)).toEqual(
        Array.from({ length: count }, (_, i) =>
          Number((lowest + 0.5 * i).toFixed(2)),
        ),
      );
      for (const line of lines) {
        const pts = xyOf(line);
        const x = f.originX + (line.properties.level / 0.25 + 0.5) * f.cellSize;
        // One vertex per row: nothing doubled where a column is on the level.
        expect(pts).toHaveLength(30);
        expect(Math.max(...pts.map((p) => Math.abs(p.x - x)))).toBeLessThan(
          0.02,
        );
        // Higher ground (east) on the left: the line runs south.
        expect(pts[0].y).toBeCloseTo(centreOf(f, 0, 0).y, 1);
        expect(pts[29].y).toBeCloseTo(centreOf(f, 0, 29).y, 1);
        expect(lengthOf(pts)).toBeCloseTo(29, 1);
      }
    }
  });

  it("clips lines at no-data cells", () => {
    // Rising 0.3 m a row southward; no data east of column 24, nor in a
    // block over rows 3–6 and columns 10–14.
    const f = frame(30, 12);
    const hole = (col: number, row: number) =>
      col >= 10 && col <= 14 && row >= 3 && row <= 6;
    const z = raster(f, (_, col, row) =>
      col >= 25 || hole(col, row) ? NaN : 0.05 + 0.3 * row,
    );
    const lines = contourLines(f, z, { interval: 0.5 });
    // Every segment lies in a square whose four corners have data.
    let bad = 0;
    for (const line of lines) {
      const pts = xyOf(line);
      for (let i = 1; i < pts.length; i++) {
        const col = Math.floor(
          ((pts[i - 1].x + pts[i].x) / 2 - f.originX) / f.cellSize - 0.5,
        );
        const row = Math.floor(
          (f.originY - (pts[i - 1].y + pts[i].y) / 2) / f.cellSize - 0.5,
        );
        for (const k of [0, 1, f.width, f.width + 1])
          bad += Number(Number.isNaN(z[row * f.width + col + k]));
      }
    }
    expect(bad).toBe(0);

    const x = (col: number) => centreOf(f, col, 0).x;
    /** [first x, last x] of each line at a level, east-most first. */
    const spans = (level: number) =>
      lines
        .filter((l) => l.properties.level === level)
        .map(xyOf)
        .map((p) => [p[0].x, p[p.length - 1].x])
        .sort((a, b) => b[0] - a[0]);
    // Higher ground (south) on the left: lines run west, from column 24.
    for (const level of [0.5, 2.5, 3]) {
      const [[from, to], ...more] = spans(level);
      expect(more).toHaveLength(0);
      expect(from).toBeCloseTo(x(24), 1);
      expect(to).toBeCloseTo(x(0), 1);
    }
    // Levels 1, 1.5 and 2 cross the block and stop at the columns beside it.
    for (const level of [1, 1.5, 2]) {
      const [east, west, ...more] = spans(level);
      expect(more).toHaveLength(0);
      expect(east[0]).toBeCloseTo(x(24), 1);
      expect(east[1]).toBeCloseTo(x(15), 1);
      expect(west[0]).toBeCloseTo(x(9), 1);
      expect(west[1]).toBeCloseTo(x(0), 1);
    }
  });

  it("drops the zero-width loop of a crest lying exactly on a level", () => {
    // A crest at exactly 2 m along row 3, columns 2–5, running into a 3 m
    // knoll at column 6; 1 m lower per cell away from them.
    const f = frame(10, 7);
    const alongCrest = (col: number) =>
      col < 2 ? col : col <= 5 ? 2 : 9 - col;
    const knoll = centreOf(f, 6, 3);
    const z = raster(f, (_, col, row) => alongCrest(col) - Math.abs(row - 3));
    const lines = contourLines(f, z, { interval: 1 });
    // The knoll's top only touches level 3: no ring there.
    expect(lines.map((l) => l.properties.level)).not.toContain(3);
    const atTwo = lines.filter((l) => l.properties.level === 2);
    expect(atTwo).toHaveLength(1);
    // Just the diamond round the knoll, through its four neighbours: the
    // out-and-back along the crest is gone.
    const pts = xyOf(atTwo[0]);
    expect(pts).toHaveLength(5);
    for (const p of pts)
      expect(Math.abs(p.x - knoll.x) + Math.abs(p.y - knoll.y)).toBeCloseTo(
        1,
        1,
      );
    expect(signedArea(pts)).toBeCloseTo(2, 1);
    for (const line of lines) {
      const keys = line.geometry.coordinates.slice(1).map((p, i) =>
        [p, line.geometry.coordinates[i]]
          .map((q) => q.join(","))
          .sort()
          .join("|"),
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("never draws a crest exactly on a level twice, even between two hills", () => {
    // Two 3 m knolls joined by a crest at exactly 2 m; 1 m everywhere else.
    const f = frame(12, 7);
    const z = raster(f, (_, col, row) =>
      row !== 3 ? 1 : col === 2 || col === 9 ? 3 : col > 2 && col < 9 ? 2 : 1,
    );
    const lines = contourLines(f, z, { interval: 2 });
    // The crest has zero width at 2 m: each knoll keeps its own ring, a kite
    // through its three lower neighbours and the crest's end.
    expect(repeatedSegments(lines)).toBe(0);
    expect(lines).toHaveLength(2);
    for (const [line, knoll, crestEnd] of [
      [lines[0], 2, 3],
      [lines[1], 9, 8],
    ] as const) {
      const pts = xyOf(line);
      expect(pts).toHaveLength(5);
      expect(line.geometry.coordinates[0]).toEqual(
        line.geometry.coordinates[4],
      );
      const centre = centreOf(f, knoll, 3);
      const end = centreOf(f, crestEnd, 3);
      // Three midpoints half a cell from the knoll, and the crest's end.
      const near = pts
        .slice(1)
        .map((p) => Math.hypot(p.x - centre.x, p.y - centre.y))
        .sort((a, b) => a - b);
      expect(near[2]).toBeCloseTo(0.5, 1);
      expect(near[3]).toBeCloseTo(1, 1);
      expect(
        Math.min(...pts.map((p) => Math.hypot(p.x - end.x, p.y - end.y))),
      ).toBeLessThan(0.02);
      expect(signedArea(pts)).toBeGreaterThan(0);
    }
  });

  it("joins a ring that dips to cells exactly on its level at a no-data edge", () => {
    // A 2 m block whose level-1 ring dips to two 1 m cells on the last row
    // with data: the squares below them are no-data.
    const f = frame(6, 5);
    const rows = [
      [0, 0, 0, 0, 0, 0],
      [0, 2, 2, 2, 2, 0],
      [0, 2, 2, 2, 2, 0],
      [0, 0, 1, 0, 1, 0],
      [NaN, NaN, NaN, NaN, NaN, NaN],
    ];
    const z = raster(f, (_, col, row) => rows[row][col]);
    const lines = contourLines(f, z, { interval: 1 }).filter(
      (l) => l.properties.level === 1,
    );
    expect(lines).toHaveLength(1);
    const { coordinates } = lines[0].geometry;
    expect(coordinates[0]).toEqual(coordinates[coordinates.length - 1]);
    expect(repeatedPoints(lines[0])).toBe(0);
    // Round the block (2 m), into each 1 m cell and back out: 12 vertices.
    expect(coordinates).toHaveLength(13);
    expect(signedArea(xyOf(lines[0]))).toBeGreaterThan(0);
  });

  it("keeps a sharp bend whose two arms end within a centimetre", () => {
    // Level 1 runs north-south between columns 0 and 1, except on row 2,
    // where cell (1, 2) is 0.5 mm below it and (2, 2) 0.5 mm above: the line
    // pokes a quarter metre east along row 2 and comes straight back.
    const f = frame(4, 5, 0.5);
    const z = raster(f, (_, col, row) =>
      col === 0 ? 0 : row === 2 && col < 3 ? 1 + (col - 1.5) / 1000 : 2,
    );
    const [line, ...more] = contourLines(f, z, { interval: 1 }).filter(
      (l) => l.properties.level === 1,
    );
    expect(more).toHaveLength(0);
    const tip = {
      x: centreOf(f, 1, 2).x + f.cellSize / 2,
      y: centreOf(f, 1, 2).y,
    };
    const pts = xyOf(line);
    expect(
      Math.min(...pts.map((p) => Math.hypot(p.x - tip.x, p.y - tip.y))),
    ).toBeLessThan(0.02);
    // Two straight half-metre legs, two diagonals into the bend, and a
    // quarter metre out and back to its tip.
    const expected = 2 * 0.5 + 2 * Math.hypot(0.25, 0.5) + 2 * 0.25;
    expect(Math.abs(lengthOf(pts) - expected)).toBeLessThan(0.03);
  });

  it("draws nothing twice and joins every line where cells sit on levels", () => {
    // Whole-metre heights contoured every metre: cells exactly on a level
    // everywhere, in crests, rims and saddles of every shape.
    const rand = noise(5);
    const f = frame(12, 10);
    for (let grid = 0; grid < 40; grid++) {
      const z = Float32Array.from({ length: 120 }, () =>
        Math.floor(5 * rand()),
      );
      const lines = contourLines(f, z, { interval: 1 });
      for (const level of new Set(lines.map((l) => l.properties.level))) {
        const atLevel = lines.filter((l) => l.properties.level === level);
        expect(repeatedSegments(atLevel)).toBe(0);
        // Maximal lines: no open line ends where another starts.
        const open = atLevel
          .map((l) => l.geometry.coordinates.map((p) => p.join(",")))
          .filter((c) => c[0] !== c[c.length - 1]);
        const starts = new Set(open.map((c) => c[0]));
        expect(open.filter((c) => starts.has(c[c.length - 1]))).toEqual([]);
      }
      for (const line of lines) expect(repeatedPoints(line)).toBe(0);
    }
  });

  it("drops rings that the 1e-7° rounding flattens into specks", () => {
    // Raw noise: many cells sit a hair past a level, ringed by a line a few
    // millimetres across that rounds onto one point or a back-and-forth.
    const rand = noise(3);
    const f = frame(120, 120, 0.5);
    const z = Float32Array.from({ length: 120 * 120 }, () => rand());
    const rings = contourLines(f, z, { interval: 0.05 }).filter(
      ({ geometry: { coordinates: c } }) =>
        c[0][0] === c[c.length - 1][0] && c[0][1] === c[c.length - 1][1],
    );
    expect(rings.length).toBeGreaterThan(500);
    // The smallest triangle on the rounding grid is about 0.4 cm².
    const smallest = Math.min(
      ...rings.map((ring) => Math.abs(signedArea(xyOf(ring)))),
    );
    expect(smallest).toBeGreaterThan(1e-5);
  });

  it("resolves a saddle by the centre average", () => {
    const f = frame(2, 2);
    // High at top-left and bottom-right; the centre averages 0.5.
    const z = Float32Array.of(1, 0, 0, 1);
    const corners = [0, 1, 2, 3].map((k) => ({
      p: centreOf(f, k % 2, Math.floor(k / 2)),
      v: z[k],
    }));
    /** Height of the corner each line passes closest to. */
    const cutOff = (lines: ContourFeature[]) =>
      lines.map((line) => {
        const [a, b] = xyOf(line);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const dist = (c: XY) => Math.hypot(c.x - mid.x, c.y - mid.y);
        return corners.reduce((m, c) => (dist(c.p) < dist(m.p) ? c : m)).v;
      });
    // At 0.5 the centre is high ground: each line cuts off a low corner.
    expect(cutOff(contourLines(f, z, { interval: 0.5 }))).toEqual([0, 0]);
    // At 0.6 the centre is low: each line rings a high corner.
    expect(cutOff(contourLines(f, z, { interval: 0.6 }))).toEqual([1, 1]);
  });

  it("flags every fifth level from the base as major, with clean levels", () => {
    const f = frame(60, 3);
    const z = raster(f, (_, col) => 0.01 + 0.05 * col); // 0.01 … 2.96
    const lines = contourLines(f, z, { interval: 0.1 });
    expect(lines.map((l) => l.properties.level)).toEqual(
      Array.from({ length: 29 }, (_, i) => (i + 1) / 10),
    );
    expect(
      lines.filter((l) => l.properties.major).map((l) => l.properties.level),
    ).toEqual([0.5, 1, 1.5, 2, 2.5]);
    const offset = contourLines(f, z, {
      interval: 0.1,
      base: 0.03,
      majorEvery: 10,
    });
    expect(
      offset.filter((l) => l.properties.major).map((l) => l.properties.level),
    ).toEqual([0.03, 1.03, 2.03]);
    // A base that cancels out still labels its level 0, not -5.55e-17.
    const short = frame(30, 3);
    const below = raster(short, (_, col) => -0.42 + 0.03 * col);
    expect(
      contourLines(short, below, { interval: 0.1, base: 0.3 }).map(
        (l) => l.properties.level,
      ),
    ).toEqual([-0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4]);
  });

  it("draws nothing for flat ground, even exactly on a level", () => {
    const f = frame(5, 4);
    expect(
      contourLines(f, new Float32Array(20).fill(2), { interval: 1 }),
    ).toEqual([]);
    expect(
      contourLines(frame(1, 5), new Float32Array(5), { interval: 1 }),
    ).toEqual([]);
  });

  it("checks its inputs", () => {
    const f = frame(3, 3);
    const z = new Float32Array(9);
    expect(() => contourLines(f, new Float32Array(8), { interval: 1 })).toThrow(
      RangeError,
    );
    for (const interval of [0, -1, NaN, Infinity])
      expect(() => contourLines(f, z, { interval })).toThrow(RangeError);
    expect(() => contourLines(f, z, { interval: 1, base: NaN })).toThrow(
      RangeError,
    );
  });

  it("never stalls on an absurd interval or an infinite height", () => {
    const f = frame(3, 3);
    // Past 2^53 levels from the base, n++ would no longer advance.
    const high = Float32Array.from({ length: 9 }, (_, k) =>
      k === 1 || k === 4 ? 1e7 + 1 : 1e7,
    );
    expect(() => contourLines(f, high, { interval: 1e-12 })).toThrow(
      RangeError,
    );
    // An infinite corner is skipped like no data; the rest still draws.
    const z = Float32Array.of(0, 0, Infinity, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8);
    const lines = contourLines(f, z, { interval: 0.5 });
    expect(lines).toHaveLength(1);
    expect(lines[0].geometry.coordinates).toHaveLength(2);
  });

  it("refuses an interval that would draw too many segments", () => {
    const rand = noise(7);
    const f = frame(300, 300, 0.5);
    const z = Float32Array.from({ length: 300 * 300 }, rand);
    expect(() => contourLines(f, z, { interval: 0.001 })).toThrow(
      /larger interval/,
    );
    expect(() => contourLines(f, z, { interval: 0.001 })).toThrow(RangeError);
    // A coarse interval on the same noise stays under the cap.
    expect(contourLines(f, z, { interval: 0.5 }).length).toBeGreaterThan(0);
    expect(MAX_CONTOUR_SEGMENTS).toBe(400_000);
  });

  it("contours a 1000 × 1000 grid at ~20 levels well under a second", () => {
    const f = frame(1000, 1000, 0.5);
    const z = raster(
      f,
      (_, col, row) =>
        50 + 0.004 * col + 0.6 * Math.sin(col / 47) * Math.cos(row / 61),
    );
    const t0 = performance.now();
    const lines = contourLines(f, z, { interval: 0.25 });
    const ms = performance.now() - t0;
    expect(
      new Set(lines.map((l) => l.properties.level)).size,
    ).toBeGreaterThanOrEqual(18);
    expect(ms).toBeLessThan(1000);
  });
});
