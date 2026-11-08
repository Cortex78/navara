import { describe, expect, it } from "vitest";

import {
  lambert93ToLngLat,
  lngLatLatticeToLambert93,
  lngLatToLambert93,
} from "../geo/lambert93";

import type { ElevationGrid } from "./elevationGrid";
import { fieldSurface, maskGridCells } from "./fieldMask";

// 100 x 100 cells of 1 m; height = column index / 10 (a 1 % slope eastward).
const grid: ElevationGrid = {
  crs: "EPSG:2154",
  layer: "test",
  cellSize: 1,
  originX: 825000,
  originY: 6277100,
  width: 100,
  height: 100,
  data: Float32Array.from({ length: 10000 }, (_, i) => (i % 100) / 10),
};

const ring = (pts: [number, number][]) =>
  pts.map(([x, y]) => lambert93ToLngLat({ x, y }));

describe("maskGridCells", () => {
  it("selects the cells whose centres are inside a rectangle", () => {
    const cells = maskGridCells(grid, [
      [
        ring([
          [825010, 6277090],
          [825030, 6277090],
          [825030, 6277080],
          [825010, 6277080],
        ]),
      ],
    ]);
    expect(cells.length).toBe(200);
    expect(cells[0]).toBe(10 * 100 + 10);
  });

  it("leaves holes out", () => {
    const outer = ring([
      [825000, 6277100],
      [825100, 6277100],
      [825100, 6277000],
      [825000, 6277000],
    ]);
    const hole = ring([
      [825040, 6277060],
      [825060, 6277060],
      [825060, 6277040],
      [825040, 6277040],
    ]);
    expect(maskGridCells(grid, [[outer, hole]]).length).toBe(10000 - 400);
  });
});

describe("fieldSurface", () => {
  it("measures area and relief of the cells inside", () => {
    const s = fieldSurface(grid, [
      [
        ring([
          [825000, 6277100],
          [825050, 6277100],
          [825050, 6277000],
          [825000, 6277000],
        ]),
      ],
    ]);
    expect(s).not.toBeNull();
    if (!s) return;
    expect(s.min).toBeCloseTo(0, 5);
    expect(s.max).toBeCloseTo(4.9, 5);
    expect(s.mean).toBeCloseTo(2.45, 5);
    // 5000 m² on the map; south of 44°N Lambert-93 stretches distances, so
    // slightly less on the ground.
    expect(s.areaHa).toBeGreaterThan(0.499);
    expect(s.areaHa).toBeLessThan(0.5);
    expect(s.nodataShare).toBe(0);
  });

  it("returns null for a polygon off the grid", () => {
    expect(
      fieldSurface(grid, [
        [
          ring([
            [0, 0],
            [1, 0],
            [1, 1],
          ]),
        ],
      ]),
    ).toBeNull();
  });
});

describe("lngLatLatticeToLambert93", () => {
  it("matches projecting each point", () => {
    const lngs = [4.5, 4.55, 4.6];
    const lats = [43.5, 43.6];
    const { xs, ys } = lngLatLatticeToLambert93(lngs, lats);
    lats.forEach((lat, j) =>
      lngs.forEach((lng, i) => {
        const p = lngLatToLambert93({ lng, lat });
        expect(xs[j * 3 + i]).toBeCloseTo(p.x, 6);
        expect(ys[j * 3 + i]).toBeCloseTo(p.y, 6);
      }),
    );
  });
});
