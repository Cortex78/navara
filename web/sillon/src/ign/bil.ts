import { NODATA_THRESHOLD } from "./geoplateforme";

const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Decodes an `image/x-bil;bits=32` GetMap body: row-major little-endian
 * float32, first row north. No-data values become NaN, so every consumer can
 * test validity with `Number.isNaN` instead of knowing the service's sentinel.
 */
export const decodeBil32 = (
  buffer: ArrayBuffer,
  width: number,
  height: number,
): Float32Array => {
  const count = width * height;
  if (buffer.byteLength !== count * 4) {
    throw new Error(
      `BIL body is ${buffer.byteLength} bytes, expected ${count * 4} (${width}x${height})`,
    );
  }
  let out: Float32Array;
  if (LITTLE_ENDIAN_HOST) {
    out = new Float32Array(buffer.slice(0));
  } else {
    const view = new DataView(buffer);
    out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  }
  for (let i = 0; i < count; i++) {
    if (!(out[i] > NODATA_THRESHOLD)) out[i] = NaN;
  }
  return out;
};
