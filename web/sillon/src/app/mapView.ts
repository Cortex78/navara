import ThreeView, {
  Color,
  ColorMap,
  TERRARIUM_ELEVATION_DECODER,
  vector3ToGeodetic,
} from "@navaramap/three";
import {
  DefaultPlugin,
  type DefaultDescriptions,
} from "@navaramap/three-default-plugin";

import { DEM_MIN_ZOOM, demTileTemplate } from "../dem/demTileBridge";
import type { LngLat } from "../geo/lambert93";
import type { LngLatBounds } from "../ign/lidarMetadata";
import {
  BASE_IMAGERY,
  LIDAR_OVERLAYS,
  type ImagerySource,
} from "../imagery/catalog";

import { RELIEF_STOPS } from "./relief";

type View = ThreeView<DefaultDescriptions>;
type LayerHandle = ReturnType<View["addLayer"]>;
type SourceHandle = ReturnType<View["addSource"]>;

/** How the LiDAR surface is shown under the imagery. */
export type LidarMode =
  "off" | "hillshade" | "hypsometric" | "ign-shade" | "classes";

export const RELIEF_COLOR_MAP = new ColorMap(
  "sequential",
  "SillonRelief",
  RELIEF_STOPS,
);

/** Rice fields north of Saintes-Maries-de-la-Mer (Camargue), flown for LiDAR HD in 2021. */
export const START_VIEW = {
  lng: 4.553,
  lat: 43.585,
  height: 2200,
  heading: 0,
  pitch: -90,
  roll: 0,
};

/** Terrain mesh detail; z17 ≈ 0.87 m cells, close to the 0.5 m source. */
const DEM_MAX_ZOOM = 17;

export type Pick = LngLat & { height: number | undefined };

export class MapView {
  readonly view: View;
  private demSource!: SourceHandle;
  private terrainLayer!: LayerHandle;
  private imagerySource!: SourceHandle;
  private imageryLayer?: LayerHandle;
  /** Overlay sources are kept once created; only their layers come and go. */
  private overlaySources = new Map<string, SourceHandle>();
  private lidarLayer?: LayerHandle;

  private imagery: ImagerySource = BASE_IMAGERY[0];
  private lidarMode: LidarMode = "hypsometric";
  private lidarOpacity = 0.65;
  private reliefRange = { min: 0, max: 5 };

  constructor(container: HTMLElement) {
    this.view = new ThreeView<DefaultDescriptions>({
      container,
      backgroundColor: new Color().setStyle("#0d1117"),
    });
    this.view.addPlugin(new DefaultPlugin());
  }

  async init(appBase: string) {
    const { view } = this;
    await view.init();
    // Hillshade and terrain carry normals and render black without light.
    view.addLight({ ambient: { intensity: 0.75 } });
    view.addLight({ sun: { intensity: 1.6 } });
    view.atmosphere.date = new Date("2024-06-21T08:30:00Z");

    this.demSource = view.addSource({
      type: "raster-dem",
      url: demTileTemplate(appBase, "mnt", 256),
      elevationDecoder: TERRARIUM_ELEVATION_DECODER(),
      minZoom: DEM_MIN_ZOOM,
      maxZoom: DEM_MAX_ZOOM,
    });
    this.terrainLayer = view.addLayer({
      type: "terrain",
      source: this.demSource,
    });
    this.imagerySource = view.addSource({
      type: "raster-tile",
      url: this.imagery.url,
      maxZoom: this.imagery.maxZoom,
    });
    this.rebuildDrapedLayers();

    view.attribution?.add([
      {
        attribution: "Terrain: IGN LiDAR HD MNT / RGE ALTI®",
        attributionUrl: "https://geoservices.ign.fr/lidarhd",
      },
      this.imagery,
    ]);
    view.setCamera(START_VIEW);
  }

  setImagery(id: string) {
    const next = BASE_IMAGERY.find((s) => s.id === id);
    if (!next || next === this.imagery) return;
    this.imagery = next;
    this.imagerySource.update({ url: next.url, maxZoom: next.maxZoom });
    this.view.attribution?.add([next]);
  }

  setLidarMode(mode: LidarMode) {
    this.lidarMode = mode;
    this.rebuildDrapedLayers();
  }

  /** 0 = imagery only, 1 = LiDAR only. */
  setLidarOpacity(opacity: number) {
    this.lidarOpacity = opacity;
    this.imageryLayer?.update({ raster: { opacity: this.imageryOpacity() } });
  }

  setHeightStretch(exaggeration: number) {
    this.terrainLayer.update({ terrain: { exaggeration } });
  }

  setReliefRange(min: number, max: number) {
    if (!(max > min)) max = min + 0.01;
    this.reliefRange = { min, max };
    if (this.lidarMode === "hypsometric") {
      this.lidarLayer?.update({
        elevationHeatmap: { minHeight: min, maxHeight: max },
      });
    }
  }

