/**
 * Minimal 8-bit RGB PNG encoder. Used instead of a canvas so the bytes are
 * exact: a 2D canvas may colour-manage or premultiply, and any change to a
 * byte of an elevation-encoded tile is a wrong height. Runs anywhere
 * `CompressionStream` exists (browsers, service workers, Node ≥ 18).
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array, crc = 0xffffffff): number => {
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return crc;
};

const zlibDeflate = async (data: Uint8Array): Promise<Uint8Array> => {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(
    8 + data.length,
    (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0,
  );
  return out;
};

/**
 * Encodes tightly packed RGB rows. Each scanline uses the Sub filter, which
 * suits smooth elevation ramps.
 */
export const encodePngRgb = async (
  rgb: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> => {
  if (rgb.length !== width * height * 3)
    throw new Error("RGB buffer size does not match dimensions");
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1;
    for (let i = 0; i < stride; i++) {
      raw[dst + 1 + i] =
        (rgb[src + i] - (i >= 3 ? rgb[src + i - 3] : 0)) & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

/**
 * Encodes tightly packed RGBA rows with straight (not premultiplied) alpha,
 * for overlays such as the cut/fill map: a canvas premultiplies, which
 * shifts the colour of the faint on-grade veil. Sub filter, 4 bytes back.
 */
export const encodePngRgba = async (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  // PNG forbids an empty image; one would only fail later, in the decoder.
  if (
    !(Number.isInteger(width) && Number.isInteger(height)) ||
    width < 1 ||
    height < 1
  )
    throw new RangeError(
      `PNG size must be positive integers, got ${width}×${height}`,
    );
  if (rgba.length !== width * height * 4)
    throw new RangeError("RGBA buffer size does not match dimensions");
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 1;
    for (let i = 0; i < 4; i++) raw[dst + 1 + i] = rgba[src + i];
    for (let i = 4; i < stride; i++)
      raw[dst + 1 + i] = (rgba[src + i] - rgba[src + i - 4]) & 0xff;
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await zlibDeflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
