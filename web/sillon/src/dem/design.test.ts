import { describe, expect, it } from "vitest";

import { lambert93ScaleFactor, lambert93ToLngLat } from "../geo/lambert93";

import {
  balance,
  design,
  designGrid,
  designHeight,
  designPlane,
  earthworks,
  fieldWindow,
  planeFall,
  robustFit,
  transportHaulM,
  type FieldWindow,
} from "./design";
import type { ElevationGrid } from "./elevationGrid";
import { fieldSurface, type LngLatPolygon } from "./fieldMask";
import { fitPlane } from "./planeFit";

const X0 = 825000;
const Y0 = 6277100;

/** A grid with its top-left corner at (X0, Y0) and height f(x, y) at each cell centre. */
const makeGrid = (
  width: number,
  height: number,
  f: (x: number, y: number) => number,
  cellSize = 1,
): ElevationGrid => {
  const data = new Float32Array(width * height);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < width; col++)
      data[row * width + col] = f(
        X0 + (col + 0.5) * cellSize,
        Y0 - (row + 0.5) * cellSize,
      );
  return {
    crs: "EPSG:2154",
    layer: "test",
    cellSize,
    originX: X0,
    originY: Y0,
    width,
    height,
    data,
  };
};

/** A field outlined by Lambert-93 vertices. */
const field = (...pts: [number, number][]): LngLatPolygon[] => [
  [pts.map(([x, y]) => lambert93ToLngLat({ x, y }))],
];

/** The field [x0, x1] × [y0, y1], in Lambert-93 metres. */
const rect = (x0: number, y0: number, x1: number, y1: number) =>
  field([x0, y1], [x1, y1], [x1, y0], [x0, y0]);

// An L: a 30 × 10 m bar along the top, a 10 × 20 m leg down its west end.
const ell = field(
  [X0 + 10, Y0 - 10],
  [X0 + 40, Y0 - 10],
  [X0 + 40, Y0 - 20],
  [X0 + 20, Y0 - 20],
  [X0 + 20, Y0 - 40],
  [X0 + 10, Y0 - 40],
);

const windowOf = (g: ElevationGrid, polygons: LngLatPolygon[]): FieldWindow => {
  const w = fieldWindow(g, polygons);
  if (!w) throw new Error("no field window");
  return w;
};

const rel = (a: number, b: number) => Math.abs(a / b - 1);

/** A field W × H map metres rising s per map metre toward the east, from 30 m. */
const tilted = (W: number, H: number, s: number) =>
  windowOf(
    makeGrid(W, H, (x) => 30 + s * (x - X0)),
    rect(X0, Y0 - H, X0 + W, Y0),
  );

describe("fieldWindow", () => {
  it("crops the grid to the field's cells and blanks the cells around it", () => {
    const g = makeGrid(100, 100, (x, y) => (x - X0) / 10 + (Y0 - y) / 1000);
    const w = windowOf(g, ell);
    expect(w.grid.originX).toBe(X0 + 10);
    expect(w.grid.originY).toBe(Y0 - 10);
    expect([w.grid.width, w.grid.height]).toEqual([30, 30]);
    expect(w.grid.cellSize).toBe(1);
    expect(w.inside.reduce((s, v) => s + v, 0)).toBe(500);
    expect(w.validCount).toBe(500);
    // Window cell (0, 0) is grid cell (10, 10); window cell (20, 20) is in
    // the L's notch.
    expect(w.grid.data[0]).toBe(g.data[10 * 100 + 10]);
    expect(w.inside[0]).toBe(1);
    expect(w.inside[20 * 30 + 20]).toBe(0);
    expect(w.grid.data[20 * 30 + 20]).toBeNaN();
  });

  it("measures ground area with the scale factor at the field", () => {
    const w = windowOf(
      makeGrid(100, 100, () => 1),
      ell,
    );
    const lats = ell[0][0].map((p) => p.lat);
    const k = lambert93ScaleFactor(lats.reduce((s, v) => s + v) / lats.length);
    expect(w.k).toBeCloseTo(k, 12);
    expect(w.cellArea).toBeCloseTo((1 / k) ** 2, 12);
    expect(w.areaM2).toBeCloseTo(500 * w.cellArea, 9);
    // South of 44°N Lambert-93 stretches distances (k > 1): a map metre
    // covers a little less than a ground metre.
    expect(w.areaM2).toBeLessThan(500);
    expect(w.areaM2).toBeGreaterThan(499.5);
  });

  it("counts cells with no height in the field's area, not in its data", () => {
    const g = makeGrid(20, 20, (x) => x - X0);
    g.data.fill(NaN, 0, 5 * 20);
    const w = windowOf(g, rect(X0, Y0 - 20, X0 + 20, Y0));
    expect(w.inside.every((v) => v === 1)).toBe(true);
    expect(w.validCount).toBe(300);
    expect(w.areaM2).toBeCloseTo(400 * w.cellArea, 9);
  });

  it("returns null for a field off the grid", () => {
    expect(
      fieldWindow(
        makeGrid(10, 10, () => 1),
        rect(0, 0, 10, 10),
      ),
    ).toBeNull();
  });
});

