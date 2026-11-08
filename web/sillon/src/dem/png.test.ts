import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { crc32, encodePngRgb, encodePngRgba } from "./png";

type Chunk = { type: string; data: Uint8Array };

const readChunks = (png: Uint8Array): Chunk[] => {
  expect([...png.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Chunk[] = [];
  for (let o = 8; o < png.length;) {
    const len = view.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    const crc = (crc32(png.subarray(o + 4, o + 8 + len)) ^ 0xffffffff) >>> 0;
    expect(view.getUint32(o + 8 + len)).toBe(crc);
    chunks.push({ type, data });
    o += 12 + len;
  }
  return chunks;
};

/** Undoes the Sub filter the encoder writes on every scanline. */
const unfilter = (raw: Uint8Array, width: number, height: number, bpp = 3) => {
  const stride = width * bpp;
  expect(raw.length).toBe((stride + 1) * height);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? out[y * stride + i - bpp] : 0;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + left) & 0xff;
    }
  }
  return out;
};

/** IHDR as [width, height, bit depth, colour type, compression, filter, interlace]. */
const ihdrFields = ({ data }: Chunk) => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  expect(data.length).toBe(13);
  return [view.getUint32(0), view.getUint32(4), ...data.subarray(8, 13)];
};

describe("encodePngRgb", () => {
  it("writes a valid PNG whose pixels decode back exactly", async () => {
    const width = 7;
    const height = 5;
    const rgb = new Uint8Array(width * height * 3).map(
      (_, i) => (i * 37 + 11) & 0xff,
    );
    const chunks = readChunks(await encodePngRgb(rgb, width, height));

    expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    const ihdr = new DataView(
      chunks[0].data.buffer,
      chunks[0].data.byteOffset,
      13,
    );
    expect([
      ihdr.getUint32(0),
      ihdr.getUint32(4),
      chunks[0].data[8],
      chunks[0].data[9],
    ]).toEqual([width, height, 8, 2]);
    expect(unfilter(inflateSync(chunks[1].data), width, height)).toEqual(rgb);
  });

  it("knows the CRC-32 check value", () => {
    expect(
      (crc32(new TextEncoder().encode("123456789")) ^ 0xffffffff) >>> 0,
    ).toBe(0xcbf43926);
  });
});

describe("encodePngRgba", () => {
  it("writes an RGBA PNG whose pixels decode back exactly, alpha included", async () => {
    // One-pixel-wide rows have nothing to the left; 7 × 5 wraps the filter.
    for (const [width, height] of [
      [1, 1],
      [1, 4],
      [7, 5],
    ]) {
      const rgba = new Uint8Array(width * height * 4).map(
        (_, i) => (i * 53 + 7) & 0xff,
      );
      // Straight alpha: a fully transparent pixel keeps its colour.
      rgba.set([200, 100, 50, 0], 0);
      const chunks = readChunks(await encodePngRgba(rgba, width, height));

      expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
      expect(ihdrFields(chunks[0])).toEqual([width, height, 8, 6, 0, 0, 0]);
      expect(chunks[2].data.length).toBe(0);
      expect(unfilter(inflateSync(chunks[1].data), width, height, 4)).toEqual(
        rgba,
      );
    }
  });

  it("takes the Uint8ClampedArray an ImageData-style raster comes in", async () => {
    const rgba = Uint8ClampedArray.from({ length: 3 * 2 * 4 }, (_, i) =>
      i % 4 === 3 ? 46 : i * 9,
    );
    const png = await encodePngRgba(rgba, 3, 2);
    expect(png).toEqual(await encodePngRgba(Uint8Array.from(rgba), 3, 2));
    const [, idat] = readChunks(png);
    expect(unfilter(inflateSync(idat.data), 3, 2, 4)).toEqual(
      Uint8Array.from(rgba),
    );
  });

  it("refuses a buffer that does not match the size, or an empty image", async () => {
    await expect(
      encodePngRgba(new Uint8Array(2 * 2 * 3), 2, 2),
    ).rejects.toThrow(RangeError);
    await expect(encodePngRgba(new Uint8Array(0), 0, 0)).rejects.toThrow(
      RangeError,
    );
    await expect(encodePngRgba(new Uint8Array(8), 2.5, 0.8)).rejects.toThrow(
      RangeError,
    );
  });
});
