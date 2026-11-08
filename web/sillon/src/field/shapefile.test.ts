import { describe, expect, it } from "vitest";

import { lambert93ToLngLat, lngLatToLambert93 } from "../geo/lambert93";

import { ringAreaM2, type Ring } from "./geometry";
import { readPolygonShapefile, writePolygonShapefile } from "./shapefile";

const square = (x0: number, y0: number, side: number): Ring =>
  [
    [x0, y0],
    [x0 + side, y0],
    [x0 + side, y0 + side],
    [x0, y0 + side],
  ].map(([x, y]) => lambert93ToLngLat({ x, y }));

const FIELDS = [
  { name: "NAME", type: "C" as const, length: 20 },
  { name: "AREA_HA", type: "N" as const, length: 10, decimals: 3 },
];

describe("polygon shapefile", () => {
  it("writes and reads back fields with their names", () => {
    const a = square(825000, 6277000, 100);
    const b = square(826000, 6277000, 50);
    const parts = writePolygonShapefile(FIELDS, [
      { ring: a, values: ["Pré de l'Étang, très long nom", 1] },
      { ring: b, values: ["Sud", 0.25] },
    ]);
    // Record header + polygon content of 5 points each.
    expect(parts.shp.length).toBe(100 + 2 * (8 + 48 + 5 * 16));
    expect(parts.shx.length).toBe(116);
    const back = readPolygonShapefile(parts.shp, parts.dbf, parts.prj);
    expect(back).toHaveLength(2);
    // Names are cut on a character boundary to the column's 20 bytes.
    expect(back[0].name).toBe("Pré de l'Étang, tr");
    expect(back[1].name).toBe("Sud");
    expect(ringAreaM2(back[0].ring)).toBeCloseTo(ringAreaM2(a), 3);
  });

  it("writes outer rings clockwise", () => {
    const parts = writePolygonShapefile(FIELDS, [
      { ring: square(825000, 6277000, 100), values: ["A", 1] },
    ]);
    const v = new DataView(parts.shp.buffer);
    const pt = (k: number) => ({
      lng: v.getFloat64(100 + 8 + 48 + k * 16, true),
      lat: v.getFloat64(100 + 8 + 56 + k * 16, true),
    });
    let twice = 0;
    for (let k = 0; k < 4; k++)
      twice += (pt(k + 1).lng - pt(k).lng) * (pt(k + 1).lat + pt(k).lat);
    expect(twice).toBeGreaterThan(0);
  });

  it("reads Lambert-93 shapefiles, as TELEPAC exports them", () => {
    const ring = square(825000, 6277000, 100);
    const l93 = ring.map((p) => {
      const { x, y } = lngLatToLambert93(p);
      return { lng: x, lat: y };
    });
    const parts = writePolygonShapefile(FIELDS, [
      { ring: l93, values: ["L93", 1] },
    ]);
    const prj =
      'PROJCS["RGF93_Lambert_93",GEOGCS["GCS_RGF_1993"],PROJECTION["Lambert_Conformal_Conic"]]';
    const [back] = readPolygonShapefile(parts.shp, parts.dbf, prj);
    // Written clockwise, so the corners come back in the other order.
    for (const p of ring) {
      const near = back.ring.some(
        (q) => Math.abs(q.lng - p.lng) < 1e-9 && Math.abs(q.lat - p.lat) < 1e-9,
      );
      expect(near).toBe(true);
    }
  });

  it("refuses an unknown projection", () => {
    const utm = [
      { lng: 640000, lat: 4830000 },
      { lng: 640100, lat: 4830000 },
      { lng: 640100, lat: 4830100 },
    ];
    const parts = writePolygonShapefile(FIELDS, [
      { ring: utm, values: ["UTM", 1] },
    ]);
    expect(() =>
      readPolygonShapefile(
        parts.shp,
        parts.dbf,
        'PROJCS["WGS_1984_UTM_Zone_31N"]',
      ),
    ).toThrow(/projection/);
  });
});