describe("designPlane", () => {
  // Rises 1 % per map metre east and 0.5 % south.
  const w = windowOf(
    makeGrid(60, 40, (x, y) => 20 + (x - X0) / 100 + (Y0 - y) / 200),
    rect(X0, Y0 - 40, X0 + 60, Y0),
  );

  it("passes through the centroid of the cells with a height, at their mean", () => {
    const p = designPlane(w, { mode: "level" });
    expect(p.x0).toBeCloseTo(X0 + 30, 9);
    expect(p.y0).toBeCloseTo(Y0 - 20, 9);
    expect(p.z0).toBeCloseTo(20 + 0.3 + 0.1, 5);
    expect([p.gx, p.gy]).toEqual([0, 0]);
    expect(planeFall(p, w.k)).toEqual({ slopePct: 0, fallDeg: 0 });
  });

  it("anchors the plane at the centroid of the field's cells, not of its window", () => {
    // The L's 300-cell bar is centred 15 m in, its 200-cell leg 30 m: the
    // centroid is (21, 21) m in from the corner; the window's centre is (25, 25).
    const p = designPlane(
      windowOf(
        makeGrid(100, 100, (x) => (x - X0) / 10),
        ell,
      ),
      { mode: "slope", mainPct: 0.2, bearingDeg: 60, crossPct: 0 },
    );
    expect(p.x0).toBeCloseTo(X0 + 21, 9);
    expect(p.y0).toBeCloseTo(Y0 - 21, 9);
    expect(p.z0).toBeCloseTo(2.1, 5);
  });

  it("lays a set fall per ground metre toward a bearing", () => {
    const p = designPlane(w, {
      mode: "slope",
      mainPct: 0.5,
      bearingDeg: 90,
      crossPct: 0,
    });
    const fall = planeFall(p, w.k);
    expect(fall.slopePct).toBeCloseTo(0.5, 9);
    expect(fall.fallDeg).toBeCloseTo(90, 9);
    // 100 ground metres east span 100·k map metres and drop 0.5 m.
    expect(designHeight(p, p.x0 + 100 * w.k, p.y0) - p.z0).toBeCloseTo(-0.5, 9);
  });

  it("adds a cross fall toward the bearing turned 90° clockwise", () => {
    // 0.3 % toward the south and 0.4 % toward the west: 0.5 % toward 233°.
    const fall = planeFall(
      designPlane(w, {
        mode: "slope",
        mainPct: 0.3,
        bearingDeg: 180,
        crossPct: 0.4,
      }),
      w.k,
    );
    expect(fall.slopePct).toBeCloseTo(0.5, 9);
    expect(fall.fallDeg).toBeCloseTo(
      180 + (Math.atan2(0.4, 0.3) * 180) / Math.PI,
      9,
    );
  });

  it("reads negative falls as rises", () => {
    const fall = planeFall(
      designPlane(w, {
        mode: "slope",
        mainPct: -0.2,
        bearingDeg: 45,
        crossPct: 0,
      }),
      w.k,
    );
    expect(fall.slopePct).toBeCloseTo(0.2, 9);
    expect(fall.fallDeg).toBeCloseTo(225, 9);
  });

  it("keeps the field's own fall in fit mode", () => {
    const { plane, fall, works } = design(w, { mode: "fit" });
    expect(plane.gx).toBeCloseTo(0.01, 6);
    expect(plane.gy).toBeCloseTo(-0.005, 6);
    expect(fall.slopePct).toBeCloseTo(Math.hypot(1, 0.5) * w.k, 4);
    // Downhill is west and a little north: atan2(−0.01, 0.005).
    expect(fall.fallDeg).toBeCloseTo(
      360 + (Math.atan2(-0.01, 0.005) * 180) / Math.PI,
      3,
    );
    // The field already is that plane: nothing to move but float rounding.
    expect(works.cutM3 + works.fillM3).toBeLessThan(0.01);
  });

  it("refuses a slope it cannot evaluate", () => {
    expect(() =>
      designPlane(w, {
        mode: "slope",
        mainPct: NaN,
        bearingDeg: 0,
        crossPct: 0,
      }),
    ).toThrow(RangeError);
  });
});

