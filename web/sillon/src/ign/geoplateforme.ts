/**
 * IGN Géoplateforme endpoints and the layer identifiers Sillon uses. All
 * services send `Access-Control-Allow-Origin: *` and need no key. Data is
 * under Licence Ouverte / Etalab 2.0.
 */

export const GEOPF = "https://data.geopf.fr";

export const IGN_ATTRIBUTION = {
  attribution: "© IGN — LiDAR HD, BD ORTHO®, RPG",
  attributionUrl: "https://geoservices.ign.fr/cgu-licences",
};

/** WMS-R raster layers that return elevations as `image/x-bil;bits=32`. */
export const ELEVATION_LAYERS = {
  /** LiDAR HD bare-earth DTM (MNT, 0.5 m), native Lambert-93 grid. */
  lidarMntL93: "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93",
  /** LiDAR HD DTM served in geographic/Web-Mercator CRSs; no-data outside coverage. */
  lidarMnt: "IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G",
  /** LiDAR HD DTM where flown, RGE ALTI elsewhere: gap-free over France. */
  lidarMntMixed: "IGNF_LIDAR-HD_MNT_ELEVATION.MIXED.WGS84G",
  /** LiDAR HD surface model (MNS): ground plus trees, buildings, levee crests. */
  lidarMnsL93: "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93",
  lidarMns: "IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G",
  /** RGE ALTI® 1 m DTM (photogrammetry, radar and older LiDAR), all of France. */
  rgeAlti: "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES",
} as const;

export type ElevationLayer =
  (typeof ELEVATION_LAYERS)[keyof typeof ELEVATION_LAYERS];

/** Native LiDAR HD MNT/MNS cell size; pixel centres sit on multiples of it. */
export const LIDAR_HD_CELL = 0.5;

/** Server cap on GetMap WIDTH/HEIGHT (WMS-R capabilities `MaxWidth`). */
export const WMS_MAX_PIXELS = 5010;

/**
 * Values at or below this are no-data. The Géoplateforme writes -9999 (and
 * -99999 on some products), and resampling to a coarser grid blends that
 * sentinel with real heights near coverage edges, giving values such as
 * -998.5 or -49.2. The lowest ground in France is about -10 m.
 */
export const NODATA_THRESHOLD = -20;

export type WmsGetMapParams = {
  layer: string;
  crs: "EPSG:2154" | "EPSG:3857" | "EPSG:4326";
  /** minX, minY, maxX, maxY in `crs` axis units (EPSG:4326 is lat,lng order). */
  bbox: [number, number, number, number];
  width: number;
  height: number;
  format?: string;
  style?: string;
};

export const wmsGetMapUrl = ({
  layer,
  crs,
  bbox,
  width,
  height,
  format = "image/x-bil;bits=32",
  style = "",
}: WmsGetMapParams): string => {
  if (width > WMS_MAX_PIXELS || height > WMS_MAX_PIXELS) {
    throw new RangeError(
      `GetMap ${width}x${height} exceeds ${WMS_MAX_PIXELS} px`,
    );
  }
  const q = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: layer,
    STYLES: style,
    CRS: crs,
    BBOX: bbox.join(","),
    WIDTH: String(width),
    HEIGHT: String(height),
    FORMAT: format,
    EXCEPTIONS: "text/xml",
  });
  return `${GEOPF}/wms-r/wms?${q}`;
};

/**
 * XYZ template for a Web-Mercator (`PM`) WMTS layer. The `{z}/{x}/{y}`
 * placeholders are left for the map engine to fill.
 */
export const wmtsTemplate = (
  layer: string,
  format: "image/jpeg" | "image/png",
  style = "normal",
) =>
  `${GEOPF}/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}` +
  `&STYLE=${style}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=${format}`;

export class GeoplateformeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "GeoplateformeError";
  }
}

/** Pulls the text out of an OGC `ServiceExceptionReport` / `ExceptionReport`. */
export const parseOgcException = (xml: string): string => {
  const m = xml.match(
    /<(?:\w+:)?(?:ServiceException|ExceptionText)(?:\s[^>]*)?>([\s\S]*?)<\//,
  );
  return (m?.[1] ?? xml).trim().slice(0, 300);
};

const RETRYABLE = new Set([429, 502, 503, 504]);

export type FetchOptions = {
  signal?: AbortSignal;
  /** Attempts after the first one on 429/5xx or a network error. */
  retries?: number;
  /** Per-attempt timeout in ms; the Géoplateforme can hang on empty areas. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** GET with timeout and backoff on throttling; throws GeoplateformeError on OGC errors. */
export const geopfFetch = async (
  url: string,
  {
    signal,
    retries = 2,
    timeoutMs = 30_000,
    fetchImpl = fetch,
  }: FetchOptions = {},
): Promise<Response> => {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response | undefined;
    try {
      res = await fetchImpl(url, { signal: combined });
    } catch (e) {
      if (signal?.aborted || attempt >= retries) throw e;
    }
    if (res) {
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && !type.includes("xml")) return res;
      if (!RETRYABLE.has(res.status) || attempt >= retries) {
        const body = await res.text();
        throw new GeoplateformeError(
          type.includes("xml") ? parseOgcException(body) : `HTTP ${res.status}`,
          res.status,
          url,
        );
      }
    }
    await sleep(500 * 2 ** attempt, signal);
  }
};
