import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { crc32, encodePngRgb } from "./png";

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
const unfilter = (raw: Uint8Array, width: number, height: number) => {
  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    for (let i = 0; i < stride; i++) {
      const left = i >= 3 ? out[y * stride + i - 3] : 0;
      out[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + left) & 0xff;
    }
  }
  return out;
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
