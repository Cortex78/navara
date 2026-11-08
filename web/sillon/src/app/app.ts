import {
  gridPercentiles,
  percentiles,
  gridStats,
  lambert93EnvelopeOfLngLatBounds,
  loadElevationGrid,
  sampleGridLngLat,
  type ElevationGrid,
} from "../dem/elevationGrid";
import { lngLatToLambert93 } from "../geo/lambert93";
import { searchPlaces } from "../ign/geocode";
import {
  fetchLidarMetadata,
  summarizeAcquisition,
  type LngLatBounds,
} from "../ign/lidarMetadata";
import { BASE_IMAGERY } from "../imagery/catalog";

import { ensureDemBridge } from "./demBridgeClient";
import {
  formatAcquisition,
  formatBytes,
  formatHeight,
  formatLngLat,
} from "./format";
import { MapView, RELIEF_COLOR_MAP, type LidarMode } from "./mapView";
import { buildPanel } from "./panel";

/** Grids beyond this ground area load at 1 m instead of the native 0.5 m. */
const NATIVE_GRID_MAX_KM2 = 4;
const GRID_MAX_KM2 = 25;

export const startApp = async (mapEl: HTMLElement, uiEl: HTMLElement) => {
  const ui = buildPanel(uiEl, {
    imagery: BASE_IMAGERY.map(({ id, label }) => ({ id, label })),
    reliefGradient: RELIEF_COLOR_MAP,
  });

  let base: string;
  try {
    base = await ensureDemBridge();
  } catch (e) {
    ui.setStatus(e instanceof Error ? e.message : String(e), "error");
    return;
  }

  const map = new MapView(mapEl);
  await map.init(base);
  ui.setStatus("");
  Object.assign(window, { sillon: { map } });

  let grid: ElevationGrid | null = null;
  let autoRange = true;

  // Map panel
  ui.on("goTo", async (query) => {
    try {
      const [place] = await searchPlaces(query);
      if (!place) return ui.setStatus(`Nothing found for “${query}”`, "error");
      ui.setStatus(place.label);
      map.flyTo(place);
    } catch (e) {
      ui.setStatus(
        `Search failed: ${e instanceof Error ? e.message : e}`,
        "error",
      );
    }
  });
  ui.on("imagery", (id) => map.setImagery(id));
  ui.on("viewMode", (mode) => map.setViewMode(mode));

  // LiDAR panel
  ui.on("lidarMode", (mode: LidarMode) => {
    map.setLidarMode(mode);
    ui.showLegend(mode === "hypsometric");
  });
  ui.on("lidarOpacity", (v) => map.setLidarOpacity(v));
  ui.on("heightStretch", (v) => map.setHeightStretch(v));
  ui.on("fitRange", () => {
    autoRange = true;
    fitRangeToView();
  });

  const applyRange = (min: number, max: number) => {
    map.setReliefRange(min, max);
    ui.setLegendRange(min, max);
  };

  const fitRangeToView = () => {
    if (!autoRange) return;
    const [lo, hi] = grid
      ? gridPercentiles(grid, [0.01, 0.99])
      : percentiles(map.sampleViewHeights(), [0.01, 0.99]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) applyRange(lo, hi);
  };
  // Tiles keep refining after the camera stops; refit once they settle.
  map.view.on("idle", () => {
    if (!grid) fitRangeToView();
  });

  // Acquisition badge
  let metaAbort: AbortController | undefined;
  const refreshAcquisition = async (bounds: LngLatBounds) => {
    metaAbort?.abort();
    metaAbort = new AbortController();
    try {
      const tiles = await fetchLidarMetadata(bounds, {
        signal: metaAbort.signal,
      });
      const summary = summarizeAcquisition(tiles);
      ui.setAcquisition(
        summary
          ? formatAcquisition(summary)
          : "No LiDAR HD delivery here yet (RGE ALTI® shown)",
      );
    } catch {
      if (!metaAbort.signal.aborted)
        ui.setAcquisition("LiDAR HD metadata unavailable");
    }
  };

  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  const onMoveEnd = () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      fitRangeToView();
      const c = map.centre();
      if (c) {
        const d = 0.002;
        void refreshAcquisition({
          west: c.lng - d,
          east: c.lng + d,
          south: c.lat - d,
          north: c.lat + d,
        });
      }
    }, 400);
  };
  map.view.camera.on("moveend", onMoveEnd);
  // The start view was set during init, before this listener existed.
  onMoveEnd();

  // Cursor readout: native LiDAR grid when loaded, else the rendered DTM.
  map.view.on("pointermove", (e) => {
    const p = map.pick(e.clientX, e.clientY);
    if (!p) return ui.setReadout("");
    const fromGrid = grid ? sampleGridLngLat(grid, p) : NaN;
    const h = Number.isNaN(fromGrid) ? p.height : fromGrid;
    const { x, y } = lngLatToLambert93(p);
    ui.setReadout(
      `${h === undefined ? "—" : formatHeight(h)} ${Number.isNaN(fromGrid) ? "" : "LiDAR "}· ${formatLngLat(p.lng, p.lat)} · L93 ${x.toFixed(1)} ${y.toFixed(1)}`,
    );
  });

  // Data panel: pull the analysis grid for what is on screen.
  let gridAbort: AbortController | undefined;
  ui.on("loadGrid", async () => {
    const bounds = map.visibleBounds();
    if (!bounds) return ui.setGridInfo("Point the map at the ground first.");
    const env = lambert93EnvelopeOfLngLatBounds(bounds);
    const km2 = ((env.maxX - env.minX) * (env.maxY - env.minY)) / 1e6;
    if (km2 > GRID_MAX_KM2)
      return ui.setGridInfo(
        `View covers ${km2.toFixed(1)} km²; zoom in below ${GRID_MAX_KM2} km².`,
      );
    const cellSize = km2 > NATIVE_GRID_MAX_KM2 ? 1 : 0.5;

    gridAbort?.abort();
    gridAbort = new AbortController();
    const t0 = performance.now();
    try {
      const loaded = await loadElevationGrid({
        bbox: env,
        cellSize,
        signal: gridAbort.signal,
        onProgress: ({ done, total }) =>
          ui.setGridInfo(`Loading LiDAR HD grid… ${done}/${total} blocks`),
      });
      grid = loaded;
      const s = gridStats(loaded);
      const nodataPct = (100 * s.nodataCells) / loaded.data.length;
      ui.setGridInfo(
        [
          `${loaded.width} × ${loaded.height} cells at ${cellSize} m (${formatBytes(loaded.data.byteLength)})`,
          `${(((s.validCells * s.cellAreaM2) / 1e4) | 0).toLocaleString("en-GB")} ha · ${formatHeight(s.min)} to ${formatHeight(s.max)} · relief ${formatHeight(s.max - s.min)}`,
          nodataPct > 0.05
            ? `${nodataPct.toFixed(1)} % no LiDAR coverage`
            : "Full LiDAR HD coverage",
          `Loaded in ${((performance.now() - t0) / 1000).toFixed(1)} s from IGN WMS-R (EPSG:2154)`,
        ].join("\n"),
      );
      autoRange = true;
      fitRangeToView();
    } catch (e) {
      if (!gridAbort.signal.aborted)
        ui.setGridInfo(
          `Grid load failed: ${e instanceof Error ? e.message : e}`,
        );
    }
  });
  ui.on("clearGrid", () => {
    gridAbort?.abort();
    grid = null;
    ui.setGridInfo("");
    fitRangeToView();
  });
};
