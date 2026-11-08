import type { ElevationGrid } from "../src/dem/elevationGrid";
import type { LidarTileMetadata, LngLatBounds } from "../src/ign/lidarMetadata";

/**
 * Offline field pack: what bake.ts writes and the artifact page reads.
 *
 * Artifacts serve only standard web file types, so binary parts (grids,
 * tile bundles) are stored as base64 in .txt files.
 *
 * Grids are stored as int16 heights in units of `scale` metres, delta-coded
 * along each row and zlib-deflated. -32768 is no-data. Deltas wrap modulo
 * 2^16, so decoding is exact whatever the jumps.
 */
export type PackGrid = Omit<ElevationGrid, "data"> & {
  file: string;
  scale: number;
};

export type PackTileLayer = {
  format: "jpeg" | "png";
  minZoom: number;
  maxZoom: number;
  bundles: string[];
  /** "z/x/y" → [bundle index, byte offset, byte length] */
  tiles: Record<string, [number, number, number]>;
};

export type PackManifest = {
  name: string;
  place: string;
  bakedAt: string;
  core: LngLatBounds;
  context: LngLatBounds;
  centre: { lng: number; lat: number };
  grids: { fine: PackGrid; context: PackGrid };
  lidarTiles: LidarTileMetadata[];
  rpg: string;
  layers: Record<"ortho" | "irc" | "shade", PackTileLayer>;
};

const NODATA = -32768;

/** Text-file size cap on artifacts is 16 MB; 9 MB of bytes is 12 MB of base64. */
export const BUNDLE_BYTES = 9 * 1024 * 1024;

export const fromBase64 = (text: string): Uint8Array => {
  const native = (
    Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
  ).fromBase64;
  if (native) return native(text.trim());
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const encodeGrid = (
  data: Float32Array,
  width: number,
  scale: number,
): Uint8Array => {
  const out = new Int16Array(data.length);
  let prev = 0;
  for (let i = 0; i < data.length; i++) {
    if (i % width === 0) prev = 0;
    const v = data[i];
    const q = Number.isNaN(v)
      ? NODATA
      : Math.max(-32767, Math.min(32767, Math.round(v / scale)));
    out[i] = ((q - prev) << 16) >> 16;
    prev = q;
  }
  return new Uint8Array(out.buffer);
};

export const decodeGrid = (
  bytes: Uint8Array,
  width: number,
  scale: number,
): Float32Array => {
  const deltas = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / 2,
  );
  const out = new Float32Array(deltas.length);
  let prev = 0;
  for (let i = 0; i < deltas.length; i++) {
    if (i % width === 0) prev = 0;
    const q = ((prev + deltas[i]) << 16) >> 16;
    out[i] = q === NODATA ? NaN : q * scale;
    prev = q;
  }
  return out;
};