describe("robustFit", () => {
  it("keeps a ditch from tilting the design", () => {
    // Flat at 2 m with a 2 m wide, 1 m deep ditch near the east side.
    const g = makeGrid(100, 100, (x) => {
      const col = Math.floor(x - X0);
      return col >= 45 && col < 47 ? 1 : 2;
    });
    const w = windowOf(g, rect(X0, Y0 - 100, X0 + 50, Y0));
    // Plain least squares leans toward the ditch.
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    for (let row = 0; row < 100; row++)
      for (let col = 0; col < 50; col++) {
        xs.push(X0 + col + 0.5);
        ys.push(Y0 - row - 0.5);
        zs.push(g.data[row * 100 + col]);
      }
    expect(fitPlane(xs, ys, zs)?.slopePct).toBeGreaterThan(0.3);

    const fit = robustFit(w);
    expect(fit?.slopePct).toBeLessThan(0.01);
    expect(fit?.z0).toBeCloseTo(2, 6);
    const { plane, works, fall } = design(w, { mode: "fit" }, {}, fit);
    expect(fall.slopePct).toBeLessThan(0.01);
    // Balanced flat at the mean, 1.96 m: the ditch's 200 cells take 0.96 m
    // of fill each, skimmed 4 cm off the other 4800.
    expect(plane.z0).toBeCloseTo(1.96, 9);
    expect(rel(works.fillM3, 192 * w.cellArea)).toBeLessThan(1e-6);
    expect(rel(works.cutM3, 192 * w.cellArea)).toBeLessThan(1e-6);
  });

  it("fits the plane fieldSurface fits, by the same 3 RMS rule", () => {
    // Rolling ground with a ditch and gaps in the LiDAR. Off the first fit
    // the swells reach 1.6 RMS and the ditch's cells 2.4 to 5.3 RMS, so a
    // limit of 1, 2 or 5 RMS would keep other cells than fieldSurface does.
    const g = makeGrid(80, 60, (x, y) => {
      const [u, v] = [x - X0, Y0 - y];
      if ((3 * u + 5 * v) % 23 === 0) return NaN;
      return (
        12 +
        0.004 * u -
        0.002 * v +
        0.3 * Math.sin(u / 3) * Math.cos(v / 4) -
        (u >= 40 && u < 42 ? 0.8 : 0)
      );
    });
    const polygons = rect(X0 + 5, Y0 - 55, X0 + 75, Y0 - 5);
    const w = windowOf(g, polygons);
    const fit = robustFit(w);
    const plane = fieldSurface(g, polygons)?.plane;
    expect(fit?.n).toBe(plane?.n);
    // The deeper part of the ditch is refitted out, none of the ground.
    let ditch = 0;
    w.grid.data.forEach((z, i) => {
      const u = w.grid.originX - X0 + (i % w.grid.width) + 0.5;
      if (!Number.isNaN(z) && u >= 40 && u < 42) ditch++;
    });
    expect(ditch).toBeGreaterThan(90);
    expect(fit?.n).toBeGreaterThan(w.validCount - ditch);
    expect(fit?.n).toBeLessThan(w.validCount);
    expect(fit?.dzdx).toBeCloseTo(plane?.dzdx ?? NaN, 12);
    expect(fit?.dzdy).toBeCloseTo(plane?.dzdy ?? NaN, 12);
    expect(fit?.z0).toBeCloseTo(plane?.z0 ?? NaN, 9);
  });
});

