import { loadHeightsAt } from "../src/dem/corridor";
import { renderDemTile } from "../src/dem/demTileBridge";
import { lambert93Envelope, loadElevationGrid } from "../src/dem/elevationGrid";
import { fieldSurface, type LngLatPolygon } from "../src/dem/fieldMask";
import { profileStep, sampleProfile } from "../src/dem/profile";
import { ringPerimeterM } from "../src/field/geometry";
import type { XY } from "../src/geo/lambert93";
import { searchPlaces } from "../src/ign/geocode";
import {
  ELEVATION_LAYERS,
  GEOPF,
  geopfFetch,
  wmtsTemplate,
} from "../src/ign/geoplateforme";
import { fetchLidarMetadata } from "../src/ign/lidarMetadata";

import { KEY_PATTERN, MAX_KEYS } from "./keys";

/*
 * The IGN proxy behind the Sillon artifact's live mode, run as a Supabase
 * Edge Function. Postgres (`sillon.proxy`) forwards the keys its cache
 * misses; each key is a query string naming one tile or lookup, and each
 * answer comes back base64-encoded so it travels as JSON through SQL and
 * the claude.ai connector to the page.
 */

export type ProxyItem = {
  status: number;
  ctype: string;
  b64: string;
  /** False for answers Postgres must not cache (a fallback tile, an error). */
  cache: boolean;
};

const WMTS: Record<
  string,
  { layer: string; format: "image/jpeg" | "image/png"; maxZoom: number }
> = {
  ortho: {
    layer: "ORTHOIMAGERY.ORTHOPHOTOS",
    format: "image/jpeg",
    maxZoom: 19,
  },
  irc: {
    layer: "ORTHOIMAGERY.ORTHOPHOTOS.IRC",
    format: "image/jpeg",
    maxZoom: 19,
  },
  shade: {
    layer: "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW",
    format: "image/png",
    maxZoom: 18,
  },
};

export const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

const json = (value: unknown): ProxyItem => ({
  status: 200,
  ctype: "application/json",
  b64: toBase64(new TextEncoder().encode(JSON.stringify(value))),
  cache: true,
});

const int = (p: URLSearchParams, name: string, min: number, max: number) => {
  const v = Number(p.get(name));
  if (!Number.isInteger(v) || v < min || v > max)
    throw new RangeError(`${name} out of range`);
  return v;
};

const num = (p: URLSearchParams, name: string, min: number, max: number) => {
  const v = Number(p.get(name));
  if (!Number.isFinite(v) || v < min || v > max)
    throw new RangeError(`${name} out of range`);
  return v;
};

const tileXyz = (p: URLSearchParams, minZoom: number, maxZoom: number) => {
  const z = int(p, "z", minZoom, maxZoom);
  return { z, x: int(p, "x", 0, 2 ** z - 1), y: int(p, "y", 0, 2 ** z - 1) };
};

/** RPG crop code → French label, loaded once per instance. */
let cropNames: Promise<Record<string, string>> | null = null;
const loadCropNames = () =>
  (cropNames ??= geopfFetch(
    `${GEOPF}/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&OUTPUTFORMAT=application/json&COUNT=1000&TYPENAMES=RPG.LATEST:codes_cultures`,
  )
    .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>)
    .then((fc) =>
      Object.fromEntries(
        fc.features.map((f) => {
          const p = f.properties as Record<string, string>;
          return [p.code_culture, p.libelle_culture];
        }),
      ),
    )
    .catch((e) => {
      cropNames = null;
      throw e;
    }));

const rpgFields = async (p: URLSearchParams) => {
  const w = num(p, "w", -6, 10);
  const s = num(p, "s", 41, 52);
  const e = num(p, "e", w, w + 0.08);
  const n = num(p, "n", s, s + 0.06);
  const q = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    OUTPUTFORMAT: "application/json",
    TYPENAMES: "RPG.LATEST:parcelles_graphiques",
    COUNT: "1500",
    BBOX: `${w},${s},${e},${n},urn:ogc:def:crs:OGC:1.3:CRS84`,
  });
  const [fc, names] = await Promise.all([
    geopfFetch(`${GEOPF}/wfs/ows?${q}`).then(
      (r) => r.json() as Promise<GeoJSON.FeatureCollection>,
    ),
    loadCropNames(),
  ]);
  for (const f of fc.features) {
    const props = f.properties as Record<string, unknown>;
    f.id = String(props.num_parcel ?? f.id);
    f.properties = {
      code: props.code_cultu,
      crop: names[String(props.code_cultu)] ?? String(props.code_cultu),
      ha: props.surf_parc,
      organic: props.bio === true,
    };
  }
  return { type: "FeatureCollection", features: fc.features };
};

