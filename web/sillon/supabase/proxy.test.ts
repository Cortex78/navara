import { inflateSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeGrid } from "../artifact/pack";
import type { ElevationGrid } from "../src/dem/elevationGrid";
import { maskGridCells } from "../src/dem/fieldMask";
import { lambert93ToLngLat } from "../src/geo/lambert93";
import { ELEVATION_LAYERS } from "../src/ign/geoplateforme";

import { keyValue, KEY_PATTERN, MAX_KEYS } from "./keys";
import {
  encodeFieldGrid,
  fieldGridCellSize,
  handleField,
  handleFieldGrid,
  handleProfile,
  handleProxy,
  MAX_FIELD_GRID_CELLS,
  toBase64,
  type FieldGridAnswer,
} from "./proxy";

const decode = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

afterEach(() => vi.unstubAllGlobals());

/**
 * Stubs the WMS-R GetMap that elevation grids load through: float32 heights
 * from `height` at each cell centre, the -9999 no-data value where it is NaN.
 */
const stubWms = (height: (x: number, y: number, lidar: boolean) => number) => {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    const lidar = (q.get("LAYERS") ?? "").includes("LAMB93");
    const [minX, , maxX, maxY] = (q.get("BBOX") ?? "").split(",").map(Number);
    const w = Number(q.get("WIDTH"));
    const h = Number(q.get("HEIGHT"));
    const cs = (maxX - minX) / w;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++) {
        const v = height(minX + (c + 0.5) * cs, maxY - (r + 0.5) * cs, lidar);
        data[r * w + c] = Number.isNaN(v) ? -9999 : v;
      }
    return new Response(data.buffer);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

/** GeoJSON Polygon coordinates (lng/lat) of Lambert-93 rings, closed. */
const polygonAt = (...rings: [number, number][][]) =>
  rings.map((ring) =>
    [...ring, ring[0]].map(([x, y]) => {
      const { lng, lat } = lambert93ToLngLat({ x, y });
      return [lng, lat];
    }),
  );

/** Reads an answer back with node:zlib, as bake.ts's deflateSync output would be. */
const readGrid = (a: FieldGridAnswer): ElevationGrid => ({
  crs: "EPSG:2154",
  layer: a.layer,
  cellSize: a.cellSize,
  originX: a.originX,
  originY: a.originY,
  width: a.width,
  height: a.height,
  data: decodeGrid(
    new Uint8Array(inflateSync(decode(a.data))),
    a.width,
    a.scale,
  ).map((v) => v + a.base),
});

/**
 * Compares a grid with `surface` at its cell centres: the worst error over
 * the field's cells, and the cells of either kind that break the rule
 * (inside with no height, outside with one).
 */
const checkField = (
  g: ElevationGrid,
  polygon: number[][][],
  surface: (x: number, y: number) => number,
) => {
  const inside = new Set(
    maskGridCells(g, [
      polygon.map((r) => r.map(([lng, lat]) => ({ lng, lat }))),
    ]),
  );
  let maxError = 0;
  let missing = 0;
  let stray = 0;
  for (let i = 0; i < g.data.length; i++) {
    const v = g.data[i];
    if (!inside.has(i)) {
      if (!Number.isNaN(v)) stray++;
      continue;
    }
    if (Number.isNaN(v)) {
      missing++;
      continue;
    }
    const col = i % g.width;
    const row = (i - col) / g.width;
    const x = g.originX + (col + 0.5) * g.cellSize;
    const y = g.originY - (row + 0.5) * g.cellSize;
    // Against the float32 the stub sent, which already rounds at altitude.
    maxError = Math.max(maxError, Math.abs(v - Math.fround(surface(x, y))));
  }
  return { inside: inside.size, maxError, missing, stray };
};

describe("toBase64", () => {
  it("encodes bytes past the chunk size", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i & 0xff);
    expect(decode(toBase64(bytes))).toEqual(bytes);
  });
});

describe("KEY_PATTERN", () => {
  it.each([
    "kind=ortho&z=17&x=67193&y=47869",
    "kind=geocode&q=Saintes-Maries%20de%20la%20mer",
    "kind=rpg&w=4.55&s=43.58&e=4.56&n=43.59",
  ])("accepts %s", (k) => expect(KEY_PATTERN.test(k)).toBe(true));
  it.each([
    "kind=ortho'; drop table x;--",
    "z=1&kind=ortho",
    "kind=geocode&q=a b",
  ])("rejects %s", (k) => expect(KEY_PATTERN.test(k)).toBe(false));
});