describe("balance", () => {
  // A tilted, rolling field with one cell in 37 unflown.
  const rolling = makeGrid(150, 120, (x, y) => {
    const [u, v] = [x - X0, Y0 - y];
    return (7 * u + 3 * v) % 37 === 0
      ? NaN
      : 20 + 0.003 * u + 0.2 * Math.sin(u / 9) * Math.cos(v / 13);
  });
  const w = windowOf(rolling, rect(X0, Y0 - 120, X0 + 150, Y0));
  const slope = designPlane(w, {
    mode: "slope",
    mainPct: 0.1,
    bearingDeg: 200,
    crossPct: 0.05,
  });

  it.each([1.3, 0.8, 1])("solves cut:fill = %f", (ratio) => {
    expect(w.validCount).toBeLessThan(150 * 120);
    const works = earthworks(w, balance(w, slope, ratio));
    expect(rel(works.ratio, ratio)).toBeLessThan(1e-6);
    // Spare cut is surplus soil; a ratio below 1 has soil brought in.
    expect(works.netM3 * (ratio - 1)).toBeGreaterThanOrEqual(0);
  });

  it("solves a small field by sorting outright", () => {
    const small = windowOf(rolling, rect(X0, Y0 - 40, X0 + 50, Y0));
    const works = earthworks(
      small,
      balance(small, designPlane(small, { mode: "level" }), 1.25),
    );
    expect(rel(works.ratio, 1.25)).toBeLessThan(1e-9);
  });

  it("solves despite a spike that crowds every other cell into one bin", () => {
    const spiky = { ...rolling, data: rolling.data.slice() };
    // A pylon left in the DTM, 5 km above the field.
    spiky.data[60 * 150 + 75] = 5000;
    const sw = windowOf(spiky, rect(X0, Y0 - 120, X0 + 150, Y0));
    const works = earthworks(
      sw,
      balance(sw, designPlane(sw, { mode: "level" }), 1.3),
    );
    expect(rel(works.ratio, 1.3)).toBeLessThan(1e-6);
  });

  it("allows no cut at ratio 0 and no fill at Infinity", () => {
    const none = earthworks(w, balance(w, slope, 0));
    expect(none.cutM3).toBeLessThan(1e-9);
    expect(none.fillM3).toBeGreaterThan(100);
    const all = earthworks(w, balance(w, slope, Infinity));
    expect(all.fillM3).toBeLessThan(1e-9);
    expect(all.cutM3).toBeGreaterThan(100);
  });

  it("leaves no sliver of cut at ratio 0, nor of fill at Infinity", () => {
    // Adding the shift to z0 rounds. On these designs it used to leave the
    // extreme cell 1e-16 m on the wrong side, so the ratio came out finite
    // and the haul ran to that sliver.
    const bumpy = windowOf(
      makeGrid(
        10,
        10,
        (x, y) =>
          2 +
          0.001 * (x - X0) +
          0.5 * Math.sin((x - X0) * 0.7) * Math.cos((Y0 - y) * 0.3),
      ),
      rect(X0, Y0 - 10, X0 + 10, Y0),
    );
    const highest = (d: Float32Array) =>
      Math.max(...d.filter((v) => !Number.isNaN(v)));
    for (const [mainPct, bearingDeg] of [
      [0.1, 30],
      [0.25, 135],
      [0.5, 45],
      [0.1, 200],
    ]) {
      const p = designPlane(bumpy, {
        mode: "slope",
        mainPct,
        bearingDeg,
        crossPct: 0,
      });
      const none = earthworks(bumpy, balance(bumpy, p, 0));
      expect(none).toMatchObject({ cutM3: 0, ratio: 0, maxCutM: 0, haulM: 0 });
      expect(none.fillM3).toBeGreaterThan(1);
      // Still resting on the highest cell, not lifted clear of it.
      expect(highest(none.depth)).toBeGreaterThan(-1e-9);
      const all = earthworks(bumpy, balance(bumpy, p, Infinity));
      expect(all).toMatchObject({
        fillM3: 0,
        ratio: Infinity,
        maxFillM: 0,
        haulM: 0,
      });
      expect(all.cutM3).toBeGreaterThan(1);
      expect(-highest(all.depth.map((v) => -v))).toBeLessThan(1e-9);
    }
  });

  it("leaves the plane alone when the field has no heights", () => {
    const blank = windowOf(
      makeGrid(10, 10, () => NaN),
      rect(X0, Y0 - 10, X0 + 10, Y0),
    );
    const p = { x0: X0, y0: Y0, z0: 5, gx: 0.001, gy: 0 };
    expect(balance(blank, p, 1.3)).toEqual(p);
  });

  it("refuses a negative or NaN ratio", () => {
    expect(() => balance(w, slope, -1)).toThrow(RangeError);
    expect(() => balance(w, slope, NaN)).toThrow(RangeError);
  });
});

