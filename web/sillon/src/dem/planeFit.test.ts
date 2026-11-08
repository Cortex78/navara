import { describe, expect, it } from "vitest";

import { compassPoint, fitPlane, planeHeight } from "./planeFit";

const grid = (f: (x: number, y: number) => number) => {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const x = 825000 + i * 5;
      const y = 6277000 + j * 5;
      xs.push(x);
      ys.push(y);
      zs.push(f(x, y));
    }
  }
  return { xs, ys, zs };
};

describe("fitPlane", () => {
  it("recovers an exact plane at Lambert-93 magnitudes", () => {
    // Falls 0.1 % toward the east and 0.2 % toward the north.
    const { xs, ys, zs } = grid(
      (x, y) => 10 - 0.001 * (x - 825000) - 0.002 * (y - 6277000),
    );
    const p = fitPlane(xs, ys, zs);
    expect(p).not.toBeNull();
    if (!p) return;
    expect(p.dzdx).toBeCloseTo(-0.001, 9);
    expect(p.dzdy).toBeCloseTo(-0.002, 9);
    expect(p.slopePct).toBeCloseTo(Math.hypot(0.1, 0.2), 6);
    // Downhill points east-north-east: atan2(0.001, 0.002) ≈ 26.6°.
    expect(p.fallDeg).toBeCloseTo(26.565, 2);
    expect(p.rms).toBeCloseTo(0, 9);
    expect(planeHeight(p, 825000, 6277000)).toBeCloseTo(10, 9);
  });

  it("measures how far bumps sit from the plane", () => {
    const { xs, ys, zs } = grid(
      (x, y) => 5 + ((x / 5 + y / 5) % 2 === 0 ? 0.1 : -0.1),
    );
    const p = fitPlane(xs, ys, zs);
    expect(p?.slopePct).toBeLessThan(0.01);
    expect(p?.rms).toBeCloseTo(0.1, 3);
  });

  it("names a plane falling south", () => {
    const { xs, ys, zs } = grid((_, y) => (y - 6277000) * 0.005);
    expect(fitPlane(xs, ys, zs)?.fallDeg).toBeCloseTo(180, 6);
  });

  it("refuses collinear points", () => {
    expect(fitPlane([0, 1, 2, 3], [0, 1, 2, 3], [1, 2, 3, 4])).toBeNull();
  });
});

describe("compassPoint", () => {
  it.each([
    [0, "N"],
    [44, "NE"],
    [180, "S"],
    [292, "W"],
    [338, "N"],
    [-90, "W"],
  ])("%f° → %s", (deg, name) => expect(compassPoint(deg)).toBe(name));
});
