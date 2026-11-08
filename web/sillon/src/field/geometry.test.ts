import { describe, expect, it } from "vitest";

import { lambert93ToLngLat, lngLatToLambert93 } from "../geo/lambert93";

import {
  closedCoords,
  fieldsFromGeoJSON,
  fieldsFromKml,
  lineThroughRing,
  outerRing,
  ringCentroid,
  ringAreaM2,
  ringPerimeterM,
  ringsFromGeoJSON,
  ringsFromKml,
  ringToFeature,
  ringToKml,
  selfIntersects,
  type Ring,
} from "./geometry";

const square = (side: number): Ring =>
  [
    [825000, 6277000],
    [825000 + side, 6277000],
    [825000 + side, 6277000 + side],
    [825000, 6277000 + side],
  ].map(([x, y]) => lambert93ToLngLat({ x, y }));

describe("area and perimeter", () => {
  it("measures a 100 m Lambert-93 square as slightly under 1 ha of ground near 43.6°N", () => {
    const area = ringAreaM2(square(100));
    expect(area).toBeGreaterThan(9980);
    expect(area).toBeLessThan(10000);
    expect(ringPerimeterM(square(100))).toBeGreaterThan(399.5);
    expect(ringPerimeterM(square(100), false)).toBeCloseTo(
      ringPerimeterM(square(100)) * 0.75,
      3,
    );
  });

  it("does not care about winding order", () => {
    expect(ringAreaM2([...square(50)].reverse())).toBeCloseTo(
      ringAreaM2(square(50)),
      6,
    );
  });
});

describe("selfIntersects", () => {
  it("accepts a simple outline and catches a bow tie", () => {
    const s = square(100);
    expect(selfIntersects(s)).toBe(false);
    expect(selfIntersects([s[0], s[2], s[1], s[3]])).toBe(true);
  });
});

describe("GeoJSON and KML", () => {
  it("round-trips through GeoJSON", () => {
    const text = JSON.stringify({
      type: "FeatureCollection",
      features: [ringToFeature(square(100), { name: "A" })],
    });
    const [ring] = ringsFromGeoJSON(text);
    expect(ring).toHaveLength(4);
    expect(ring[2].lng).toBeCloseTo(square(100)[2].lng, 12);
  });

  it("round-trips through KML, escaping the name", () => {
    const kml = ringToKml("Pré <Nord> & co", square(100));
    expect(kml).toContain("Pré &lt;Nord&gt; &amp; co");
    const [ring] = ringsFromKml(kml);
    expect(ring).toHaveLength(4);
    expect(ring[1].lat).toBeCloseTo(square(100)[1].lat, 7);
  });

  it("reads namespaced KML and multipolygon GeoJSON", () => {
    const coords = closedCoords(square(100))
      .map(([x, y]) => `${x},${y}`)
      .join(" ");
    const kml = `<kml:Placemark><kml:Polygon><kml:outerBoundaryIs><kml:LinearRing><kml:coordinates>${coords}</kml:coordinates></kml:LinearRing></kml:outerBoundaryIs></kml:Polygon></kml:Placemark>`;
    expect(ringsFromKml(kml)).toHaveLength(1);
    const multi = {
      type: "MultiPolygon",
      coordinates: [[closedCoords(square(10))], [closedCoords(square(100))]],
    };
    expect(ringsFromGeoJSON(JSON.stringify(multi))).toHaveLength(2);
  });

  it("picks the largest part of a multipolygon field", () => {
    const multi: GeoJSON.MultiPolygon = {
      type: "MultiPolygon",
      coordinates: [[closedCoords(square(10))], [closedCoords(square(100))]],
    };
    expect(ringAreaM2(outerRing(multi) ?? [])).toBeGreaterThan(9000);
  });
});

describe("named fields and Lambert-93 input", () => {
  it("names GeoJSON fields and reads EPSG:2154 coordinates", () => {
    const l93 = [
      [825000, 6277000],
      [825100, 6277000],
      [825100, 6277100],
      [825000, 6277100],
      [825000, 6277000],
    ];
    const text = JSON.stringify({
      type: "FeatureCollection",
      crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::2154" } },
      features: [
        {
          type: "Feature",
          properties: { nom: "Grand Clos" },
          geometry: { type: "Polygon", coordinates: [l93] },
        },
      ],
    });
    const [f] = fieldsFromGeoJSON(text);
    expect(f.name).toBe("Grand Clos");
    expect(f.ring[0].lng).toBeCloseTo(square(100)[0].lng, 9);
  });

  it("names KML fields after their Placemark", () => {
    const kml = ringToKml("Les Saladelles & co", square(100));
    expect(fieldsFromKml(kml)[0].name).toBe("Les Saladelles & co");
  });
});

describe("centroid and fall line", () => {
  it("finds the centre of a square and the chord through it", () => {
    const s = square(100);
    const c = lngLatToLambert93(ringCentroid(s));
    expect(c.x).toBeCloseTo(825050, 3);
    expect(c.y).toBeCloseTo(6277050, 3);
    // Bearing 90° (east): the chord crosses the square west to east.
    const chord = lineThroughRing(s, ringCentroid(s), 90);
    if (!chord) throw new Error("no chord");
    const [a, b] = chord.map(lngLatToLambert93);
    expect(a.x).toBeCloseTo(825000, 3);
    expect(b.x).toBeCloseTo(825100, 3);
    expect(a.y).toBeCloseTo(6277050, 3);
  });
});
