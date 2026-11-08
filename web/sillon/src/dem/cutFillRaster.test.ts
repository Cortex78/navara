import { describe, expect, it } from "vitest";

import { lngLatToLambert93 } from "../geo/lambert93";

import {
  autoMaxDepth,
  cutFillRgba,
  DEFAULT_CUT_FILL_RAMP as RAMP,
  legendStops,
  rampColor,
  windowCorners,
  type CutFillStyle,
  type LegendStop,
} from "./cutFillRaster";
import { percentiles, type ElevationGrid } from "./elevationGrid";

const smooth: CutFillStyle = { bandM: 0, maxM: 0.3, onGradeM: 0.02, alpha: 1 };
const banded: CutFillStyle = {
  bandM: 0.05,
  maxM: 0.15,
  onGradeM: 0.02,
  alpha: 1,
};
const GRADE = [236, 232, 220, 46];

const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (c: number[]) =>
  `#${(c[3] === 255 ? c.slice(0, 3) : c).map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/** Depths in [−0.6, 0.6) m from a fixed LCG, every 7th cell no data. */
const randomDepths = (n: number) => {
  let s = 12345;
  return Float32Array.from({ length: n }, (_, i) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return i % 7 === 0 ? NaN : (s / 2 ** 32 - 0.5) * 1.2;
  });
};

describe("rampColor", () => {
  it("paints cut warm and fill cool, darker the deeper", () => {
    const depths = [0.03, 0.08, 0.15, 0.25];
    const cut = depths.map((d) => rampColor(RAMP, smooth, d));
    const fill = depths.map((d) => rampColor(RAMP, smooth, -d));
    for (const [r, , b, a] of cut) {
      expect(r).toBeGreaterThan(b);
      expect(a).toBe(255);
    }
    for (const [r, , b, a] of fill) {
      expect(b).toBeGreaterThan(r);
      expect(a).toBe(255);
    }
    for (let i = 1; i < depths.length; i++) {
      expect(luma(cut[i])).toBeLessThan(luma(cut[i - 1]));
      expect(luma(fill[i])).toBeLessThan(luma(fill[i - 1]));
    }
  });

  it("interpolates between the stops and saturates at maxM", () => {
    // maxM 0.3 over four stops: one stop every 0.1 m.
    expect(rampColor(RAMP, smooth, 0.1)).toEqual([255, 154, 102, 255]);
    expect(rampColor(RAMP, smooth, -0.2)).toEqual([60, 98, 255, 255]);
    // Halfway between the first two cut stops.
    expect(rampColor(RAMP, smooth, 0.05)).toEqual([255, 182, 143, 255]);
    for (const d of [0.3, 0.31, 7, Infinity])
      expect(rampColor(RAMP, smooth, d)).toEqual([184, 66, 10, 255]);
    for (const d of [-0.3, -7, -Infinity])
      expect(rampColor(RAMP, smooth, d)).toEqual([30, 30, 168, 255]);
  });

  it("leaves no data clear and veils cells on grade", () => {
    expect(rampColor(RAMP, smooth, NaN)).toEqual([0, 0, 0, 0]);
    for (const d of [0, -0, 0.01, -0.0199, 0.0199])
      expect(rampColor(RAMP, smooth, d)).toEqual(GRADE);
    // The edge itself is moved earth, as `earthworks` counts it, even as
    // float32 (0.02 is stored as 0.0199999995).
    for (const d of [0.02, Math.fround(0.02)])
      expect(rampColor(RAMP, smooth, d)[0]).toBe(255);
    for (const d of [-0.02, Math.fround(-0.02)])
      expect(rampColor(RAMP, smooth, d)[2]).toBe(255);
    // With no on-grade band only exactly 0 is on grade; 1 mm is cut, a
    // hundredth of the way from the first stop to the second.
    const tight = { ...smooth, onGradeM: 0 };
    expect(rampColor(RAMP, tight, 0)).toEqual(GRADE);
    expect(rampColor(RAMP, tight, 0.001)).toEqual([255, 209, 183, 255]);
  });

  it("paints a band the colour of its centre depth", () => {
    const b: CutFillStyle = {
      bandM: 0.05,
      maxM: 0.2,
      onGradeM: 0.02,
      alpha: 1,
    };
    const c = { ...b, bandM: 0 };
    /** The continuous colour at the centre of band k, on the side of `sign`. */
    const centre = (k: number, sign = 1) =>
      rampColor(RAMP, c, sign * (k + 0.5) * b.bandM);
    for (const d of [0.021, 0.035, 0.0499])
      expect(rampColor(RAMP, b, d)).toEqual(centre(0));
    for (const d of [0.05, 0.0501, 0.0999])
      expect(rampColor(RAMP, b, d)).toEqual(centre(1));
    for (const d of [-0.1, Math.fround(-0.1), -0.149])
      expect(rampColor(RAMP, b, d)).toEqual(centre(2, -1));
    // Band 3's centre (0.175) is short of maxM; band 4's (0.225) is past it.
    expect(rampColor(RAMP, b, 0.19)).toEqual(centre(3));
    expect(centre(3)).not.toEqual(centre(4));
    for (const d of [0.2, 0.6])
      expect(rampColor(RAMP, b, d)).toEqual([184, 66, 10, 255]);
    // 0.35 is stored as 0.34999999 in float32: it still opens its band.
    const deep = { ...b, maxM: 1 };
    expect(rampColor(RAMP, deep, Math.fround(0.35))).toEqual(
      rampColor(RAMP, deep, 0.36),
    );
    expect(rampColor(RAMP, deep, Math.fround(0.35))).not.toEqual(
      rampColor(RAMP, deep, 0.34),
    );
  });

  it("multiplies opacity by alpha", () => {
    const half = { ...smooth, alpha: 0.5 };
    expect(rampColor(RAMP, half, 0.1)).toEqual([255, 154, 102, 128]);
    expect(rampColor(RAMP, half, 0)).toEqual([236, 232, 220, 23]);
    const none = { ...smooth, alpha: 0 };
    expect(rampColor(RAMP, none, -0.1)[3]).toBe(0);
    expect(rampColor(RAMP, none, 0)[3]).toBe(0);
  });

  it("refuses a style or a ramp it cannot paint", () => {
    for (const bad of [
      { maxM: 0 },
      { maxM: NaN },
      { maxM: Infinity },
      { bandM: -0.05 },
      { onGradeM: NaN },
      { alpha: 1.5 },
      { alpha: -0.1 },
    ])
      expect(() => rampColor(RAMP, { ...smooth, ...bad }, 0.1)).toThrow(
        RangeError,
      );
    expect(() => rampColor({ ...RAMP, cut: [] }, smooth, 0.1)).toThrow(
      RangeError,
    );
  });

  it("refuses a band narrower than the micrometre edges are resolved to", () => {
    // A subnormal width overflowed depth / bandM to Infinity: every cell off
    // grade painted the deep end, and the legend looped until it ran out of
    // memory. rampColor first, so a regression fails here, not in that loop.
    for (const bandM of [Number.MIN_VALUE, 1e-310, 1e-7])
      expect(() => rampColor(RAMP, { ...banded, bandM }, 0.03)).toThrow(
        RangeError,
      );
    const tiny = { ...banded, bandM: Number.MIN_VALUE };
    expect(() => cutFillRgba(Float32Array.of(0.03), 1, 1, RAMP, tiny)).toThrow(
      RangeError,
    );
    expect(() => legendStops(RAMP, tiny)).toThrow(/bandM/);
    // A micrometre is still a band, as fine as continuous to 8 bits.
    expect(rampColor(RAMP, { ...banded, bandM: 1e-6 }, 0.03)).toEqual(
      rampColor(RAMP, { ...banded, bandM: 0 }, 0.03),
    );
  });
});

describe("cutFillRgba", () => {
  it("paints each cell exactly as rampColor does, NaN clear", () => {
    const depth = randomDepths(40 * 25);
    depth.set([0, 0.02, -0.02, Math.fround(0.15), 0.6, -0.6, Infinity], 1);
    for (const style of [
      banded, // band colours from a table
      smooth, // interpolated per cell
      { ...banded, bandM: 1e-5 }, // too many bands for a table
      { ...banded, alpha: 0.4, onGradeM: 0 },
    ]) {
      const out = cutFillRgba(depth, 40, 25, RAMP, style);
      expect(out).toBeInstanceOf(Uint8ClampedArray);
      expect(out.length).toBe(40 * 25 * 4);
      for (let i = 0; i < depth.length; i++)
        expect([...out.subarray(i * 4, i * 4 + 4)]).toEqual(
          rampColor(RAMP, style, depth[i]),
        );
    }
  });

  it("refuses a depth grid that does not match its size", () => {
    expect(() => cutFillRgba(new Float32Array(5), 2, 3, RAMP, banded)).toThrow(
      RangeError,
    );
  });

  it("paints a 2000 × 2000 window in under 300 ms, banded or not", () => {
    const w = 2000;
    const depth = new Float32Array(w * w);
    for (let r = 0; r < w; r++)
      for (let c = 0; c < w; c++)
        depth[r * w + c] =
          (c - 1000) ** 2 + (r - 1000) ** 2 < 950 ** 2
            ? 0.3 * Math.sin(c / 37) * Math.cos(r / 53)
            : NaN;
    for (const bandM of [0.05, 0]) {
      const style = { ...banded, bandM, maxM: autoMaxDepth(depth) };
      // Warm the JIT on rows through the field, then keep the best of three
      // so a GC pause or a busy CI core does not fail the test.
      const rows = depth.subarray(1000 * w, 1050 * w);
      cutFillRgba(rows, rows.length, 1, RAMP, style);
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        const out = cutFillRgba(depth, w, w, RAMP, style);
        best = Math.min(best, performance.now() - t0);
        expect(out.length).toBe(w * w * 4);
      }
      expect(best).toBeLessThan(300);
    }
  });
});

describe("autoMaxDepth", () => {
  it("takes the 98th percentile of |depth|, rounded up to 5 cm", () => {
    // 1000 cells with data, 100 without: the deepest 2 % are ignored...
    const cells = (deep: number) =>
      Float32Array.from({ length: 1100 }, (_, i) =>
        i < 100 ? NaN : i < 100 + deep ? 2.5 : (i % 2 ? 1 : -1) * 0.07,
      );
    expect(autoMaxDepth(cells(20))).toBe(0.1);
    // ...2.5 % are not.
    expect(autoMaxDepth(cells(25))).toBe(2.5);
  });

  it("keeps a depth already on a 5 cm step", () => {
    // float32 stores these a hair off: 0.1 as 0.10000000149.
    expect(autoMaxDepth(new Float32Array(50).fill(0.1))).toBe(0.1);
    expect(autoMaxDepth(new Float32Array(50).fill(-0.25))).toBe(0.25);
    expect(autoMaxDepth(new Float32Array(50).fill(10.05))).toBe(10.05);
    expect(autoMaxDepth(new Float32Array(50).fill(0.1001))).toBe(0.15);
  });

  it("never goes below 5 cm, nor fails with no data", () => {
    expect(autoMaxDepth(new Float32Array(50))).toBe(0.05);
    expect(autoMaxDepth(new Float32Array(50).fill(0.001))).toBe(0.05);
    expect(autoMaxDepth(new Float32Array(50).fill(NaN))).toBe(0.05);
    expect(autoMaxDepth(new Float32Array(0))).toBe(0.05);
  });

  it("agrees with sorting the depths", () => {
    for (const n of [1, 2, 49, 1000, 9999]) {
      const depth = randomDepths(n).map((d, i) => (i === 1 ? 40 : d));
      const [p98] = percentiles(depth.map(Math.abs), [0.98]);
      const expected = Number.isNaN(p98)
        ? 0.05
        : Math.max(1, Math.ceil(p98 / 0.05 - 1e-4)) * 0.05;
      expect(autoMaxDepth(depth)).toBeCloseTo(expected, 12);
    }
  });
});

describe("legendStops", () => {
  it("runs from deepest fill to deepest cut, labelled where each class starts", () => {
    const stops = legendStops(RAMP, banded);
    expect(stops.map((s) => s.label)).toEqual([
      "−0.15 m",
      "−0.10 m",
      "−0.05 m",
      "−0.02 m",
      "on grade ±2 cm",
      "+0.02 m",
      "+0.05 m",
      "+0.10 m",
      "+0.15 m",
    ]);
    expect(stops.map((s) => [s.from, s.to])).toEqual([
      [-Infinity, -0.15],
      [-0.15, -0.1],
      [-0.1, -0.05],
      [-0.05, -0.02],
      [-0.02, 0.02],
      [0.02, 0.05],
      [0.05, 0.1],
      [0.1, 0.15],
      [0.15, Infinity],
    ]);
    expect(stops[0].color).toBe("#1e1ea8");
    expect(stops[4].color).toBe("#ece8dc2e");
    expect(stops[8].color).toBe("#b8420a");
  });

  it("colours each class as the map paints every depth in it", () => {
    for (const s of legendStops(RAMP, banded)) {
      const inside =
        s.from === -Infinity
          ? [s.to - 5, s.to - 0.001, s.to]
          : s.to === Infinity
            ? [s.from, s.from + 0.001, s.from + 5]
            : [s.from + 0.0001, (s.from + s.to) / 2, s.to - 0.0001];
      for (const d of inside)
        expect(hex(rampColor(RAMP, banded, d))).toBe(s.color);
    }
  });

  it("steps a continuous ramp in round centimetres", () => {
    const style = { ...smooth, maxM: 0.15 };
    const stops = legendStops(RAMP, style);
    expect(stops.map((s) => s.label)).toEqual(
      legendStops(RAMP, banded).map((s) => s.label),
    );
    // A class shows the colour at the depth on its label.
    const mid = (stops.length - 1) / 2;
    for (const s of stops.slice(0, mid))
      expect(s.color).toBe(hex(rampColor(RAMP, style, s.to)));
    for (const s of stops.slice(mid + 1))
      expect(s.color).toBe(hex(rampColor(RAMP, style, s.from)));
    expect(stops.map((s) => s.color).at(-1)).toBe("#b8420a");
  });

  it("merges bands to stay within 12 entries", () => {
    const stops = legendStops(RAMP, {
      bandM: 0.02,
      maxM: 0.5,
      onGradeM: 0.02,
      alpha: 1,
    });
    expect(stops.map((s) => s.label)).toEqual([
      "−0.50 m",
      "−0.40 m",
      "−0.20 m",
      "−0.02 m",
      "on grade ±2 cm",
      "+0.02 m",
      "+0.20 m",
      "+0.40 m",
      "+0.50 m",
    ]);
  });

  it("stays ordered, contiguous and true to the map for any style", () => {
    for (const bandM of [0, 0.01, 0.02, 0.05, 0.1, 0.25])
      for (const maxM of [0.05, 0.1, 0.15, 0.3, 0.45, 1, 2.5])
        for (const onGradeM of [0, 0.02, 0.05, 0.1]) {
          const style = { bandM, maxM, onGradeM, alpha: 1 };
          const stops = legendStops(RAMP, style);
          expect(stops.length).toBeLessThanOrEqual(12);
          expect(stops.length % 2).toBe(1);
          const mid = (stops.length - 1) / 2;
          expect(stops[mid].label.startsWith("on grade")).toBe(true);
          expect(stops[0].from).toBe(-Infinity);
          expect(stops.at(-1)?.to).toBe(Infinity);
          expect(stops.slice(1).map((s) => s.from)).toEqual(
            stops.slice(0, -1).map((s) => s.to),
          );
          // Zero wide when only exactly 0 is on grade.
          expect(stops[mid].to - stops[mid].from).toBeCloseTo(2 * onGradeM, 12);
          // A label is the class edge nearest zero, and the colour is the
          // map's there (just off 0 when that edge is 0, which is on grade).
          const check = (s: LegendStop, near: number, side: number) => {
            expect(s.from).toBeLessThan(s.to);
            expect(
              Number(s.label.replace("−", "-").replace(" m", "")),
            ).toBeCloseTo(near, 3);
            expect(s.color).toBe(
              hex(rampColor(RAMP, style, near || side * 1e-9)),
            );
          };
          for (const s of stops.slice(0, mid)) check(s, s.to, -1);
          for (const s of stops.slice(mid + 1)) check(s, s.from, 1);
          // The deepest classes are the deep ends of the ramp.
          expect(stops[0].color).toBe(hex(rampColor(RAMP, style, -1e3)));
          expect(stops.at(-1)?.color).toBe(hex(rampColor(RAMP, style, 1e3)));
        }
  });

  it("labels on grade by its half-width", () => {
    const label = (onGradeM: number) =>
      legendStops(RAMP, { ...banded, onGradeM }).find((s) =>
        s.label.startsWith("on grade"),
      )?.label;
    expect(label(0.025)).toBe("on grade ±2.5 cm");
    expect(label(0.1)).toBe("on grade ±10 cm");
    expect(label(0)).toBe("on grade");
  });

  it("folds everything into one class a side when the ramp saturates on grade", () => {
    expect(
      legendStops(RAMP, { bandM: 0, maxM: 0.05, onGradeM: 0.1, alpha: 1 }),
    ).toEqual([
      { from: -Infinity, to: -0.1, color: "#1e1ea8", label: "−0.10 m" },
      { from: -0.1, to: 0.1, color: "#ece8dc2e", label: "on grade ±10 cm" },
      { from: 0.1, to: Infinity, color: "#b8420a", label: "+0.10 m" },
    ]);
  });

  it("carries alpha into the colours", () => {
    const stops = legendStops(RAMP, { ...banded, alpha: 0.5 });
    expect(stops.at(-1)?.color).toBe("#b8420a80");
    expect(stops[4].color).toBe("#ece8dc17");
  });
});

describe("windowCorners", () => {
  it("gives the outer corners TL, TR, BR, BL, which project back onto the frame", () => {
    const grid: ElevationGrid = {
      crs: "EPSG:2154",
      layer: "test",
      cellSize: 0.5,
      originX: 825000,
      originY: 6277100,
      width: 300,
      height: 200,
      data: new Float32Array(300 * 200),
    };
    const corners = windowCorners(grid);
    const expected = [
      [825000, 6277100],
      [825150, 6277100],
      [825150, 6277000],
      [825000, 6277000],
    ];
    corners.forEach(([lng, lat], i) => {
      const p = lngLatToLambert93({ lng, lat });
      expect(p.x).toBeCloseTo(expected[i][0], 6);
      expect(p.y).toBeCloseTo(expected[i][1], 6);
    });
    const [tl, tr, br, bl] = corners;
    expect(tr[0]).toBeGreaterThan(tl[0]);
    expect(br[0]).toBeGreaterThan(bl[0]);
    expect(tl[1]).toBeGreaterThan(bl[1]);
    expect(tr[1]).toBeGreaterThan(br[1]);
  });
});