  get relief() {
    return { ...this.reliefRange };
  }

  get mode() {
    return this.lidarMode;
  }

  setViewMode(mode: "plan" | "3d") {
    const { lng, lat } = this.centre() ?? START_VIEW;
    const height = this.view.camera.positionGeographic.height;
    void this.view.flyTo(
      mode === "plan"
        ? { lng, lat, height, heading: 0, pitch: -90, roll: 0 }
        : {
            lng,
            lat,
            distance: height * 1.4,
            heading: 20,
            pitch: -35,
            roll: 0,
          },
      { duration: 1.2 },
    );
  }

  flyTo(p: LngLat, height = 2200) {
    void this.view.flyTo(
      { ...p, height, heading: 0, pitch: -90, roll: 0 },
      { duration: 2 },
    );
  }

  /** Terrain point under a client pixel, with the rendered DTM height there. */
  pick(clientX: number, clientY: number): Pick | null {
    const hit = this.view.pickTerrainPosition(clientX, clientY);
    if (!hit) return null;
    const { lng, lat } = vector3ToGeodetic(hit);
    return { lng, lat, height: this.view.sampleTerrainHeight({ lng, lat }) };
  }

  centre(): LngLat | null {
    const r = this.view.canvas.getBoundingClientRect();
    return this.pick(r.left + r.width / 2, r.top + r.height / 2);
  }

  /** Ground area visible on screen, from the four canvas corners (inset, for 3D views). */
  visibleBounds(): LngLatBounds | null {
    const r = this.view.canvas.getBoundingClientRect();
    const pts = [
      [0.02, 0.02],
      [0.98, 0.02],
      [0.02, 0.98],
      [0.98, 0.98],
      [0.5, 0.5],
    ]
      .map(([fx, fy]) =>
        this.pick(r.left + r.width * fx, r.top + r.height * fy),
      )
      .filter((p): p is Pick => p !== null);
    if (pts.length < 2) return null;
    return {
      west: Math.min(...pts.map((p) => p.lng)),
      east: Math.max(...pts.map((p) => p.lng)),
      south: Math.min(...pts.map((p) => p.lat)),
      north: Math.max(...pts.map((p) => p.lat)),
    };
  }

  /**
   * Rendered DTM heights on an `n`×`n` lattice of screen points. Heights come
   * from the tiles drawn now, so they match what the colour ramp is applied
   * to; `observeTerrainHeightRange` instead reports min/max over whole
   * coarse tiles, which reach far outside the view.
   */
  sampleViewHeights(n = 24): number[] {
    const r = this.view.canvas.getBoundingClientRect();
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const p = this.pick(
          r.left + (r.width * (i + 0.5)) / n,
          r.top + (r.height * (j + 0.5)) / n,
        );
        if (p?.height !== undefined) out.push(p.height);
      }
    }
    return out;
  }

  private imageryOpacity() {
    return this.lidarMode === "off" ? 1 : 1 - this.lidarOpacity;
  }

  /**
   * LiDAR goes under the imagery and the LiDAR opacity fades the imagery out:
   * a raster layer's `opacity` applies to imagery only, not to the hillshade
   * or heatmap a DEM-backed raster layer draws. Layers draw in add order, so
   * both are re-added whenever the LiDAR layer changes.
   */
  private rebuildDrapedLayers() {
    const { view } = this;
    this.imageryLayer?.delete();
    this.lidarLayer?.delete();
    this.lidarLayer = undefined;

    const { min, max } = this.reliefRange;
    switch (this.lidarMode) {
      case "hillshade":
        this.lidarLayer = view.addLayer({
          type: "raster",
          source: this.demSource,
          hillshade: { exaggeration: 3 },
        });
        break;
      case "hypsometric":
        this.lidarLayer = view.addLayer({
          type: "raster",
          source: this.demSource,
          elevationHeatmap: {
            colorMap: RELIEF_COLOR_MAP.flatten(),
            minHeight: min,
            maxHeight: max,
          },
        });
        break;
      case "ign-shade":
      case "classes": {
        const id =
          this.lidarMode === "classes"
            ? "ign-lidar-classes"
            : "ign-lidar-shade";
        let source = this.overlaySources.get(id);
        if (!source) {
          const overlay = LIDAR_OVERLAYS.find((s) => s.id === id);
          if (!overlay) throw new Error(`unknown LiDAR overlay ${id}`);
          source = view.addSource({
            type: "raster-tile",
            url: overlay.url,
            maxZoom: overlay.maxZoom,
          });
          this.overlaySources.set(id, source);
        }
        this.lidarLayer = view.addLayer({ type: "raster", source });
        break;
      }
      case "off":
        break;
    }
    this.imageryLayer = view.addLayer({
      type: "raster",
      source: this.imagerySource,
      raster: { opacity: this.imageryOpacity() },
    });
  }
}
