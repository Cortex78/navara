import { describe, expect, it } from "vitest";

import {
  lambert93ScaleFactor,
  lambert93ToLngLat,
  lngLatToLambert93,
} from "./lambert93";

// [lng, lat, x, y] computed with PROJ (pyproj, EPSG:4326 -> EPSG:2154).
const PROJ_REFERENCE: [number, number, number, number][] = [
  [3, 46.5, 700000.0, 6600000.0],
  [4.553, 43.585, 825459.1475, 6277449.4733],
  [2.3522, 48.8566, 652469.0227, 6862035.2594],
  [-4.4861, 48.3904, 146632.9785, 6836262.3267],
  [7.7521, 48.5734, 1050362.6954, 6840899.6472],
  [9.45, 42.7, 1228546.0453, 6199420.644],
  [-1.5536, 43.4832, 331665.3274, 6275524.5815],
];

describe("Lambert-93", () => {
  it.each(PROJ_REFERENCE)(
    "projects (%f, %f) like PROJ to the millimetre",
    (lng, lat, x, y) => {
      const p = lngLatToLambert93({ lng, lat });
      expect(p.x).toBeCloseTo(x, 3);
      expect(p.y).toBeCloseTo(y, 3);
    },
  );

  it.each(PROJ_REFERENCE)(
    "inverts (%f, %f) to under 1e-9 degrees",
    (lng, lat, x, y) => {
      const g = lambert93ToLngLat({ x, y });
      expect(g.lng).toBeCloseTo(lng, 8);
      expect(g.lat).toBeCloseTo(lat, 8);
    },
  );

  it("agrees with the coordinates the IGN geocoder returns", () => {
    // Saintes-Maries-de-la-Mer, as served by data.geopf.fr/geocodage (cm precision).
    const p = lngLatToLambert93({ lng: 4.403425, lat: 43.489586 });
    expect(Math.abs(p.x - 813565.54)).toBeLessThan(0.05);
    expect(Math.abs(p.y - 6266620.14)).toBeLessThan(0.05);
  });

  it("has unit scale on the standard parallels and shrinks between them", () => {
    expect(lambert93ScaleFactor(44)).toBeCloseTo(1, 12);
    expect(lambert93ScaleFactor(49)).toBeCloseTo(1, 12);
    expect(lambert93ScaleFactor(46.5)).toBeLessThan(1);
    expect(lambert93ScaleFactor(46.5)).toBeGreaterThan(0.999);
    expect(lambert93ScaleFactor(42)).toBeGreaterThan(1);
  });
});
