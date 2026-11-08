import { describe, expect, it } from "vitest";

import {
  decodeTerrarium,
  encodeTerrarium,
  TERRARIUM_FILL_HEIGHT,
} from "./terrarium";

const roundTrip = (h: number) => {
  const [r, g, b] = encodeTerrarium(new Float32Array([h]));
  return decodeTerrarium(r, g, b);
};

describe("terrarium", () => {
  it.each([0, 1.3204899, -0.1567, 71.82, 235.62 * 0.3048, 4808.73, -12.5])(
    "round-trips %f m within half a 1/256 m step",
    (h) => {
      expect(Math.abs(roundTrip(h) - h)).toBeLessThanOrEqual(1 / 512 + 1e-6);
    },
  );

  it("keeps centimetre relief on a flat field distinct", () => {
    expect(roundTrip(1.0)).not.toBe(roundTrip(1.01));
  });

  it("writes no-data as the fill height", () => {
    expect(roundTrip(NaN)).toBe(TERRARIUM_FILL_HEIGHT);
  });

  it("matches the Terrarium byte layout", () => {
    expect([...encodeTerrarium(new Float32Array([0]))]).toEqual([128, 0, 0]);
    expect([...encodeTerrarium(new Float32Array([1.5]))]).toEqual([
      128, 1, 128,
    ]);
  });
});