describe("earthworks", () => {
  it.each([200, 151])(
    "levels a %i m wide tilted field to the analytic volumes (S3 acceptance)",
    (W) => {
      const [H, s] = [100, 0.01];
      // A margin of other ground around the field, to be left out.
      const g = makeGrid(W + 20, H + 20, (x, y) =>
        x - X0 < 10 || x - X0 > W + 10 || Y0 - y < 10 || Y0 - y > H + 10
          ? 99
          : 30 + s * (x - X0 - 10),
      );
      const w = windowOf(g, rect(X0 + 10, Y0 - 10 - H, X0 + 10 + W, Y0 - 10));
      const { plane, works } = design(w, { mode: "level" });
      // On the ground the field is W/k by H/k metres and rises s·k per
      // metre. Levelled at its mean height, the east half is cut and the
      // west half filled by wedges of (s·k)·(W/k)²·(H/k)/8. With an even
      // W the cell-centre sum is exact; with an odd one the hinge runs
      // through a column of cells and the sum is 1/W² short.
      const { k } = w;
      const wedge = (s * k * (W / k) ** 2 * (H / k)) / 8;
      expect(rel(works.cutM3, wedge)).toBeLessThan(1e-3);
      expect(rel(works.fillM3, wedge)).toBeLessThan(1e-3);
      expect(works.ratio).toBeCloseTo(1, 9);
      expect(plane.z0).toBeCloseTo(30 + (s * W) / 2, 5);
      // Each wedge's volume centroid lies two thirds of the way out from
      // the hinge, so cut and fill are 2W/3 apart.
      expect(rel(works.haulM, (2 * W) / 3 / k)).toBeLessThan(1e-3);
      // Deepest at the outer cell centres, half a cell in from the edges.
      expect(works.maxCutM).toBeCloseTo((s * (W - 1)) / 2, 5);
      expect(works.maxFillM).toBeCloseTo((s * (W - 1)) / 2, 5);
      expect(works.meanDepthM).toBeCloseTo((s * W) / 4, 4);
      expect(works.m3PerHa).toBeCloseTo(works.cutM3 / (w.areaM2 / 1e4), 9);
      const ha = (W * H * w.cellArea) / 1e4;
      expect(
        works.cutAreaHa + works.fillAreaHa + works.onGradeAreaHa,
      ).toBeCloseTo(ha, 9);
      // Within 1.2 cm of the design: the two columns either side of the
      // hinge, or the column on it and its two neighbours.
      expect(earthworks(w, plane, 0.012).onGradeAreaHa).toBeCloseTo(
        ((W % 2 ? 3 : 2) * H * w.cellArea) / 1e4,
        9,
      );
    },
  );

  it("matches the analytic volumes of a field tilted on both axes", () => {
    // Levelled at its mean, a plane over a rectangle of area A is cut by
    // (A/4)·(p + q²/3p), with p ≥ q the rises from the centre to the edges
    // along each axis: p = |a|·W/2, q = |b|·H/2, the same on the map and on
    // the ground.
    const [W, H, a, b] = [300, 200, 0.004, -0.0015];
    const w = windowOf(
      makeGrid(W, H, (x, y) => 40 + a * (x - X0) + b * (y - Y0)),
      rect(X0, Y0 - H, X0 + W, Y0),
    );
    const { works } = design(w, { mode: "level" });
    const [p, q] = [(Math.abs(a) * W) / 2, (Math.abs(b) * H) / 2];
    const groundArea = (W * H) / w.k ** 2;
    const expected = (groundArea / 4) * (p + q ** 2 / (3 * p));
    expect(rel(works.cutM3, expected)).toBeLessThan(1e-3);
    expect(rel(works.fillM3, expected)).toBeLessThan(1e-3);
  });

  it.each([1, 0.5])(
    "measures the haul between a cut block and a fill block on %f m cells",
    (cs) => {
      // Flat at 10 m, with a 10 × 10 m mound 0.5 m high and, 60 m east and
      // 20 m north of it, a hollow 0.5 m deep.
      const g = makeGrid(
        100 / cs,
        60 / cs,
        (x, y) => {
          const [u, v] = [x - X0, Y0 - y];
          if (u >= 15 && u < 25 && v >= 25 && v < 35) return 10.5;
          if (u >= 75 && u < 85 && v >= 5 && v < 15) return 9.5;
          return 10;
        },
        cs,
      );
      const w = windowOf(g, rect(X0, Y0 - 60, X0 + 100, Y0));
      // Ground m² of a map m², whatever the cell size.
      const m2 = 1 / w.k ** 2;
      const { plane, works } = design(w, { mode: "level" });
      expect(plane.z0).toBeCloseTo(10, 9);
      expect(works.cutM3).toBeCloseTo(50 * m2, 6);
      expect(works.fillM3).toBeCloseTo(50 * m2, 6);
      expect(works.haulM).toBeCloseTo(Math.hypot(60, 20) / w.k, 6);
      expect(works.cutAreaHa).toBeCloseTo((100 * m2) / 1e4, 9);
      expect(works.fillAreaHa).toBeCloseTo((100 * m2) / 1e4, 9);
      expect(works.onGradeAreaHa).toBeCloseTo((5800 * m2) / 1e4, 9);
      expect(works.maxCutM).toBeCloseTo(0.5, 9);
      expect(works.maxFillM).toBeCloseTo(0.5, 9);
      expect(works.meanDepthM).toBeCloseTo(100 / 6000, 9);
      // The depth raster: + on the mound, − in the hollow, 0 elsewhere.
      const at = (u: number, v: number) => (v / cs) * g.width + u / cs;
      expect(works.depth[at(20, 30)]).toBeCloseTo(0.5, 6);
      expect(works.depth[at(80, 10)]).toBeCloseTo(-0.5, 6);
      expect(works.depth[0]).toBeCloseTo(0, 6);
    },
  );

  it("counts a depth of exactly onGradeM as cut or fill, not on grade", () => {
    // Depths 0, ±0.25 and ±0.5 below a level design at 0: on grade is
    // |depth| < onGradeM.
    const w = windowOf(
      makeGrid(5, 1, (x) => [0, 0.25, 0.5, -0.25, -0.5][Math.floor(x - X0)]),
      rect(X0, Y0 - 1, X0 + 5, Y0),
    );
    const works = earthworks(w, { x0: X0, y0: Y0, z0: 0, gx: 0, gy: 0 }, 0.5);
    const ha = w.cellArea / 1e4;
    expect(works.cutAreaHa).toBeCloseTo(ha, 12);
    expect(works.fillAreaHa).toBeCloseTo(ha, 12);
    expect(works.onGradeAreaHa).toBeCloseTo(3 * ha, 12);
  });

  it("ignores cells without a height", () => {
    // The tilted field again, its 10 northern rows unflown.
    const [W, H, s] = [200, 100, 0.01];
    const g = makeGrid(W, H, (x, y) => (Y0 - y < 10 ? NaN : 30 + s * (x - X0)));
    const w = windowOf(g, rect(X0, Y0 - H, X0 + W, Y0));
    expect(w.validCount).toBe(W * (H - 10));
    const { works } = design(w, { mode: "level" });
    const wedge = ((s * W ** 2 * (H - 10)) / 8) * w.cellArea;
    expect(rel(works.cutM3, wedge)).toBeLessThan(1e-5);
    expect(rel(works.fillM3, wedge)).toBeLessThan(1e-5);
    expect(works.depth[0]).toBeNaN();
    expect(works.depth[10 * W]).toBeCloseTo((-s * (W - 1)) / 2, 5);
    // Mean depth over the cells with data; cut per hectare of the whole field.
    expect(works.meanDepthM).toBeCloseTo((s * W) / 4, 5);
    expect(works.m3PerHa).toBeCloseTo(
      works.cutM3 / ((W * H * w.cellArea) / 1e4),
      9,
    );
  });
});

