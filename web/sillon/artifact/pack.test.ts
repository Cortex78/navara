import { describe, expect, it } from "vitest";

import { decodeGrid, encodeGrid } from "./pack";

describe("pack grid encoding", () => {
  it("round-trips heights to the stored step, keeping no-data", () => {
    const width = 4;
    const data = new Float32Array([
      1.234,
      1.24,
      NaN,
      -0.5,
      327.66,
      -327.66,
      0,
      NaN,
    ]);
    const back = decodeGrid(encodeGrid(data, width, 0.01), width, 0.01);
    const isNaN = (a: Float32Array) => Array.from(a, Number.isNaN);
    expect(isNaN(back)).toEqual(isNaN(data));
    const errors = Array.from(data, (v, i) =>
      Number.isNaN(v) ? 0 : Math.abs(back[i] - v),
    );
    expect(Math.max(...errors)).toBeLessThanOrEqual(0.005 + 1e-6);
  });

  it("survives deltas larger than int16 through wraparound", () => {
    const data = new Float32Array([-300, 300, -300, 300]);
    const back = decodeGrid(encodeGrid(data, 4, 0.01), 4, 0.01);
    expect([...back].map((v) => Math.round(v))).toEqual([-300, 300, -300, 300]);
  });
});
