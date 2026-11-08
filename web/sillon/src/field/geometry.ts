import {
  lambert93ScaleFactor,
  lambert93ToLngLat,
  lngLatToLambert93,
  type LngLat,
} from "../geo/lambert93";

/**
 * A field outline: corners in order, not repeating the first at the end
 * (GeoJSON closes rings by repeating it; this module adds and strips that).
 */
export type Ring = LngLat[];

export const HA_PER_ACRE = 0.40468564224;

/** A field outline and the name its file gave it, if any. */
export type NamedRing = { ring: Ring; name: string | null };

/** Mainland France and Corsica in Lambert-93 metres, with a margin. */
const looksLambert93 = (x: number, y: number) =>
  x > 50_000 && x < 1_300_000 && y > 6_000_000 && y < 7_200_000;

/**
 * Coordinates from a file to lng/lat: unchanged when they are degrees,
 * from Lambert-93 when `crs` (a `.prj` or a GeoJSON `crs` name) says so or
 * the numbers fit France in it — French farm data (TELEPAC, Mes Parcelles)
 * often comes that way. Throws for any other projection.
 */
export const toLngLat = (
  points: { x: number; y: number }[],
  crs = "",
): LngLat[] => {
  if (points.every((p) => Math.abs(p.x) <= 180 && Math.abs(p.y) <= 90))
    return points.map((p) => ({ lng: p.x, lat: p.y }));
  const l93 = /2154/.test(crs) || (/lambert/i.test(crs) && /93/.test(crs));
  if (l93 || points.every((p) => looksLambert93(p.x, p.y)))
    return points.map(lambert93ToLngLat);
  throw new Error(
    "These coordinates are in a projection Sillon does not read; export them in WGS84 (EPSG:4326) or Lambert-93 (EPSG:2154).",
  );
};

/** Drops the closing duplicate a GeoJSON or KML ring carries. */
export const openRing = (coords: number[][], crs = ""): Ring => {
  const ring = toLngLat(
    coords.map(([x, y]) => ({ x, y })),
    crs,
  );
  const a = ring[0];
  const b = ring[ring.length - 1];
  if (ring.length > 1 && a.lng === b.lng && a.lat === b.lat) ring.pop();
  return ring;
};

export const closedCoords = (ring: Ring): [number, number][] =>
  ring.length ? [...ring, ring[0]].map((p) => [p.lng, p.lat]) : [];

const meanLat = (ring: Ring) =>
  ring.reduce((s, p) => s + p.lat, 0) / ring.length;

/** Ground area in m² (Lambert-93 shoelace, corrected for the projection's scale). */
export const ringAreaM2 = (ring: Ring) => {
  if (ring.length < 3) return 0;
  const xy = ring.map(lngLatToLambert93);
  let twice = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    twice +=
      (xy[j].x - xy[0].x) * (xy[i].y - xy[0].y) -
      (xy[i].x - xy[0].x) * (xy[j].y - xy[0].y);
  }
  return Math.abs(twice) / 2 / lambert93ScaleFactor(meanLat(ring)) ** 2;
};

/** Ground length in m of the closed outline, or of an open line with `closed = false`. */
export const ringPerimeterM = (ring: Ring, closed = true) => {
  if (ring.length < 2) return 0;
  const xy = ring.map(lngLatToLambert93);
  let len = 0;
  for (let i = 1; i < xy.length; i++)
    len += Math.hypot(xy[i].x - xy[i - 1].x, xy[i].y - xy[i - 1].y);
  if (closed)
    len += Math.hypot(
      xy[0].x - xy[xy.length - 1].x,
      xy[0].y - xy[xy.length - 1].y,
    );
  return len / lambert93ScaleFactor(meanLat(ring));
};

const cross = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** True when two non-adjacent edges of the closed outline cross. */
export const selfIntersects = (ring: Ring) => {
  const p = ring.map(lngLatToLambert93);
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[i];
    const b = p[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      const c = p[j];
      const d = p[(j + 1) % n];
      const d1 = cross(a.x, a.y, b.x, b.y, c.x, c.y);
      const d2 = cross(a.x, a.y, b.x, b.y, d.x, d.y);
      const d3 = cross(c.x, c.y, d.x, d.y, a.x, a.y);
      const d4 = cross(c.x, c.y, d.x, d.y, b.x, b.y);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
};

/** The largest outer ring of a Polygon or MultiPolygon geometry (an RPG field). */
export const outerRing = (geometry: GeoJSON.Geometry): Ring | null => {
  const outers =
    geometry.type === "Polygon"
      ? [geometry.coordinates[0]]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates.map((poly) => poly[0])
        : [];
  let best: Ring | null = null;
  let bestArea = -1;
  for (const coords of outers) {
    const ring = openRing(coords);
    const area = ringAreaM2(ring);
    if (area > bestArea) [best, bestArea] = [ring, area];
  }
  return best;
};

export const ringToFeature = (
  ring: Ring,
  properties: Record<string, unknown> = {},
): GeoJSON.Feature<GeoJSON.Polygon> => ({
  type: "Feature",
  properties,
  geometry: { type: "Polygon", coordinates: [closedCoords(ring)] },
});

const NAME_KEYS = ["name", "nom", "Name", "NOM", "label", "libelle", "id"];

/**
 * Outer rings of every polygon in a GeoJSON text (geometry, feature or
 * collection), named from a feature's `name`-like property.
 */
export const fieldsFromGeoJSON = (text: string): NamedRing[] => {
  const root = JSON.parse(text) as GeoJSON.GeoJSON & {
    crs?: { properties?: { name?: string } };
  };
  const crs = root.crs?.properties?.name ?? "";
  const features: { geometry: GeoJSON.Geometry; props: unknown }[] =
    root.type === "FeatureCollection"
      ? root.features
          .filter((f) => f.geometry)
          .map((f) => ({ geometry: f.geometry, props: f.properties }))
      : root.type === "Feature"
        ? [{ geometry: root.geometry, props: root.properties }]
        : [{ geometry: root as GeoJSON.Geometry, props: null }];
  const out: NamedRing[] = [];
  for (const { geometry: g, props } of features) {
    const p = (props ?? {}) as Record<string, unknown>;
    const key = NAME_KEYS.find(
      (k) => typeof p[k] === "string" || typeof p[k] === "number",
    );
    const name = key ? String(p[key]) : null;
    const outers =
      g.type === "Polygon"
        ? [g.coordinates[0]]
        : g.type === "MultiPolygon"
          ? g.coordinates.map((poly) => poly[0])
          : [];
    for (const coords of outers) {
      const ring = openRing(coords, crs);
      if (ring.length >= 3) out.push({ ring, name });
    }
  }
  return out;
};

/** Outer rings of every polygon in a GeoJSON text (geometry, feature or collection). */
export const ringsFromGeoJSON = (text: string): Ring[] =>
  fieldsFromGeoJSON(text).map((f) => f.ring);

const xmlEscape = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[c] as string,
  );

