/**
 * Hillshade of a height raster by Horn's method (the formula GDAL and ArcGIS
 * use). `heights` is (width + 2) × (height + 2), row 0 north: a one-cell
 * border around the output so edge cells have neighbours. NaN heights are
 * treated as level with the centre cell. Returns 0..1 brightness per cell.
 */
export const hillshade = (
  heights: Float32Array,
  width: number,
  height: number,
  /** Ground metres per cell, east-west and north-south alike. */
  cellSize: number,
  {
    azimuth = 315,
    altitude = 45,
    /** Vertical exaggeration: a flat delta needs 3–6× to read at all. */
    zFactor = 1,
  }: { azimuth?: number; altitude?: number; zFactor?: number } = {},
): Float32Array => {
  const stride = width + 2;
  const zenith = ((90 - altitude) * Math.PI) / 180;
  const az = ((((360 - azimuth + 90) % 360) + 360) % 360) * (Math.PI / 180);
  const cosZ = Math.cos(zenith);
  const sinZ = Math.sin(zenith);
  const out = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const k = (row + 1) * stride + col + 1;
      const e = heights[k];
      const at = (d: number) =>
        Number.isNaN(heights[k + d]) ? e : heights[k + d];
      const [a, b, c] = [at(-stride - 1), at(-stride), at(-stride + 1)];
      const [d, f] = [at(-1), at(1)];
      const [g, h, i] = [at(stride - 1), at(stride), at(stride + 1)];
      const dzdx =
        (zFactor * (c + 2 * f + i - (a + 2 * d + g))) / (8 * cellSize);
      const dzdy =
        (zFactor * (g + 2 * h + i - (a + 2 * b + c))) / (8 * cellSize);
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      let aspect = 0;
      if (dzdx !== 0) {
        aspect = Math.atan2(dzdy, -dzdx);
        if (aspect < 0) aspect += 2 * Math.PI;
      } else if (dzdy > 0) aspect = Math.PI / 2;
      else if (dzdy < 0) aspect = 1.5 * Math.PI;
      const v =
        cosZ * Math.cos(slope) + sinZ * Math.sin(slope) * Math.cos(az - aspect);
      out[row * width + col] = Number.isNaN(e) ? NaN : Math.max(0, v);
    }
  }
  return out;
};
