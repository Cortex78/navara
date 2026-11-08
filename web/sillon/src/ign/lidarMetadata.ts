import { GEOPF, geopfFetch, type FetchOptions } from "./geoplateforme";

/**
 * LiDAR HD delivery metadata, one record per 1 km × 1 km Lambert-93 tile
 * (WFS `IGNF_LIDAR-HD_METADONNEE:metadata`): when it was flown, by what
 * sensor, how dense, and where the point cloud and rasters download from.
 */
export type LidarTileMetadata = {
  /** `XXXX_YYYY`: km coordinates of the tile's north-west corner. */
  tileId: string;
  mission: string;
  acquisitionStart: string;
  acquisitionEnd: string;
  editionDate: string;
  sensors: string[];
  pointCount: number;
  /** Points per m² over the 1 km² tile. */
  density: number;
  classification: string;
  /** COPC LAZ point cloud (classified). */
  copcUrl: string;
  mntUrl: string;
  mnsUrl: string;
  mnhUrl: string;
};

type WfsFeature = { properties: Record<string, unknown> };

const isoDate = (v: unknown) =>
  typeof v === "string" ? v.replace(/Z$/, "") : "";

const parseSensors = (v: unknown): string[] => {
  if (typeof v !== "string") return [];
  let list: unknown = v;
  try {
    list = JSON.parse(v);
  } catch {
    // Plain string, not a JSON array.
  }
  const items = Array.isArray(list) ? list : [list];
  // Entries are "Model:serial"; the serial means nothing to a farmer.
  return [
    ...new Set(
      items.map((s) => String(s).replace(/:\w+$/, "").trim()).filter(Boolean),
    ),
  ];
};

export const parseLidarMetadataFeature = ({
  properties: p,
}: WfsFeature): LidarTileMetadata => {
  const pointCount = Number(p.nombre_points ?? 0);
  return {
    tileId: String(p.coordonnees_nw ?? "").replace("-", "_"),
    mission: String(p.code_mission ?? ""),
    acquisitionStart: isoDate(p.date_debut_acquisition),
    acquisitionEnd: isoDate(p.date_fin_acquisition),
    editionDate: isoDate(p.date_edition),
    sensors: parseSensors(p.capteur),
    pointCount,
    density: pointCount / 1e6,
    classification: String(p.procede_classement ?? ""),
    copcUrl: String(p.url_npl ?? ""),
    mntUrl: String(p.url_mnt ?? ""),
    mnsUrl: String(p.url_mns ?? ""),
    mnhUrl: String(p.url_mnh ?? ""),
  };
};

export type LngLatBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export const lidarMetadataUrl = (b: LngLatBounds, count = 200) => {
  const q = new URLSearchParams({
    SERVICE: "WFS",
    VERSION: "2.0.0",
    REQUEST: "GetFeature",
    TYPENAMES: "IGNF_LIDAR-HD_METADONNEE:metadata",
    OUTPUTFORMAT: "application/json",
    COUNT: String(count),
    BBOX: `${b.west},${b.south},${b.east},${b.north},urn:ogc:def:crs:OGC:1.3:CRS84`,
  });
  return `${GEOPF}/wfs/ows?${q}`;
};

export const fetchLidarMetadata = async (
  bounds: LngLatBounds,
  options?: FetchOptions,
): Promise<LidarTileMetadata[]> => {
  const res = await geopfFetch(lidarMetadataUrl(bounds), options);
  const json = (await res.json()) as { features?: WfsFeature[] };
  return (json.features ?? []).map(parseLidarMetadataFeature);
};

export type AcquisitionSummary = {
  tiles: number;
  start: string;
  end: string;
  sensors: string[];
  meanDensity: number;
};

/** Collapses the tiles under a field or view into one "flown when, with what" line. */
export const summarizeAcquisition = (
  tiles: LidarTileMetadata[],
): AcquisitionSummary | null => {
  if (tiles.length === 0) return null;
  const starts = tiles
    .map((t) => t.acquisitionStart)
    .filter(Boolean)
    .sort();
  const ends = tiles
    .map((t) => t.acquisitionEnd)
    .filter(Boolean)
    .sort();
  return {
    tiles: tiles.length,
    start: starts[0] ?? "",
    end: ends[ends.length - 1] ?? "",
    sensors: [...new Set(tiles.flatMap((t) => t.sensors))],
    meanDensity: tiles.reduce((s, t) => s + t.density, 0) / tiles.length,
  };
};
