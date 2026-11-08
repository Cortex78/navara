import type { CutFillRamp } from "../../src/dem/cutFillRaster";

/*
 * GAïa colours the map draws with. CSS tokens style the page; MapLibre
 * paints and the canvas grading need literal colours, so they live here,
 * one name per role. The laws behind them (GAïa doctrine):
 * - signal blue is emitted light: what is switched on (the selected field,
 *   the active design), never a large fill;
 * - ember is a density reading only, at the top band of an intensity;
 * - imagery maps between bone and ultramarine (the duotone law).
 */

export const MAP = {
  /** Indigo-black: the map's ground where no tile reaches. */
  ground: "#06061a",
  /** Bone: RPG outlines, existing contours, the natural fall arrow. */
  bone: "#ece8dc",
  /** Ultramarine, the brand primary. */
  ultramarine: "#1e1ea8",
  /** Signal blue: the selected field and its brackets. */
  signal: "#3c62ff",
  /** Light signal: the design surface (contours, fall arrow), the pack edge. */
  signalLight: "#7c9aff",
  /** Ember: the deep end of the cut ramp and of the relief ramp. */
  ember: "#ff6b26",
  /** Fill cyan: soil brought in (GAïa's cool data family). */
  fillCyan: "#59d8ff",
  /** Phosphor: spectral tools — the elevation profile. */
  phosphor: "#3ce0a0",
  /** Dark casing under bright lines over imagery. */
  casing: "#06061a",
};

/**
 * Cut warm (soil to remove: dim ember to pale ember as it deepens), fill
 * cool (soil to bring: deep cyan to ice), on grade nearly clear. Blue
 * against orange stays apart for red-green colour-blind readers.
 */
export const CUT_FILL_RAMP: CutFillRamp = {
  cut: [
    [148, 56, 26],
    [255, 107, 38],
    [255, 154, 102],
    [255, 214, 190],
  ],
  fill: [
    [28, 90, 122],
    [47, 160, 214],
    [89, 216, 255],
    [200, 242, 255],
  ],
  grade: [236, 232, 220, 26],
};

/**
 * Elevation ramp, low to high: indigo, ultramarine, signal, light signal,
 * bone, then ember for the top band. RGB in 0..1, as RELIEF_STOPS.
 */
export const GAIA_RELIEF: [number, number, number][] = [
  [0.043, 0.043, 0.18],
  [0.118, 0.118, 0.659],
  [0.235, 0.384, 1],
  [0.486, 0.604, 1],
  [0.788, 0.827, 0.961],
  [0.925, 0.91, 0.863],
  [0.969, 0.725, 0.576],
  [1, 0.42, 0.149],
];

const css = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

export const gaiaReliefCss = (rgb: [number, number, number], alpha = 1) =>
  `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;

export const gaiaReliefGradient = () =>
  `linear-gradient(90deg, ${GAIA_RELIEF.map(
    (c, i) => `${css(c)} ${((i / (GAIA_RELIEF.length - 1)) * 100).toFixed(1)}%`,
  ).join(", ")})`;

const DUO = {
  black: [6, 6, 26],
  ultramarine: [30, 30, 168],
  bone: [236, 232, 220],
} as const;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 256-entry lookup of the GAïa duotone grade (indexed by luma 0..255). */
const DUOTONE_LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const l = i / 255;
    const t1 = smoothstep(0.02, 0.45, l);
    const t2 = smoothstep(0.35, 0.92, l);
    for (let c = 0; c < 3; c++) {
      const mid = DUO.black[c] + (DUO.ultramarine[c] - DUO.black[c]) * t1;
      lut[i * 3 + c] = Math.round(mid + (DUO.bone[c] - mid) * t2);
    }
  }
  return lut;
})();

/** The duotone colour of a luma 0..255, into `out` at `at` (RGB). */
export const duotoneInto = (
  luma: number,
  out: Uint8Array | Uint8ClampedArray,
  at: number,
) => {
  const k = Math.max(0, Math.min(255, Math.round(luma))) * 3;
  out[at] = DUOTONE_LUT[k];
  out[at + 1] = DUOTONE_LUT[k + 1];
  out[at + 2] = DUOTONE_LUT[k + 2];
};

/**
 * Grades an image tile to the GAïa duotone: BT.709 luma mapped through
 * indigo-black → ultramarine → bone (the brand's asset grading function).
 * JPEG for photographs; PNG keeps the tile's transparency (IGN's shaded
 * relief is clear where it has no data).
 */
export const duotoneTile = async (
  bytes: ArrayBuffer,
  type: "image/jpeg" | "image/png" = "image/jpeg",
): Promise<ArrayBuffer> => {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return bytes;
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    const k = Math.min(255, l) * 3;
    d[i] = DUOTONE_LUT[k];
    d[i + 1] = DUOTONE_LUT[k + 1];
    d[i + 2] = DUOTONE_LUT[k + 2];
  }
  ctx.putImageData(img, 0, 0);
  const blob = await canvas.convertToBlob(
    type === "image/jpeg" ? { type, quality: 0.88 } : { type },
  );
  return blob.arrayBuffer();
};