describe("keyValue", () => {
  it("keeps encoded values inside the key pattern", () => {
    for (const q of [
      "Saintes-Maries-de-la-Mer",
      "L'Isle-sur-la-Sorgue (84)",
      "rue d'Arles, 13200",
    ]) {
      const key = `kind=geocode&q=${keyValue(q)}`;
      expect(KEY_PATTERN.test(key)).toBe(true);
      expect(key).not.toContain("'");
      expect(new URLSearchParams(key).get("q")).toBe(q);
    }
  });
});

describe("handleProxy", () => {
  it("fetches imagery tiles from IGN WMTS and base64-encodes them", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetchMock = vi.fn(
      async () =>
        new Response(jpeg, { headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const out = await handleProxy(["kind=ortho&z=17&x=67193&y=47869"]);
    const item = out["kind=ortho&z=17&x=67193&y=47869"];
    expect(item).toMatchObject({
      status: 200,
      ctype: "image/jpeg",
      cache: true,
    });
    expect(decode(item.b64)).toEqual(jpeg);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("LAYER")).toBe("ORTHOIMAGERY.ORTHOPHOTOS");
    expect(url.searchParams.get("TILEMATRIX")).toBe("17");
    expect(url.searchParams.get("TILECOL")).toBe("67193");
  });

  it("answers bad keys with an uncached error item instead of failing the batch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const out = await handleProxy(["kind=ortho&z=40&x=0&y=0", "kind=nope&z=1"]);
    for (const item of Object.values(out))
      expect(item).toMatchObject({ status: 502, cache: false });
  });

  it("refuses oversized batches", async () => {
    await expect(
      handleProxy(
        Array.from({ length: MAX_KEYS + 1 }, () => "kind=ortho&z=1&x=0&y=0"),
      ),
    ).rejects.toThrow();
  });
});

describe("handleProfile", () => {
  it("fills the stretch LiDAR HD has not flown from RGE ALTI", async () => {
    // LiDAR HD stops at x = 825150; the gap-filled layer covers it all.
    stubWms((x, _y, lidar) => (lidar && x > 825150 ? NaN : (x - 825000) / 100));
    const line = [
      lambert93ToLngLat({ x: 825000, y: 6277000 }),
      lambert93ToLngLat({ x: 825300, y: 6277000 }),
    ].map(({ lng, lat }) => [lng, lat]);
    const out = await handleProfile(line);
    expect(out.step).toBe(1);
    expect(out.source).toBe("LiDAR HD + RGE ALTI");
    expect(out.d).toHaveLength(out.h.length);
    expect(out.d.length).toBeGreaterThan(300);
    expect(out.h.every((v) => v !== null)).toBe(true);
    expect(out.h[out.h.length - 1]).toBeCloseTo(3, 2);
  });

  it("refuses lines over 10 km", async () => {
    await expect(
      handleProfile([
        [4.5, 43.5],
        [4.7, 43.5],
      ]),
    ).rejects.toThrow(/10 km/);
  });
});

describe("handleField", () => {
  it("measures every part of a MultiPolygon field on the native grid", async () => {
    // A 1 % rise toward the east.
    stubWms((x) => 2 + (x - 825000) / 100);
    const out = await handleField([
      polygonAt([
        [825000.3, 6277000.3],
        [825040.3, 6277000.3],
        [825040.3, 6277030.3],
        [825000.3, 6277030.3],
      ]),
      polygonAt([
        [825100.3, 6277000.3],
        [825140.3, 6277000.3],
        [825140.3, 6277030.3],
        [825100.3, 6277030.3],
      ]),
    ]);
    expect(out).toMatchObject({
      cellSize: 0.5,
      source: "LiDAR HD",
      nodataShare: 0,
      // Two 40 × 30 m parts; a hair less on the ground than on the map.
      areaHa: expect.closeTo(0.24, 3),
      slopePct: expect.closeTo(1, 2),
      fallDeg: expect.closeTo(270, 3),
    });
  });
});

describe("fieldGridCellSize", () => {
  const box = (w: number, h: number) => ({
    minX: 825000.1,
    minY: 6277000.1,
    maxX: 825000.1 + w,
    maxY: 6277000.1 + h,
  });

  it("keeps the native 0.5 m while the grid fits", () => {
    // 401 × 401 cells.
    expect(fieldGridCellSize(box(200, 200))).toBe(0.5);
  });

  it("counts the aligned grid, edge cells included", () => {
    // 500 × 500 cells of 4 m would fit, but aligned they are 501 × 501.
    expect(fieldGridCellSize(box(2000, 2000))).toBe(5);
  });

  it("gives up when even 5 m cells are too many", () => {
    expect(fieldGridCellSize(box(1_000_000, 4))).toBeUndefined();
  });
});