describe("designGrid", () => {
  it("gives design heights over the whole field, unflown cells included", () => {
    const g = makeGrid(100, 100, (_, y) => (Y0 - y < 15 ? NaN : 3));
    const w = windowOf(g, ell);
    const p = { x0: X0, y0: Y0, z0: 10, gx: 0.01, gy: -0.002 };
    const d = designGrid(w, p);
    expect([d.originX, d.originY, d.width, d.height]).toEqual([
      w.grid.originX,
      w.grid.originY,
      w.grid.width,
      w.grid.height,
    ]);
    // Window row 0 is grid row 10: no LiDAR there, but still in the field.
    expect(w.grid.data[0]).toBeNaN();
    expect(d.data[0]).toBeCloseTo(designHeight(p, X0 + 10.5, Y0 - 10.5), 5);
    expect(d.data[20 * 30 + 20]).toBeNaN();
  });
});

describe("design", () => {
  const [W, H, s] = [200, 100, 0.01];
  const w = tilted(W, H, s);

  it("raises the design by offsetM", () => {
    const base = design(w, { mode: "level" });
    const up = design(w, { mode: "level" }, { offsetM: 0.01 });
    expect(up.plane.z0 - base.plane.z0).toBeCloseTo(0.01, 9);
    // 1 cm higher everywhere: each cell takes 1 cm more fill or 1 cm less cut.
    const area = w.validCount * w.cellArea;
    const moreFill = up.works.fillM3 - base.works.fillM3;
    const lessCut = base.works.cutM3 - up.works.cutM3;
    expect(moreFill + lessCut).toBeCloseTo(0.01 * area, 6);
    expect(up.works.netM3 - base.works.netM3).toBeCloseTo(-0.01 * area, 6);
    // Half the field is fill and half cut, so about half each.
    expect(rel(moreFill, 0.005 * area)).toBeLessThan(0.01);
    expect(rel(lessCut, 0.005 * area)).toBeLessThan(0.01);
    expect(up.works.ratio).toBeLessThan(1);
    const down = design(w, { mode: "level" }, { offsetM: -0.01 });
    expect(down.works.ratio).toBeGreaterThan(1);
  });

  it("holds the ratio whichever way the design falls", () => {
    for (const bearingDeg of [0, 90, 180, 270, 333]) {
      const { works, fall } = design(
        w,
        { mode: "slope", mainPct: 0.3, bearingDeg, crossPct: -0.1 },
        { ratio: 1.2 },
      );
      expect(rel(works.ratio, 1.2)).toBeLessThan(1e-6);
      expect(fall.slopePct).toBeCloseTo(Math.hypot(0.3, 0.1), 9);
    }
  });

  it("copes with fields it cannot design", () => {
    // No heights at all.
    const blank = windowOf(
      makeGrid(10, 10, () => NaN),
      rect(X0, Y0 - 10, X0 + 10, Y0),
    );
    expect(blank.validCount).toBe(0);
    expect(blank.areaM2).toBeGreaterThan(99);
    expect(robustFit(blank)).toBeNull();
    const none = design(blank, { mode: "fit" }, { ratio: 1.3 });
    expect(none.plane.z0).toBeNaN();
    expect(none.works).toMatchObject({
      cutM3: 0,
      fillM3: 0,
      ratio: 1,
      netM3: 0,
      haulM: 0,
      meanDepthM: 0,
      m3PerHa: 0,
      onGradeAreaHa: 0,
    });
    expect(none.works.depth.every(Number.isNaN)).toBe(true);
    expect(none.fall).toEqual({ slopePct: 0, fallDeg: 0 });

    // Dead flat: any ratio is met with no earth moved.
    const flat = windowOf(
      makeGrid(10, 10, () => 3),
      rect(X0, Y0 - 10, X0 + 10, Y0),
    );
    const level = design(flat, { mode: "level" }, { ratio: 1.3 });
    expect(level.plane.z0).toBe(3);
    expect(level.works).toMatchObject({ cutM3: 0, fillM3: 0, ratio: 1 });
    expect(level.works.onGradeAreaHa).toBeCloseTo(flat.areaM2 / 1e4, 12);

    // One row of cells has no plane to fit: fit mode designs level.
    const row = windowOf(
      makeGrid(10, 10, (x) => x - X0),
      rect(X0, Y0 - 1, X0 + 10, Y0),
    );
    expect(row.grid.height).toBe(1);
    expect(robustFit(row)).toBeNull();
    const rowDesign = design(row, { mode: "fit" });
    expect(rowDesign.fall.slopePct).toBe(0);
    expect(rowDesign.works.ratio).toBeCloseTo(1, 9);

    // A single cell sits on its own design.
    const one = windowOf(
      makeGrid(10, 10, () => 7),
      rect(X0 + 2, Y0 - 3, X0 + 3, Y0 - 2),
    );
    expect(one.validCount).toBe(1);
    expect(robustFit(one)).toBeNull();
    expect(
      design(one, { mode: "slope", mainPct: 1, bearingDeg: 0, crossPct: 0 })
        .works,
    ).toMatchObject({ cutM3: 0, fillM3: 0, ratio: 1, haulM: 0 });
  });

  it("refuses an offset it cannot apply", () => {
    expect(() => design(w, { mode: "level" }, { offsetM: NaN })).toThrow(
      RangeError,
    );
  });

  it("balances and measures a 1000 × 1000 cell field within 300 ms", () => {
    // 25 ha at the native 0.5 m: a fall, long swells and short-wave roughness.
    const g = makeGrid(
      1000,
      1000,
      (x, y) => {
        const [u, v] = [x - X0, Y0 - y];
        return (
          30 +
          0.002 * u -
          0.001 * v +
          0.15 * Math.sin(u / 23) * Math.cos(v / 31) +
          0.02 * Math.sin(u * 12.9898 + v * 78.233)
        );
      },
      0.5,
    );
    const big = windowOf(g, rect(X0, Y0 - 500, X0 + 500, Y0));
    expect(big.validCount).toBe(1e6);
    const plane = designPlane(big, {
      mode: "slope",
      mainPct: 0.15,
      bearingDeg: 120,
      crossPct: 0.05,
    });
    const t0 = performance.now();
    const works = earthworks(big, balance(big, plane, 1.2));
    const ms = performance.now() - t0;
    expect(rel(works.ratio, 1.2)).toBeLessThan(1e-6);
    expect(ms).toBeLessThan(300);
  });
});

