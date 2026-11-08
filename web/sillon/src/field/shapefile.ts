import { ringAreaM2, toLngLat, type NamedRing, type Ring } from "./geometry";

/*
 * ESRI Shapefile polygons: what John Deere Operations Center, Climate
 * FieldView, Trimble, Mes Parcelles and TELEPAC exchange field boundaries
 * as. Written in WGS84 with a UTF-8 attribute table; read in WGS84 or
 * Lambert-93, the projection French farm data usually comes in.
 */

const POLYGON = 5;
const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

export type DbfField = {
  /** At most 10 ASCII characters. */
  name: string;
  type: "C" | "N";
  length: number;
  decimals?: number;
};

export type ShapefileFeature = {
  ring: Ring;
  values: (string | number | null)[];
};

export type ShapefileParts = {
  shp: Uint8Array;
  shx: Uint8Array;
  dbf: Uint8Array;
  prj: string;
  cpg: string;
};

/** Signed area in lng/lat units: negative for clockwise (shapefile outer rings). */
const signedArea = (ring: Ring) => {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    s += (ring[j].lng - ring[i].lng) * (ring[j].lat + ring[i].lat);
  return s / 2;
};

const bboxOf = (rings: Ring[]) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const r of rings)
    for (const p of r) {
      b[0] = Math.min(b[0], p.lng);
      b[1] = Math.min(b[1], p.lat);
      b[2] = Math.max(b[2], p.lng);
      b[3] = Math.max(b[3], p.lat);
    }
  return b;
};

const writeHeader = (
  view: DataView,
  fileBytes: number,
  bbox: number[],
): void => {
  view.setInt32(0, 9994, false);
  view.setInt32(24, fileBytes / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, POLYGON, true);
  bbox.forEach((v, i) => view.setFloat64(36 + i * 8, v, true));
};

/** UTF-8 bytes of `s`, cut to `max` bytes without splitting a character. */
const utf8Prefix = (s: string, max: number) => {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= max) return bytes;
  let cut = max;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut);
};

const writeDbf = (fields: DbfField[], rows: ShapefileFeature["values"][]) => {
  const headerLength = 32 + 32 * fields.length + 1;
  const recordLength = 1 + fields.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(headerLength + recordLength * rows.length + 1);
  const view = new DataView(out.buffer);
  const now = new Date();
  out[0] = 0x03;
  out[1] = now.getUTCFullYear() - 1900;
  out[2] = now.getUTCMonth() + 1;
  out[3] = now.getUTCDate();
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    for (let k = 0; k < Math.min(10, f.name.length); k++)
      out[at + k] = f.name.charCodeAt(k) & 0x7f;
    out[at + 11] = f.type.charCodeAt(0);
    out[at + 16] = f.length;
    out[at + 17] = f.decimals ?? 0;
  });
  out[headerLength - 1] = 0x0d;
  let at = headerLength;
  for (const row of rows) {
    out.fill(0x20, at, at + recordLength);
    let col = at + 1;
    fields.forEach((f, i) => {
      const v = row[i];
      if (v !== null && v !== undefined && v !== "") {
        if (f.type === "N") {
          const text =
            typeof v === "number" && Number.isFinite(v)
              ? v.toFixed(f.decimals ?? 0)
              : "";
          const s = text.length > f.length ? "" : text.padStart(f.length);
          for (let k = 0; k < s.length; k++) out[col + k] = s.charCodeAt(k);
        } else {
          out.set(utf8Prefix(String(v), f.length), col);
        }
      }
      col += f.length;
    });
    at += recordLength;
  }
  out[at] = 0x1a;
  return out;
};

