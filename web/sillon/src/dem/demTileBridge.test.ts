import { inflateSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  demTileTemplate,
  FALLBACK_LAYER,
  fetchDemTileHeights,
  parseDemTilePath,
  renderDemTile,
} from "./demTileBridge";
import { decodeTerrarium } from "./terrarium";

const bilResponse = (values: Float32Array) =>
  new Response(values.buffer as ArrayBuffer, {
    headers: { "content-type": "image/x-bil;bits=32" },
  });

describe("DEM tile bridge paths", () => {
  it("builds a template the parser accepts once filled in", () => {
    const template = demTileTemplate("http://localhost:5173/", "mnt", 256);
    expect(template).toBe(
      "http://localhost:5173/__sillon/dem/mnt/256/{z}/{x}/{y}.png",
    );
    const url = new URL(
      template
        .replace("{z}", "17")
        .replace("{x}", "67193")
        .replace("{y}", "47869"),
    );
    expect(parseDemTilePath(url.pathname)).toEqual({
      product: "mnt",
      tileSize: 256,
      z: 17,
      x: 67193,
      y: 47869,
    });
  });

  it("works under a base path and rejects bad tiles and products", () => {
    expect(
      parseDemTilePath("/app/__sillon/dem/mns/512/3/1/2.png")?.product,
    ).toBe("mns");
    expect(parseDemTilePath("/__sillon/dem/mnt/256/3/8/0.png")).toBeNull();
    expect(parseDemTilePath("/__sillon/dem/dsm/256/3/1/1.png")).toBeNull();
    expect(parseDemTilePath("/__sillon/dem/mnt/300/3/1/1.png")).toBeNull();
    expect(parseDemTilePath("/tiles/3/1/1.png")).toBeNull();
  });
});

describe("fetchDemTileHeights", () => {
  it("requests the tile's EPSG:3857 bbox as BIL from the mixed DTM", async () => {
    const fetchImpl = vi.fn(async () =>
      bilResponse(new Float32Array(256 * 256).fill(1.25)),
    );
    const { heights, degraded } = await fetchDemTileHeights(
      { product: "mnt", tileSize: 256, z: 17, x: 67193, y: 47869 },
      { fetchImpl },
    );
    expect(heights[0]).toBe(1.25);
    expect(degraded).toBe(false);
    const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
    expect(url.searchParams.get("LAYERS")).toBe(
      "IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G",
    );
    expect(url.searchParams.get("CRS")).toBe("EPSG:3857");
    expect(url.searchParams.get("FORMAT")).toBe("image/x-bil;bits=32");
    const [minX, minY, maxX, maxY] = String(url.searchParams.get("BBOX"))
      .split(",")
      .map(Number);
    expect(maxX - minX).toBeCloseTo(305.748, 2);
    expect(maxY - minY).toBeCloseTo(305.748, 2);
  });

  it("skips the network outside France and at low zoom", async () => {
    const fetchImpl = vi.fn();
    const ny = await fetchDemTileHeights(
      { product: "mnt", tileSize: 256, z: 12, x: 1206, y: 1539 },
      { fetchImpl },
    );
    const z5 = await fetchDemTileHeights(
      { product: "mnt", tileSize: 256, z: 5, x: 16, y: 11 },
      { fetchImpl },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ny.heights.every(Number.isNaN)).toBe(true);
    expect(z5.heights.length).toBe(256 * 256);
  });

  it("falls back to RGE ALTI when the service times out, and says so", async () => {
    vi.useFakeTimers();
    const layers: (string | null)[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const layer = new URL(String(input)).searchParams.get("LAYERS");
      layers.push(layer);
      return layer === FALLBACK_LAYER
        ? bilResponse(new Float32Array(256 * 256).fill(2))
        : new Response("Gateway Time-out", { status: 504 });
    });
    const pending = fetchDemTileHeights(
      { product: "mnt", tileSize: 256, z: 9, x: 263, y: 187 },
      { fetchImpl, retries: 1 },
    );
    await vi.runAllTimersAsync();
    const { heights, degraded } = await pending;
    vi.useRealTimers();
    expect(degraded).toBe(true);
    expect(heights[0]).toBe(2);
    expect(layers).toEqual([
      "IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G",
      "IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G",
      FALLBACK_LAYER,
    ]);
  });

  it("does not fall back on client errors", async () => {
    const xml = new Response(
      "<ServiceExceptionReport><ServiceException>bad</ServiceException></ServiceExceptionReport>",
      { status: 400, headers: { "content-type": "text/xml" } },
    );
    await expect(
      fetchDemTileHeights(
        { product: "mnt", tileSize: 256, z: 17, x: 67193, y: 47869 },
        { fetchImpl: async () => xml },
      ),
    ).rejects.toThrow("bad");
  });
});

describe("renderDemTile", () => {
  it("encodes heights as a Terrarium PNG", async () => {
    const heights = new Float32Array(256 * 256).map((_, i) => (i % 256) * 0.01);
    const { png } = await renderDemTile(
      { product: "mnt", tileSize: 256, z: 17, x: 67193, y: 47869 },
      { fetchImpl: async () => bilResponse(heights) },
    );
    // IDAT starts after the 8-byte signature and the 25-byte IHDR chunk.
    const view = new DataView(png.buffer, png.byteOffset);
    const idatLen = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    // Third pixel of the first row, un-filtered by adding the two pixels left of it.
    const px = [0, 1, 2].map(
      (c) => (raw[1 + c] + raw[4 + c] + raw[7 + c]) & 0xff,
    );
    expect(decodeTerrarium(px[0], px[1], px[2])).toBeCloseTo(0.02, 2);
  });
});