describe("transportHaulM", () => {
  // A flat 100 × 40 m field at 30 m, level design at 30 m: depth = height − 30.
  const k = lambert93ScaleFactor(lambert93ToLngLat({ x: X0, y: Y0 }).lat);
  const flatWith = (f: (x: number, y: number) => number) => {
    const w = windowOf(
      makeGrid(100, 40, (x, y) => 30 + f(x - X0, Y0 - y)),
      rect(X0, Y0 - 40, X0 + 100, Y0),
    );
    const depth = Float32Array.from(w.grid.data, (v) => v - 30);
    return { w, depth };
  };

  it("measures the separation of a mound and a hollow", () => {
    // Mound at x 10..20, hollow at x 70..80, same rows: 60 m apart.
    const { w, depth } = flatWith((x, y) =>
      y >= 10 && y < 30
        ? x >= 10 && x < 20
          ? 0.2
          : x >= 70 && x < 80
            ? -0.2
            : 0
        : 0,
    );
    const haul = transportHaulM(w, depth);
    expect(haul).toBeGreaterThan(59.5 / k);
    expect(haul).toBeLessThan(60.5 / k);
  });

  it("does not collapse when cut and fill interleave, unlike the centroids", () => {
    // 10 m checkerboard of ±0.1 m: centroids coincide, soil moves ~10 m.
    const { w, depth } = flatWith((x, y) =>
      (Math.floor(x / 10) + Math.floor(y / 10)) % 2 ? 0.1 : -0.1,
    );
    const works = earthworks(w, { x0: X0, y0: Y0, z0: 30, gx: 0, gy: 0 }, 0.02);
    expect(works.haulM).toBeLessThan(2);
    const haul = transportHaulM(w, depth);
    expect(haul).toBeGreaterThan(2.5);
    expect(haul).toBeLessThan(10);
  });

  it("is zero when there is nothing to move to", () => {
    const { w, depth } = flatWith((x) => (x < 50 ? 0.1 : 0));
    expect(transportHaulM(w, depth)).toBe(0);
  });
});
