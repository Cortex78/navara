import { describe, expect, it } from "vitest";

import { fetchDemTileHeights } from "./dem/demTileBridge";
import {
  gridStats,
  lambert93EnvelopeOfLngLatBounds,
  loadElevationGrid,
  sampleGridLngLat,
} from "./dem/elevationGrid";
import { lngLatToTile } from "./geo/webMercator";
import { searchPlaces } from "./ign/geocode";
import { fetchLidarMetadata, summarizeAcquisition } from "./ign/lidarMetadata";
import { BASE_IMAGERY, LIDAR_OVERLAYS } from "./imagery/catalog";

/**
 * Hits the real Géoplateforme and Esri. Run with `pnpm test:live`; skipped
 * otherwise so CI does not depend on third-party uptime.
 */
const live = process.env.SILLON_LIVE ? describe : describe.skip;

// Rice fields north of Saintes-Maries-de-la-Mer, Camargue: near sea level, flown 2021.
const CAMARGUE = { lng: 4.553, lat: 43.585 };
const FIELD = { west: 4.551, south: 43.584, east: 4.555, north: 43.586 };

live("Géoplateforme (live)", { timeout: 120_000 }, () => {
  it("serves a LiDAR HD DTM tile through the bridge path", async () => {
    const { heights: h, degraded } = await fetchDemTileHeights({
      product: "mnt",
      tileSize: 256,
      ...lngLatToTile(CAMARGUE, 17),
    });
    expect(degraded).toBe(false);
    const valid = h.filter((v) => !Number.isNaN(v));
    expect(valid.length).toBe(h.length);
    expect(Math.min(...valid)).toBeGreaterThan(-3);
    expect(Math.max(...valid)).toBeLessThan(10);
  });

  it("loads the native 0.5 m Lambert-93 grid for a field", async () => {
    const grid = await loadElevationGrid({
      bbox: lambert93EnvelopeOfLngLatBounds(FIELD),
    });
    const s = gridStats(grid);
    expect(grid.cellSize).toBe(0.5);
    expect(s.nodataCells).toBe(0);
    expect(s.max - s.min).toBeLessThan(10);
    // The bridge tile (resampled to Web Mercator) and the native grid agree.
    const centre = sampleGridLngLat(grid, CAMARGUE);
    expect(centre).toBeGreaterThan(s.min - 1e-6);
    expect(centre).toBeLessThan(s.max + 1e-6);
  });

  it("reads acquisition metadata for the area", async () => {
    const tiles = await fetchLidarMetadata(FIELD);
    expect(tiles.length).toBeGreaterThan(0);
    const summary = summarizeAcquisition(tiles);
    if (!summary) throw new Error("no acquisition summary");
    expect(summary.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(summary.meanDensity).toBeGreaterThan(5);
    expect(tiles[0].copcUrl).toMatch(
      /^https:\/\/data\.geopf\.fr\/.*\.copc\.laz$/,
    );
  });

  it("geocodes a commune", async () => {
    const [first] = await searchPlaces("Saintes-Maries-de-la-Mer");
    expect(first.label).toContain("Saintes-Maries");
    expect(first.lat).toBeCloseTo(43.45, 0);
  });

  it.each([...BASE_IMAGERY, ...LIDAR_OVERLAYS].map((s) => [s.id, s] as const))(
    "serves %s imagery tiles",
    async (_, source) => {
      const { z, x, y } = lngLatToTile(CAMARGUE, Math.min(17, source.maxZoom));
      const url = source.url
        .replace("{z}", String(z))
        .replace("{x}", String(x))
        .replace("{y}", String(y));
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^image\//);
    },
  );
});
