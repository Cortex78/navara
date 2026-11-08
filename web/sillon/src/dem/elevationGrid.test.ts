import { describe, expect, it, vi } from "vitest";

import { lngLatToLambert93 } from "../geo/lambert93";

import {
  alignGrid,
  gridPercentiles,
  gridStats,
  lambert93EnvelopeOfLngLatBounds,
  loadElevationGrid,
  MAX_GRID_CELLS,
  sampleGrid,
  type ElevationGrid,
} from "./elevationGrid";

describe("alignGrid", () => {
  it("reproduces IGN's own 1 km LiDAR HD tile at 0.5 m", () => {
    // The MNT tile LHD_FXX_0825_6278 is published with this exact bbox.
    const g = alignGrid(
      { minX: 825000, minY: 6277000.5, maxX: 825999.5, maxY: 6278000 },
      0.5,
    );
    expect(g).toEqual({
      originX: 824999.75,
      originY: 6278000.25,
      width: 2000,
      height: 2000,
    });
  });

  it("always covers the requested box", () => {
    const bbox = {
      minX: 825000.1,
      minY: 6277000.3,
      maxX: 825010.9,
      maxY: 6277020.6,
    };
    for (const cell of [0.5, 1, 2]) {
      const g = alignGrid(bbox, cell);
      expect(g.originX).toBeLessThanOrEqual(bbox.minX);
      expect(g.originY).toBeGreaterThanOrEqual(bbox.maxY);
      expect(g.originX + g.width * cell).toBeGreaterThanOrEqual(bbox.maxX);
      expect(g.originY - g.height * cell).toBeLessThanOrEqual(bbox.minY);
    }
  });
});

describe("lambert93EnvelopeOfLngLatBounds", () => {
  it("contains every projected edge point of the rectangle", () => {
    const b = { west: 4.54, south: 43.58, east: 4.57, north: 43.6 };
    const env = lambert93EnvelopeOfLngLatBounds(b);
    for (const p of [
      { lng: b.west, lat: b.north },
      { lng: (b.west + b.east) / 2, lat: b.north },
      { lng: b.east, lat: b.south },
    ]) {
      const { x, y } = lngLatToLambert93(p);
      expect(x).toBeGreaterThanOrEqual(env.minX);
      expect(x).toBeLessThanOrEqual(env.maxX);
      expect(y).toBeGreaterThanOrEqual(env.minY);
      expect(y).toBeLessThanOrEqual(env.maxY);
    }
  });
});

describe("loadElevationGrid", () => {
  it("mosaics chunked GetMap responses into one north-up grid", async () => {
    const urls: URL[] = [];
    // Each chunk is filled with a value encoding its own bbox's left/top edge,
    // so placement in the mosaic can be checked.
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      const w = Number(url.searchParams.get("WIDTH"));
      const h = Number(url.searchParams.get("HEIGHT"));
      const [minX, , , maxY] = String(url.searchParams.get("BBOX"))
        .split(",")
        .map(Number);
      const out = new Float32Array(w * h);
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++)
          out[r * w + c] = (minX - 825000 + c) * 1000 + (6277100 - maxY + r);
      }
      out[0] = -9999;
      return new Response(out.buffer, {
        headers: { "content-type": "image/x-bil;bits=32" },
      });
    });
    const progress: number[] = [];
    const grid = await loadElevationGrid({
      bbox: { minX: 825000, minY: 6277000, maxX: 825025, maxY: 6277100 },
      cellSize: 1,
      chunkPixels: 40,
      fetchImpl,
      onProgress: (p) => progress.push(p.done),
    });

    expect(grid.width).toBe(26);
    expect(grid.height).toBe(101);
    expect(urls).toHaveLength(3);
    expect(progress).toEqual([0, 1, 2, 3]);
    for (const url of urls) {
      expect(url.searchParams.get("CRS")).toBe("EPSG:2154");
      expect(url.searchParams.get("LAYERS")).toBe(
        "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93",
      );
    }
    // Cell (col 3, row 50) lives in the second chunk (rows 40..79).
    const col = 3;
    const row = 50;
    const x = grid.originX + col;
    const y = grid.originY - row;
    expect(grid.data[row * grid.width + col]).toBeCloseTo(
      (x - 825000) * 1000 + (6277100 - y),
      3,
    );
    // Each chunk's first cell was no-data.
    expect(grid.data[0]).toBeNaN();
    expect(grid.data[40 * grid.width]).toBeNaN();
  });

  it("refuses grids too large to hold", async () => {
    const side = Math.ceil(Math.sqrt(MAX_GRID_CELLS)) * 0.5 + 10;
    await expect(
      loadElevationGrid({
        bbox: { minX: 0, minY: 0, maxX: side, maxY: side },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(RangeError);
  });
});

const grid2x2 = (values: number[]): ElevationGrid => ({
  crs: "EPSG:2154",
  layer: "test",
  cellSize: 1,
  originX: 100,
  originY: 200,
  width: 2,
  height: 2,
  data: new Float32Array(values),
});

describe("sampleGrid", () => {
  it("interpolates between cell centres", () => {
    const g = grid2x2([0, 1, 2, 3]);
    expect(sampleGrid(g, { x: 100.5, y: 199.5 })).toBe(0);
    expect(sampleGrid(g, { x: 101, y: 199 })).toBeCloseTo(1.5);
    expect(sampleGrid(g, { x: 101.5, y: 198.5 })).toBe(3);
  });

  it("falls back to the nearest cell next to no-data, NaN outside", () => {
    const g = grid2x2([0, NaN, 2, 3]);
    expect(sampleGrid(g, { x: 100.6, y: 199.4 })).toBe(0);
    expect(sampleGrid(g, { x: 99, y: 199 })).toBeNaN();
  });
});

describe("gridPercentiles", () => {
  it("ignores no-data and resists outliers", () => {
    const values = Array.from({ length: 1000 }, (_, i) => i / 100);
    values[0] = NaN;
    values[999] = 500;
    const g = {
      ...grid2x2([]),
      width: 1000,
      height: 1,
      data: new Float32Array(values),
    };
    const [p1, p50, p99] = gridPercentiles(g, [0.01, 0.5, 0.99]);
    expect(p1).toBeCloseTo(0.11, 2);
    expect(p50).toBeCloseTo(5.0, 1);
    expect(p99).toBeLessThan(10);
  });
});

describe("gridStats", () => {
  it("summarises valid cells and corrects cell area for the projection", () => {
    const s = gridStats({
      ...grid2x2([1, NaN, 3, 5]),
      originX: 825000,
      originY: 6277000,
    });
    expect(s).toMatchObject({
      min: 1,
      max: 5,
      mean: 3,
      validCells: 3,
      nodataCells: 1,
    });
    // Near 43.6°N Lambert-93 stretches distances by ~0.06 %.
    expect(s.cellAreaM2).toBeGreaterThan(0.998);
    expect(s.cellAreaM2).toBeLessThan(1);
  });
});
