/**
 * Terrarium RGB elevation encoding: `h = R·256 + G + B/256 − 32768`, the
 * format Navara decodes with `TERRARIUM_ELEVATION_DECODER`. It resolves
 * 1/256 m (≈ 4 mm), far finer than LiDAR HD's vertical accuracy, whereas
 * Mapbox terrain-RGB's 0.1 m step would show as terraces on a flat field.
 */

const OFFSET = 32768;
const MAX_Q = 2 ** 24 - 1;

/** Height NaN (no-data) is written as this, since Terrarium has no no-data code. */
export const TERRARIUM_FILL_HEIGHT = 0;

export const encodeTerrarium = (
  heights: Float32Array,
  out = new Uint8Array(heights.length * 3),
) => {
  for (let i = 0; i < heights.length; i++) {
    const h = Number.isNaN(heights[i]) ? TERRARIUM_FILL_HEIGHT : heights[i];
    const q = Math.min(MAX_Q, Math.max(0, Math.round((h + OFFSET) * 256)));
    out[i * 3] = q >>> 16;
    out[i * 3 + 1] = (q >>> 8) & 0xff;
    out[i * 3 + 2] = q & 0xff;
  }
  return out;
};

export const decodeTerrarium = (r: number, g: number, b: number) =>
  r * 256 + g + b / 256 - OFFSET;
