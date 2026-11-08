import { compassPoint } from "../../src/dem/planeFit";
import {
  closedCoords,
  fieldsFromGeoJSON,
  fieldsFromKml,
  type NamedRing,
  type Ring,
} from "../../src/field/geometry";
import {
  readPolygonShapefile,
  writePolygonShapefile,
} from "../../src/field/shapefile";
import { unzip, zipStore } from "../../src/field/zip";

/** What an exported field carries besides its outline. */
export type ExportField = {
  name: string;
  ring: Ring;
  areaHa: number;
  crop?: string | null;
  slopePct?: number | null;
  fallDeg?: number | null;
  /** The surface design, when one is on (see surface.ts summary). */
  design?: {
    design: string;
    designSlopePct: number;
    designToward: string | null;
    cutM3: number;
    fillM3: number;
    ratioTarget: number;
  } | null;
};

const round = (v: number, digits: number) =>
  Math.round(v * 10 ** digits) / 10 ** digits;

/** A name safe on every file system, for the downloaded file. */
export const fileStem = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "field";

export const fieldsGeoJson = (fields: ExportField[]) =>
  JSON.stringify(
    {
      type: "FeatureCollection",
      features: fields.map((f) => ({
        type: "Feature",
        properties: {
          name: f.name,
          area_ha: round(f.areaHa, 4),
          crop: f.crop ?? null,
          slope_pct: f.slopePct == null ? null : round(f.slopePct, 3),
          falls_to: f.fallDeg == null ? null : compassPoint(f.fallDeg),
          ...(f.design
            ? {
                design: f.design.design,
                design_slope_pct: f.design.designSlopePct,
                design_falls_to: f.design.designToward,
                cut_m3: f.design.cutM3,
                fill_m3: f.design.fillM3,
                cut_fill_target: f.design.ratioTarget,
              }
            : {}),
          source: "Sillon · IGN LiDAR HD",
        },
        geometry: {
          type: "Polygon",
          coordinates: [
            closedCoords(f.ring).map(([lng, lat]) => [
              round(lng, 8),
              round(lat, 8),
            ]),
          ],
        },
      })),
    },
    null,
    1,
  );

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

export const fieldsKml = (fields: ExportField[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Sillon fields</name>
${fields
  .map(
    (f) => `  <Placemark>
    <name>${xmlEscape(f.name)}</name>
    <description>${round(f.areaHa, 2)} ha</description>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>${closedCoords(f.ring)
      .map(([lng, lat]) => `${lng.toFixed(8)},${lat.toFixed(8)},0`)
      .join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>`,
  )
  .join("\n")}
</Document>
</kml>
`;

const DBF_FIELDS = [
  { name: "NAME", type: "C" as const, length: 80 },
  { name: "AREA_HA", type: "N" as const, length: 12, decimals: 4 },
  { name: "CROP", type: "C" as const, length: 60 },
  { name: "SLOPE_PCT", type: "N" as const, length: 8, decimals: 3 },
  { name: "FALLS_TO", type: "C" as const, length: 3 },
  { name: "DESIGN", type: "C" as const, length: 14 },
  { name: "D_SLOPE", type: "N" as const, length: 8, decimals: 3 },
  { name: "D_TOWARD", type: "C" as const, length: 3 },
  { name: "CUT_M3", type: "N" as const, length: 12, decimals: 0 },
  { name: "FILL_M3", type: "N" as const, length: 12, decimals: 0 },
];

/**
 * A zipped WGS84 polygon shapefile, the format farm software imports
 * boundaries from, with a KML of the same fields beside it for Google Earth.
 */
export const fieldsShapefileZip = (fields: ExportField[], stem: string) => {
  const parts = writePolygonShapefile(
    DBF_FIELDS,
    fields.map((f) => ({
      ring: f.ring,
      values: [
        f.name,
        f.areaHa,
        f.crop ?? null,
        f.slopePct ?? null,
        f.fallDeg == null ? null : compassPoint(f.fallDeg),
        f.design?.design ?? null,
        f.design?.designSlopePct ?? null,
        f.design?.designToward ?? null,
        f.design?.cutM3 ?? null,
        f.design?.fillM3 ?? null,
      ],
    })),
  );
  const enc = new TextEncoder();
  return zipStore([
    { name: `${stem}.shp`, data: parts.shp },
    { name: `${stem}.shx`, data: parts.shx },
    { name: `${stem}.dbf`, data: parts.dbf },
    { name: `${stem}.prj`, data: enc.encode(parts.prj) },
    { name: `${stem}.cpg`, data: enc.encode(parts.cpg) },
    { name: `${stem}.kml`, data: enc.encode(fieldsKml(fields)) },
  ]);
};

const extension = (name: string) =>
  name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

const fromShapefileSet = (files: Map<string, Uint8Array>): NamedRing[] => {
  const dec = new TextDecoder();
  const out: NamedRing[] = [];
  for (const [name, shp] of files) {
    if (extension(name) !== "shp") continue;
    const stem = name.slice(0, -4);
    const sibling = (ext: string) =>
      [...files.keys()].find(
        (k) => k.toLowerCase() === `${stem}.${ext}`.toLowerCase(),
      );
    const dbf = sibling("dbf");
    const prj = sibling("prj");
    out.push(
      ...readPolygonShapefile(
        shp,
        dbf ? files.get(dbf) : undefined,
        prj ? dec.decode(files.get(prj)) : "",
      ),
    );
  }
  return out;
};

/**
 * Field outlines from a dropped or picked file: GeoJSON, KML, a zipped
 * shapefile (or a zip of KML/GeoJSON), or a bare .shp.
 */
export const readFieldFile = async (
  name: string,
  bytes: Uint8Array,
): Promise<NamedRing[]> => {
  const ext = extension(name);
  const text = () => new TextDecoder().decode(bytes);
  if (ext === "geojson" || ext === "json") return fieldsFromGeoJSON(text());
  if (ext === "kml") return fieldsFromKml(text());
  if (ext === "shp") return readPolygonShapefile(bytes);
  if (ext === "zip" || ext === "kmz") {
    const files = await unzip(bytes);
    const found = fromShapefileSet(files);
    for (const [inner, data] of files) {
      const e = extension(inner);
      const t = () => new TextDecoder().decode(data);
      if (e === "kml") found.push(...fieldsFromKml(t()));
      else if (e === "geojson" || e === "json")
        found.push(...fieldsFromGeoJSON(t()));
    }
    if (found.length || files.size) return found;
  }
  throw new Error(
    `Sillon reads GeoJSON, KML and zipped shapefiles, not .${ext || "this file"}.`,
  );
};

/** Today's date for download names, e.g. 2026-11-08. */
export const stamp = () => new Date().toISOString().slice(0, 10);