export const ringToKml = (name: string, ring: Ring) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>${xmlEscape(name)}</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>${closedCoords(ring)
            .map(([lng, lat]) => `${lng.toFixed(8)},${lat.toFixed(8)},0`)
            .join(" ")}</coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
</kml>
`;

const kmlText = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

const kmlRings = (text: string): Ring[] => {
  const rings: Ring[] = [];
  for (const poly of text.matchAll(
    /<(?:\w+:)?Polygon[\s>][\s\S]*?<\/(?:\w+:)?Polygon>/g,
  )) {
    const outer =
      /<(?:\w+:)?outerBoundaryIs>[\s\S]*?<(?:\w+:)?coordinates>([\s\S]*?)<\/(?:\w+:)?coordinates>/.exec(
        poly[0],
      );
    if (!outer) continue;
    const coords = outer[1]
      .trim()
      .split(/\s+/)
      .map((t) => t.split(",").map(Number))
      .filter((c) => c.length >= 2 && c.every((v) => Number.isFinite(v)));
    const ring = openRing(coords);
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
};

/**
 * Outer rings of every KML Polygon (Google Earth, farm software exports),
 * named after their Placemark.
 */
export const fieldsFromKml = (text: string): NamedRing[] => {
  const placemarks = [
    ...text.matchAll(/<(?:\w+:)?Placemark[\s>][\s\S]*?<\/(?:\w+:)?Placemark>/g),
  ];
  if (placemarks.length === 0)
    return kmlRings(text).map((ring) => ({ ring, name: null }));
  return placemarks.flatMap(([pm]) => {
    const n = /<(?:\w+:)?name>([\s\S]*?)<\/(?:\w+:)?name>/.exec(pm);
    const name = n ? kmlText(n[1]) || null : null;
    return kmlRings(pm).map((ring) => ({ ring, name }));
  });
};

/** Outer rings of every KML Polygon (Google Earth, farm software exports). */
export const ringsFromKml = (text: string): Ring[] =>
  fieldsFromKml(text).map((f) => f.ring);

/** Area-weighted centre of the outline (Lambert-93 centroid). */
export const ringCentroid = (ring: Ring): LngLat => {
  const p = ring.map(lngLatToLambert93);
  const o = p[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i].x - o.x;
    const yi = p[i].y - o.y;
    const xj = p[j].x - o.x;
    const yj = p[j].y - o.y;
    const f = xj * yi - xi * yj;
    a += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  if (Math.abs(a) < 1e-9) {
    const n = p.length;
    return lambert93ToLngLat({
      x: p.reduce((s, q) => s + q.x, 0) / n,
      y: p.reduce((s, q) => s + q.y, 0) / n,
    });
  }
  return lambert93ToLngLat({ x: o.x + cx / (3 * a), y: o.y + cy / (3 * a) });
};

/**
 * The chord of the outline through `through` along a compass bearing
 * (degrees clockwise from north): from where that straight line first
 * enters the field to where it last leaves it. Null if it misses.
 */
export const lineThroughRing = (
  ring: Ring,
  through: LngLat,
  bearingDeg: number,
): [LngLat, LngLat] | null => {
  const p = ring.map(lngLatToLambert93);
  const o = lngLatToLambert93(through);
  const rad = (bearingDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = Math.cos(rad);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ex = p[i].x - p[j].x;
    const ey = p[i].y - p[j].y;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const wx = p[j].x - o.x;
    const wy = p[j].y - o.y;
    // o + t·d = p[j] + s·e, solved for t (along the line) and s (along the edge).
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * dy - wy * dx) / den;
    if (s < 0 || s > 1) continue;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
  }
  if (!(hi > lo)) return null;
  return [
    lambert93ToLngLat({ x: o.x + lo * dx, y: o.y + lo * dy }),
    lambert93ToLngLat({ x: o.x + hi * dx, y: o.y + hi * dy }),
  ];
};