describe("handleFieldGrid", () => {
  // 40 × 30 m, corners off the cell-centre lattice.
  const rect = polygonAt([
    [825000.3, 6277000.3],
    [825040.3, 6277000.3],
    [825040.3, 6277030.3],
    [825000.3, 6277030.3],
  ]);

  it("sends the field's LiDAR HD heights, cropped to it, NaN outside", async () => {
    // A tilted plane with a ripple, so each cell has its own height.
    const surface = (x: number, y: number) =>
      3.5 +
      (x - 825000) * 0.004 -
      (y - 6277000) * 0.002 +
      0.1 * Math.sin(x / 3);
    stubWms(surface);
    // A triangle with a 10 m square hole.
    const field = polygonAt(
      [
        [825010.13, 6277010.29],
        [825090.41, 6277010.29],
        [825010.13, 6277070.77],
      ],
      [
        [825020.2, 6277020.2],
        [825030.2, 6277020.2],
        [825030.2, 6277030.2],
        [825020.2, 6277030.2],
      ],
    );
    const out = await handleFieldGrid(field);
    expect(out).toMatchObject({
      layer: ELEVATION_LAYERS.lidarMntL93,
      source: "LiDAR HD",
      cellSize: 0.5,
      base: 3,
      scale: 0.01,
      // The bounding box of the cells inside, on the native lattice: the
      // first centres are (825010.5, 6277070), the last (825090, 6277010.5).
      originX: 825010.25,
      originY: 6277070.25,
      width: 160,
      height: 120,
    });
    const check = checkField(readGrid(out), field, surface);
    expect(check.missing).toBe(0);
    expect(check.stray).toBe(0);
    expect(check.maxError).toBeLessThanOrEqual(0.005 + 1e-6);
    // (80.28 × 60.48 / 2 − 100) m² in cells of 0.25 m².
    expect(check.inside).toBeCloseTo(9311, -2);
  });

  it("stores heights above a whole-metre base, so a 1500 m field keeps 1 cm steps", async () => {
    const surface = (x: number, y: number) =>
      1500.37 + (x - 825000) * 0.01 + 0.05 * Math.cos(y / 2);
    stubWms(surface);
    const out = await handleFieldGrid(rect);
    expect(out).toMatchObject({ base: 1500, scale: 0.01 });
    const check = checkField(readGrid(out), rect, surface);
    expect(check.missing + check.stray).toBe(0);
    // Float32 heights at 1500 m are 1.2e-4 m apart, on top of the 5 mm.
    expect(check.maxError).toBeLessThanOrEqual(0.005 + 1.3e-4);
  });

  it("coarsens the cells until the grid fits MAX_FIELD_GRID_CELLS", async () => {
    const surface = (x: number) => 2 + (x - 825000) / 100;
    stubWms(surface);
    // A 600 m square: 1.44 M cells at 0.5 m, 361 k at 1 m.
    const field = polygonAt([
      [825000.1, 6277000.1],
      [825600.1, 6277000.1],
      [825600.1, 6277600.1],
      [825000.1, 6277600.1],
    ]);
    const out = await handleFieldGrid(field);
    expect(out).toMatchObject({ cellSize: 1.5, width: 400, height: 400 });
    expect(out.width * out.height).toBeLessThanOrEqual(MAX_FIELD_GRID_CELLS);
    // Cell centres on multiples of 1.5 m, as alignGrid lays them.
    expect(Number.isInteger(out.originX / out.cellSize + 0.5)).toBe(true);
    expect(Number.isInteger(out.originY / out.cellSize + 0.5)).toBe(true);
    const check = checkField(readGrid(out), field, surface);
    expect(check.missing + check.stray).toBe(0);
    expect(check.maxError).toBeLessThanOrEqual(0.005 + 1e-6);
  });

  it("falls back to RGE ALTI when LiDAR HD has no heights for the field", async () => {
    const surface = (x: number) => 7 + (x - 825000) / 100;
    const fetchMock = stubWms((x, _y, lidar) => (lidar ? NaN : surface(x)));
    const out = await handleFieldGrid(rect);
    expect(out).toMatchObject({
      source: "RGE ALTI",
      layer: ELEVATION_LAYERS.lidarMntMixed,
      base: 7,
    });
    const check = checkField(readGrid(out), rect, surface);
    expect(check.missing + check.stray).toBe(0);
    expect(check.maxError).toBeLessThanOrEqual(0.005 + 1e-6);
    const layers = fetchMock.mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get("LAYERS"),
    );
    expect(layers).toEqual([
      ELEVATION_LAYERS.lidarMntL93,
      ELEVATION_LAYERS.lidarMntMixed,
    ]);
  });

  it("falls back to the mixed layer when the LiDAR HD layer fails to load", async () => {
    const surface = (x: number) => 7 + (x - 825000) / 100;
    stubWms((x) => surface(x));
    const wms = globalThis.fetch as unknown as (
      url: string | URL | Request,
    ) => Promise<Response>;
    // The LiDAR HD layer answers with an OGC exception; RGE ALTI works.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        String(url).includes("LAMB93")
          ? new Response(
              '<ServiceExceptionReport><ServiceException code="LayerNotDefined">Layer unavailable</ServiceException></ServiceExceptionReport>',
              { status: 400, headers: { "content-type": "text/xml" } },
            )
          : wms(url),
      ),
    );
    const grid = await handleFieldGrid(rect);
    // The mixed layer serves LiDAR HD where flown: not called RGE ALTI.
    expect(grid).toMatchObject({ source: "LiDAR HD + RGE ALTI", base: 7 });
    expect(checkField(readGrid(grid), rect, surface).missing).toBe(0);
    const stats = await handleField(rect);
    expect(stats).toMatchObject({
      source: "LiDAR HD + RGE ALTI",
      slopePct: expect.closeTo(1, 2),
    });
  });

  it("keeps LiDAR HD, gap and all, when it covers most of the field", async () => {
    // LiDAR HD stops 30 m into the 40 m wide field.
    const surface = (x: number) => 7 + (x - 825000) / 100;
    const fetchMock = stubWms((x, _y, lidar) =>
      lidar && x > 825030.2 ? NaN : surface(x),
    );
    const out = await handleFieldGrid(rect);
    expect(out.source).toBe("LiDAR HD");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const check = checkField(readGrid(out), rect, surface);
    expect(check.stray).toBe(0);
    expect(check.missing / check.inside).toBeCloseTo(0.25, 6);
    expect(check.maxError).toBeLessThanOrEqual(0.005 + 1e-6);
  });

  it("names a field LiDAR HD flies in part 'LiDAR HD + RGE ALTI'", async () => {
    // LiDAR HD stops 10 m into the 40 m wide field: under half is flown.
    const surface = (x: number) => 7 + (x - 825000) / 100;
    stubWms((x, _y, lidar) => (lidar && x > 825010.2 ? NaN : surface(x)));
    const out = await handleFieldGrid(rect);
    expect(out.source).toBe("LiDAR HD + RGE ALTI");
    expect(out.layer).toBe(ELEVATION_LAYERS.lidarMntMixed);
  });

  it("answers 0 × 0 for a field neither layer has heights for", async () => {
    stubWms(() => NaN);
    const out = await handleFieldGrid(rect);
    expect(out).toMatchObject({ width: 0, height: 0, source: "RGE ALTI" });
    expect(readGrid(out).data).toHaveLength(0);
  });

  it("refuses fields over 4 km², as handleField does", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const big = [
      [
        [4.5, 43.5],
        [4.6, 43.5],
        [4.6, 43.6],
        [4.5, 43.5],
      ],
    ];
    await expect(handleFieldGrid(big)).rejects.toThrow(/4 km²/);
    await expect(handleField(big)).rejects.toThrow(/4 km²/);
  });
});

