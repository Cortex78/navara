import { describe, expect, it } from "vitest";

import { hillshade } from "./hillshade";

/** (w + 2) × (h + 2) heights from a function of (col, row) in border coordinates. */
const raster = (w: number, h: number, f: (c: number, r: number) => number) =>
  Float32Array.from({ length: (w + 2) * (h + 2) }, (_, k) =>
    f(k % (w + 2), Math.floor(k / (w + 2))),
  );

describe("hillshade", () => {
  it("lights flat ground by the sun's altitude", () => {
    const out = hillshade(
      raster(3, 3, () => 5),
      3,
      3,
      1,
      { altitude: 45 },
    );
    for (const v of out) expect(v).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });

  it("brightens slopes facing a north-west sun and darkens the others", () => {
    // Ground rising to the east faces west; rising to the west faces east.
    const facingWest = hillshade(
      raster(3, 3, (c) => c * 0.5),
      3,
      3,
      1,
    )[4];
    const facingEast = hillshade(
      raster(3, 3, (c) => -c * 0.5),
      3,
      3,
      1,
    )[4];
    const flat = Math.cos(Math.PI / 4);
    expect(facingWest).toBeGreaterThan(flat);
    expect(facingEast).toBeLessThan(flat);
  });

  it("exaggerates subtle relief with zFactor", () => {
    const gentle = raster(3, 3, (c) => -c * 0.02);
    const plain = hillshade(gentle, 3, 3, 1)[4];
    const stretched = hillshade(gentle, 3, 3, 1, { zFactor: 5 })[4];
    const flat = Math.cos(Math.PI / 4);
    expect(flat - stretched).toBeGreaterThan(4 * (flat - plain));
  });

  it("keeps no-data cells as NaN and ignores no-data neighbours", () => {
    const heights = raster(3, 3, () => 1);
    heights[0] = NaN;
    heights[2 * 5 + 2] = NaN; // centre of the output
    const out = hillshade(heights, 3, 3, 1);
    expect(out[4]).toBeNaN();
    expect(out[0]).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });
});