const handleKey = async (key: string): Promise<ProxyItem> => {
  if (!KEY_PATTERN.test(key)) throw new Error("malformed key");
  const p = new URLSearchParams(key);
  const kind = p.get("kind") ?? "";
  const wmts = WMTS[kind];
  if (wmts) {
    const { z, x, y } = tileXyz(p, 0, wmts.maxZoom);
    const url = wmtsTemplate(wmts.layer, wmts.format)
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
    const res = await geopfFetch(url, { retries: 2, timeoutMs: 20_000 });
    return {
      status: 200,
      ctype: wmts.format,
      b64: toBase64(new Uint8Array(await res.arrayBuffer())),
      cache: true,
    };
  }
  switch (kind) {
    case "dem": {
      const { png, degraded } = await renderDemTile(
        { product: "mnt", tileSize: 256, ...tileXyz(p, 8, 17) },
        { retries: 1, timeoutMs: 20_000 },
      );
      return {
        status: 200,
        ctype: "image/png",
        b64: toBase64(png),
        cache: !degraded,
      };
    }
    case "geocode": {
      const q = p.get("q") ?? "";
      if (q.length < 2 || q.length > 120) throw new RangeError("query length");
      return json(await searchPlaces(q, { limit: 5 }));
    }
    case "meta": {
      const lng = num(p, "lng", -6, 10);
      const lat = num(p, "lat", 41, 52);
      const d = 0.0005;
      return json(
        await fetchLidarMetadata({
          west: lng - d,
          east: lng + d,
          south: lat - d,
          north: lat + d,
        }),
      );
    }
    case "rpg":
      return json(await rpgFields(p));
    default:
      throw new Error(`unknown kind ${kind}`);
  }
};

export const handleProxy = async (
  keys: unknown,
): Promise<Record<string, ProxyItem>> => {
  if (
    !Array.isArray(keys) ||
    keys.length > MAX_KEYS ||
    !keys.every((k) => typeof k === "string")
  ) {
    throw new Error(`keys must be up to ${MAX_KEYS} strings`);
  }
  const answers = await Promise.all(
    keys.map((k: string) =>
      handleKey(k).catch((e): ProxyItem => ({
        status: 502,
        ctype: "text/plain",
        b64: toBase64(
          new TextEncoder().encode(e instanceof Error ? e.message : String(e)),
        ),
        cache: false,
      })),
    ),
  );
  return Object.fromEntries(keys.map((k: string, i) => [k, answers[i]]));
};

/** Above this bounding-box area a field is measured at 1 m instead of 0.5 m. */
const NATIVE_FIELD_M2 = 600_000;

/**
 * Area and relief of a field polygon (GeoJSON Polygon or MultiPolygon
 * coordinates, lng/lat) from the native Lambert-93 LiDAR HD grid.
 */
export const handleField = async (coordinates: unknown) => {
  if (!Array.isArray(coordinates))
    throw new Error("field must be GeoJSON coordinates");
  // A MultiPolygon nests one level deeper than a Polygon.
  const multi = Array.isArray(coordinates[0]?.[0]?.[0]);
  const polys = (multi ? coordinates : [coordinates]) as [number, number][][][];
  const polygons: LngLatPolygon[] = polys.map((poly) =>
    poly.map((ring) => ring.map(([lng, lat]) => ({ lng, lat }))),
  );
  const bbox = lambert93Envelope(polygons.flat(2));
  const area = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
  // At 1 m that is 4 M cells: the grid, mask and heights stay under ~80 MB.
  if (area > 4e6) throw new RangeError("field bounding box over 4 km²");
  const cellSize = area > NATIVE_FIELD_M2 ? 1 : 0.5;
  const measure = async (layer: string) =>
    fieldSurface(
      await loadElevationGrid({ bbox, cellSize, layer, retries: 1 }),
      polygons,
    );
  let surface = await measure(ELEVATION_LAYERS.lidarMntL93);
  let source = "LiDAR HD";
  if (!surface || surface.nodataShare > 0.5) {
    surface = await measure(ELEVATION_LAYERS.lidarMntMixed);
    source = "RGE ALTI";
  }
  return { ...surface, cellSize, source };
};

/** Longest profile line accepted, in ground metres. */
export const MAX_PROFILE_M = 10_000;

const round = (v: number, digits: number) =>
  Math.round(v * 10 ** digits) / 10 ** digits;

/**
 * Elevation profile along a GeoJSON LineString: heights every
 * `profileStep(length)` ground metres, from LiDAR HD where it is flown and
 * RGE ALTI elsewhere. Only the 512-cell blocks the line crosses are loaded.
 * Positions are left out: the page recomputes them with `sampleProfile`.
 */
export const handleProfile = async (coordinates: unknown) => {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length < 2 ||
    !coordinates.every(
      (c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]),
    )
  )
    throw new Error("profile must be LineString coordinates");
  const points = (coordinates as [number, number][]).map(([lng, lat]) => ({
    lng,
    lat,
  }));
  const length = ringPerimeterM(points, false);
  if (length > MAX_PROFILE_M) throw new RangeError("profile longer than 10 km");
  const step = profileStep(length);
  const cellSize = length > 3000 ? 1 : 0.5;
  const xy: XY[] = [];
  const samples = sampleProfile(points, step, (p) => {
    xy.push(p);
    return NaN;
  });
  const opts = { cellSize, tileM: 512 * cellSize, retries: 1 };
  const h = await loadHeightsAt(xy, {
    ...opts,
    layer: ELEVATION_LAYERS.lidarMntL93,
    tolerateFailures: true,
  });
  const missing = xy.flatMap((_, i) => (Number.isNaN(h[i]) ? [i] : []));
  let source = "LiDAR HD";
  if (missing.length) {
    const fill = await loadHeightsAt(
      missing.map((i) => xy[i]),
      { ...opts, layer: ELEVATION_LAYERS.lidarMntMixed },
    );
    missing.forEach((i, k) => (h[i] = fill[k]));
    source = missing.length === xy.length ? "RGE ALTI" : "LiDAR HD + RGE ALTI";
  }
  return {
    step,
    cellSize,
    source,
    d: samples.map((s) => round(s.d, 2)),
    h: Array.from(h, (v) => (Number.isNaN(v) ? null : round(v, 3))),
  };
};
