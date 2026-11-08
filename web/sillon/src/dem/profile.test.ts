import { describe, expect, it } from "vitest";

import { lambert93ToLngLat, lngLatToLambert93 } from "../geo/lambert93";

import { profileCsv, profileStats, sampleProfile } from "./profile";

const at = (x: number, y: number) => lambert93ToLngLat({ x, y });

describe("sampleProfile", () => {
  it("steps evenly in ground metres through the vertices and ends on the last point", () => {
    // An L of 100 m east then 50 m north (map metres).
    const pts = [at(825000, 6277000), at(825100, 6277000), at(825100, 6277050)];
    const s = sampleProfile(pts, 10, ({ x }) => x - 825000);
    const last = s[s.length - 1];
    expect(last.d).toBeGreaterThan(149.8);
    expect(last.d).toBeLessThan(150);
    for (let i = 1; i < s.length - 1; i++)
      expect(s[i].d - s[i - 1].d).toBeCloseTo(10, 6);
    const end = lngLatToLambert93(last);
    expect(end.x).toBeCloseTo(825100, 3);
    expect(end.y).toBeCloseTo(6277050, 3);
  });
});

describe("profileStats", () => {
  it("reports fall, grade and the steepest stretch", () => {
    const samples = Array.from({ length: 101 }, (_, i) => ({
      d: i,
      // 1 m down over 100 m, with a 0.2 m bump between 40 and 50 m.
      h: 10 - i / 100 + (i >= 40 && i <= 50 ? ((i - 40) / 10) * 0.2 : 0),
      lng: 0,
      lat: 0,
    }));
    const st = profileStats(samples, 10);
    expect(st?.fall).toBeCloseTo(1, 6);
    expect(st?.gradePct).toBeCloseTo(1, 6);
    expect(st?.maxRisePct).toBeCloseTo(1, 1);
    expect(st?.maxDropPct).toBeGreaterThan(1);
  });

  it("ignores missing heights", () => {
    const st = profileStats([
      { d: 0, h: NaN, lng: 0, lat: 0 },
      { d: 5, h: 2, lng: 0, lat: 0 },
      { d: 10, h: 1, lng: 0, lat: 0 },
    ]);
    expect(st?.start).toBe(2);
    expect(st?.gradePct).toBeCloseTo(20, 6);
  });
});

describe("profileCsv", () => {
  it("leaves missing heights blank", () => {
    expect(
      profileCsv([{ d: 0, h: NaN, lng: 4.5, lat: 43.5 }]).split("\n")[1],
    ).toBe("0.00,,4.5000000,43.5000000");
  });
});