/** One polygon record per feature, outer ring clockwise as the format wants. */
export const writePolygonShapefile = (
  fields: DbfField[],
  features: ShapefileFeature[],
): ShapefileParts => {
  const rings = features.map(({ ring }) => {
    const r = signedArea(ring) > 0 ? [...ring].reverse() : ring;
    return [...r, r[0]];
  });
  const contentBytes = rings.map((r) => 44 + 4 + 16 * r.length);
  const shpBytes = 100 + contentBytes.reduce((n, c) => n + 8 + c, 0);
  const shp = new Uint8Array(shpBytes);
  const shx = new Uint8Array(100 + 8 * rings.length);
  const sv = new DataView(shp.buffer);
  const xv = new DataView(shx.buffer);
  const all = bboxOf(rings);
  writeHeader(sv, shpBytes, all);
  writeHeader(xv, shx.length, all);
  let at = 100;
  rings.forEach((ring, i) => {
    xv.setInt32(100 + i * 8, at / 2, false);
    xv.setInt32(104 + i * 8, contentBytes[i] / 2, false);
    sv.setInt32(at, i + 1, false);
    sv.setInt32(at + 4, contentBytes[i] / 2, false);
    const c = at + 8;
    sv.setInt32(c, POLYGON, true);
    bboxOf([ring]).forEach((v, k) => sv.setFloat64(c + 4 + k * 8, v, true));
    sv.setInt32(c + 36, 1, true);
    sv.setInt32(c + 40, ring.length, true);
    sv.setInt32(c + 44, 0, true);
    ring.forEach((p, k) => {
      sv.setFloat64(c + 48 + k * 16, p.lng, true);
      sv.setFloat64(c + 56 + k * 16, p.lat, true);
    });
    at = c + contentBytes[i];
  });
  return {
    shp,
    shx,
    dbf: writeDbf(
      fields,
      features.map((f) => f.values),
    ),
    prj: WGS84_PRJ,
    cpg: "UTF-8",
  };
};

const NAME_FIELDS = [
  "name",
  "nom",
  "nom_parc",
  "nom_ilot",
  "libelle",
  "label",
  "num_ilot",
  "id_parcel",
  "num_parcel",
  "id",
];

/** The text of the most name-like column of each record, or null. */
const readDbfNames = (dbf: Uint8Array | undefined): (string | null)[] => {
  if (!dbf || dbf.length < 32) return [];
  const view = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength);
  const count = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const fields: { name: string; offset: number; length: number }[] = [];
  let offset = 1;
  for (let at = 32; at + 32 <= headerLength && dbf[at] !== 0x0d; at += 32) {
    let name = "";
    for (let k = 0; k < 11 && dbf[at + k]; k++)
      name += String.fromCharCode(dbf[at + k]);
    fields.push({ name: name.toLowerCase(), offset, length: dbf[at + 16] });
    offset += dbf[at + 16];
  }
  const pick =
    NAME_FIELDS.map((n) => fields.find((f) => f.name === n)).find(Boolean) ??
    null;
  if (!pick) return [];
  const dec = new TextDecoder();
  return Array.from({ length: count }, (_, i) => {
    const at = headerLength + i * recordLength + pick.offset;
    const text = dec.decode(dbf.subarray(at, at + pick.length)).trim();
    return text || null;
  });
};

/**
 * Field outlines from a polygon shapefile: the largest ring of each record
 * (a field's outer boundary; holes and detached parts are dropped).
 */
export const readPolygonShapefile = (
  shp: Uint8Array,
  dbf?: Uint8Array,
  prj = "",
): NamedRing[] => {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength);
  if (shp.length < 100 || view.getInt32(0, false) !== 9994)
    throw new Error("not a shapefile (.shp)");
  const names = readDbfNames(dbf);
  const out: NamedRing[] = [];
  let record = 0;
  for (let at = 100; at + 12 <= shp.length; record++) {
    const length = view.getInt32(at + 4, false) * 2;
    const c = at + 8;
    at = c + length;
    const type = view.getInt32(c, true);
    // Polygon, PolygonZ, PolygonM share the 2-D layout up front.
    if (type !== 5 && type !== 15 && type !== 25) continue;
    const numParts = view.getInt32(c + 36, true);
    const numPoints = view.getInt32(c + 40, true);
    const parts = Array.from({ length: numParts }, (_, k) =>
      view.getInt32(c + 44 + k * 4, true),
    );
    const pointsAt = c + 44 + numParts * 4;
    let best: Ring | null = null;
    let bestArea = -1;
    parts.forEach((start, k) => {
      const stop = k + 1 < numParts ? parts[k + 1] : numPoints;
      const xy = Array.from({ length: stop - start }, (_, j) => ({
        x: view.getFloat64(pointsAt + (start + j) * 16, true),
        y: view.getFloat64(pointsAt + (start + j) * 16 + 8, true),
      }));
      const ring = toLngLat(xy, prj);
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (ring.length > 1 && first.lng === last.lng && first.lat === last.lat)
        ring.pop();
      if (ring.length < 3) return;
      const area = ringAreaM2(ring);
      if (area > bestArea) [best, bestArea] = [ring, area];
    });
    if (best) out.push({ ring: best, name: names[record] ?? null });
  }
  return out;
};