describe("encodeFieldGrid", () => {
  it("widens the step when the relief would overflow int16 at 1 cm", async () => {
    const data = Float32Array.from([212.4, 650.37, NaN, 1012.05, 500, 212.41]);
    const out = await encodeFieldGrid(
      {
        crs: "EPSG:2154",
        layer: "test",
        cellSize: 1,
        originX: 0,
        originY: 0,
        width: 3,
        height: 2,
        data,
      },
      "LiDAR HD",
    );
    // 800 m above the base: 3 cm steps keep it under 32767.
    expect(out).toMatchObject({ base: 212, scale: 0.03 });
    const back = readGrid(out).data;
    expect(Array.from(back, Number.isNaN)).toEqual(
      Array.from(data, Number.isNaN),
    );
    const errors = Array.from(data, (v, i) =>
      Number.isNaN(v) ? 0 : Math.abs(back[i] - v),
    );
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.015 + 1e-4);
  });

  it("sends a non-finite height as no-data instead of losing every cell to it", async () => {
    // bil.ts only screens the low sentinels, so +Infinity would pass as a height.
    const data = Float32Array.from([
      212.4,
      Infinity,
      NaN,
      213.05,
      212.5,
      212.41,
    ]);
    const out = await encodeFieldGrid(
      {
        crs: "EPSG:2154",
        layer: "test",
        cellSize: 1,
        originX: 0,
        originY: 0,
        width: 3,
        height: 2,
        data,
      },
      "LiDAR HD",
    );
    expect(out).toMatchObject({ base: 212, scale: 0.01 });
    const back = readGrid(out).data;
    expect(Array.from(back, Number.isNaN)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
    for (const i of [0, 3, 4, 5])
      expect(Math.abs(back[i] - data[i])).toBeLessThanOrEqual(0.005 + 1e-4);
  });
});
