import { describe, expect, it } from "vitest";

import {
  groundResolution,
  lngLatToMercator,
  lngLatToTile,
  mercatorToLngLat,
  tileBboxMercator,
} from "./webMercator";

describe("web mercator tiles", () => {
  it("finds the tile containing a point", () => {
    expect(lngLatToTile({ lng: 4.553, lat: 43.585 }, 17)).toEqual({
      z: 17,
      x: 67193,
      y: 47869,
    });
    expect(lngLatToTile({ lng: 0, lat: 0 }, 1)).toEqual({ z: 1, x: 1, y: 1 });
  });

  it("bounds tiles so the point's tile contains it", () => {
    const p = { lng: 4.553, lat: 43.585 };
    const b = tileBboxMercator(lngLatToTile(p, 17));
    const m = lngLatToMercator(p);
    expect(m.x).toBeGreaterThanOrEqual(b.minX);
    expect(m.x).toBeLessThan(b.maxX);
    expect(m.y).toBeGreaterThan(b.minY);
    expect(m.y).toBeLessThanOrEqual(b.maxY);
  });

  it("covers the world at z0", () => {
    const b = tileBboxMercator({ z: 0, x: 0, y: 0 });
    expect(b.maxX).toBeCloseTo(20037508.342789244, 6);
    expect(b.minY).toBeCloseTo(-20037508.342789244, 6);
  });

  it("round-trips mercator coordinates", () => {
    const m = lngLatToMercator({ lng: -1.25, lat: 47.3 });
    const g = mercatorToLngLat(m.x, m.y);
    expect(g.lng).toBeCloseTo(-1.25, 10);
    expect(g.lat).toBeCloseTo(47.3, 10);
  });

  it("gives about 0.87 m/px at z17 in the Camargue", () => {
    // 2π·6378137 / (256·2^17) · cos 43.585°
    expect(groundResolution(17, 43.585)).toBeCloseTo(0.8651, 4);
  });
});
