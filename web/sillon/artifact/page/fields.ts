import maplibregl, {
  type GeoJSONSource,
  type LayerSpecification,
  type Map as MapLibreMap,
  type SourceSpecification,
} from "maplibre-gl";

import { fieldWindow, type FieldWindow } from "../../src/dem/design";
import { sampleGrid, type ElevationGrid } from "../../src/dem/elevationGrid";
import {
  fieldSurface,
  type FieldSurface,
  type LngLatPolygon,
} from "../../src/dem/fieldMask";
import { compassPoint } from "../../src/dem/planeFit";
import {
  profileCsv,
  profileStats,
  profileStep,
  sampleProfile,
  type ProfileSample,
} from "../../src/dem/profile";
import {
  closedCoords,
  HA_PER_ACRE,
  lineThroughRing,
  outerRing,
  ringAreaM2,
  ringCentroid,
  ringPerimeterM,
  selfIntersects,
  type Ring,
} from "../../src/field/geometry";
import {
  lambert93ToLngLat,
  lngLatToLambert93,
  type LngLat,
  type XY,
} from "../../src/geo/lambert93";
import type { LngLatBounds } from "../../src/ign/lidarMetadata";

import { track } from "./activity";
import { MAP } from "./brand";
import {
  fieldsGeoJson,
  fieldsShapefileZip,
  fileStem,
  readFieldFile,
  stamp,
  type ExportField,
} from "./exporters";
import { describeMcpError, type LiveProxy } from "./live";
import { OutlineEditor, type EditorKind } from "./outlineEditor";
import { drawProfileChart, formatDistance } from "./profileChart";
import { openFieldStore, type FieldStore, type SavedField } from "./store";
import { installSurface } from "./surface";
import { grouped, height as formatHeight } from "./units";

/*
 * The field workbench: define a field (pick an RPG parcel, draw, import,
 * or reopen a saved one), read its area, natural fall and levelling
 * volumes from the LiDAR grid, cut an elevation profile, and take the
 * outline to farm software as GeoJSON, KML or a shapefile.
 */

// ── Map overlays ────────────────────────────────────────────────────────────

const collection = (
  features: GeoJSON.Feature[] = [],
): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

type OverlayKey = "current" | "target" | "fall" | "profile" | "edit" | "cursor";

/** Overlay data lives here so a style rebuild (source switch) keeps it. */
const overlays: Record<OverlayKey, GeoJSON.FeatureCollection> = {
  current: collection(),
  target: collection(),
  fall: collection(),
  profile: collection(),
  edit: collection(),
  cursor: collection(),
};

export const overlaySources = (): Record<string, SourceSpecification> =>
  Object.fromEntries(
    Object.entries(overlays).map(([k, data]) => [
      `ov-${k}`,
      { type: "geojson", data },
    ]),
  );

const isLine: ["==", ["geometry-type"], string] = [
  "==",
  ["geometry-type"],
  "LineString",
];
const isPolygon: ["==", ["geometry-type"], string] = [
  "==",
  ["geometry-type"],
  "Polygon",
];

export const overlayLayers = (): LayerSpecification[] => [
  {
    id: "ov-current-fill",
    type: "fill",
    source: "ov-current",
    paint: { "fill-color": MAP.signal, "fill-opacity": 0.06 },
  },
  {
    // The selected field emits light: a blurred halo under a crisp line.
    id: "ov-current-glow",
    type: "line",
    source: "ov-current",
    paint: {
      "line-color": MAP.signal,
      "line-width": 7,
      "line-blur": 6,
      "line-opacity": 0.55,
    },
  },
  {
    id: "ov-current-line",
    type: "line",
    source: "ov-current",
    paint: { "line-color": MAP.signal, "line-width": 2 },
  },
  {
    // Corner brackets around the selected field: the GAïa target lock.
    id: "ov-target",
    type: "line",
    source: "ov-target",
    layout: { "line-cap": "square", "line-join": "miter" },
    paint: { "line-color": MAP.signal, "line-width": 2.5 },
  },
  {
    id: "ov-fall-casing",
    type: "line",
    source: "ov-fall",
    filter: isLine,
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP.casing, "line-width": 7, "line-opacity": 0.55 },
  },
  {
    id: "ov-fall-line",
    type: "line",
    source: "ov-fall",
    filter: isLine,
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP.bone, "line-width": 3.2 },
  },
  {
    id: "ov-fall-head",
    type: "fill",
    source: "ov-fall",
    filter: isPolygon,
    paint: { "fill-color": MAP.bone },
  },
  {
    id: "ov-profile-casing",
    type: "line",
    source: "ov-profile",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP.casing, "line-width": 7, "line-opacity": 0.6 },
  },
  {
    id: "ov-profile-line",
    type: "line",
    source: "ov-profile",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": MAP.phosphor, "line-width": 3 },
  },
  {
    id: "ov-edit-fill",
    type: "fill",
    source: "ov-edit",
    filter: isPolygon,
    paint: { "fill-color": MAP.signal, "fill-opacity": 0.12 },
  },
  {
    id: "ov-edit-line",
    type: "line",
    source: "ov-edit",
    paint: {
      "line-color": MAP.signalLight,
      "line-width": 2,
      "line-dasharray": [2, 1.2],
    },
  },
  {
    id: "ov-cursor",
    type: "circle",
    source: "ov-cursor",
    paint: {
      "circle-radius": 5.5,
      "circle-color": MAP.phosphor,
      "circle-stroke-color": MAP.casing,
      "circle-stroke-width": 2,
    },
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** A whole number, thousands grouped with narrow no-break spaces. */
const whole = (v: number) => grouped(v, 0);

const polygonOf = (ring: Ring): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [closedCoords(ring)],
});

const polygonsOf = (
  g: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): LngLatPolygon[] => {
  const toRings = (poly: GeoJSON.Position[][]) =>
    poly.map((ring) => ring.map(([lng, lat]) => ({ lng, lat })));
  return g.type === "Polygon"
    ? [toRings(g.coordinates)]
    : g.coordinates.map(toRings);
};

/** Ground area of polygons with holes, in m². */
const polygonsAreaM2 = (polys: LngLatPolygon[]) =>
  polys.reduce(
    (s, [outer, ...holes]) =>
      s + ringAreaM2(outer) - holes.reduce((h, r) => h + ringAreaM2(r), 0),
    0,
  );

const inside = (b: LngLatBounds, p: LngLat) =>
  p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north;

/** A fall arrow: a shaft through `centre` toward `bearing`, and its head. */
const fallArrow = (
  centre: LngLat,
  bearingDeg: number,
  lengthM: number,
): GeoJSON.Feature[] => {
  const c = lngLatToLambert93(centre);
  const rad = (bearingDeg * Math.PI) / 180;
  const d = { x: Math.sin(rad), y: Math.cos(rad) };
  const n = { x: d.y, y: -d.x };
  const at = (along: number, across = 0): GeoJSON.Position => {
    const p = lambert93ToLngLat({
      x: c.x + d.x * along + n.x * across,
      y: c.y + d.y * along + n.y * across,
    });
    return [p.lng, p.lat];
  };
  const half = lengthM / 2;
  const head = lengthM * 0.28;
  return [
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [at(-half), at(half - head * 0.6)],
      },
    },
    {
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            at(half),
            at(half - head, head * 0.55),
            at(half - head, -head * 0.55),
            at(half),
          ],
        ],
      },
    },
  ];
};

/** Corner brackets just outside the outline's Lambert-93 bounding box. */
const targetBrackets = (
  ring: Ring,
): { features: GeoJSON.Feature[]; corner: LngLat } => {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const q of ring.map(lngLatToLambert93)) {
    [x0, x1] = [Math.min(x0, q.x), Math.max(x1, q.x)];
    [y0, y1] = [Math.min(y0, q.y), Math.max(y1, q.y)];
  }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05 + 3;
  [x0, y0, x1, y1] = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  const l = Math.min(x1 - x0, y1 - y0) * 0.18;
  const ll = (x: number, y: number): GeoJSON.Position => {
    const q = lambert93ToLngLat({ x, y });
    return [q.lng, q.lat];
  };
  const corner = (
    cx: number,
    cy: number,
    dx: number,
    dy: number,
  ): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: {
      type: "LineString",
      coordinates: [ll(cx + dx * l, cy), ll(cx, cy), ll(cx, cy + dy * l)],
    },
  });
  return {
    features: [
      corner(x0, y1, 1, -1),
      corner(x1, y1, -1, -1),
      corner(x1, y0, -1, 1),
      corner(x0, y0, 1, 1),
    ],
    corner: lambert93ToLngLat({ x: x0, y: y1 }),
  };
};

/**
 * Compass bearing of the outline's long axis: the principal direction of
 * its boundary, each side weighted by its length (an RPG outline breaks
 * a long side into many short ones, so the single longest side misleads).
 */
const longAxisBearing = (ring: Ring) => {
  const p = ring.map(lngLatToLambert93);
  let w = 0;
  let mx = 0;
  let my = 0;
  const mids: { x: number; y: number; len: number }[] = [];
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const len = Math.hypot(p[i].x - p[j].x, p[i].y - p[j].y);
    const mid = { x: (p[i].x + p[j].x) / 2, y: (p[i].y + p[j].y) / 2, len };
    mids.push(mid);
    w += len;
    mx += mid.x * len;
    my += mid.y * len;
  }
  mx /= w;
  my /= w;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const m of mids) {
    sxx += m.len * (m.x - mx) ** 2;
    syy += m.len * (m.y - my) ** 2;
    sxy += m.len * (m.x - mx) * (m.y - my);
  }
  // Angle of the major axis from east, counter-clockwise; to a compass bearing.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return (((90 - (theta * 180) / Math.PI) % 180) + 180) % 180;
};

// ── Workbench ───────────────────────────────────────────────────────────────

type Stats = FieldSurface & { source?: string; cellSize?: number };

type CurrentField = {
  savedId: string | null;
  dirty: boolean;
  name: string;
  ring: Ring;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  crop: string | null;
  declaredHa: number | null;
  stats: Stats | null;
  note: string;
};

export type WorkbenchContext = {
  map: MapLibreMap;
  source: () => "pack" | "live";
  live: () => LiveProxy | null;
  grids: { fine: ElevationGrid; context: ElevationGrid };
  /** Where the pack has terrain (its 20 m context). */
  packArea: LngLatBounds;
  setStatus: (text: string, kind?: "info" | "error") => void;
  /** Colours the relief ramp to this height range. */
  colourTo: (lo: number, hi: number) => void;
  /** Back to the ramp fitted to the view. */
  colourAuto: () => void;
  /** Switches to Live IGN; false when the connector is not available. */
  useLive: () => boolean;
  /** The design's cut/fill map went on or off. */
  onDesignMap?: (on: boolean) => void;
};

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

type DownloadsHost = {
  save(r: { filename: string; data: string | Blob }): Promise<unknown>;
};

export const installWorkbench = (ctx: WorkbenchContext) => {
  const { map } = ctx;
  const ui = {
    drawField: $<HTMLButtonElement>("draw-field"),
    drawProfile: $<HTMLButtonElement>("draw-profile"),
    importBtn: $<HTMLButtonElement>("import-btn"),
    importFile: $<HTMLInputElement>("import-file"),
    hint: $("field-hint"),
    card: $("field-card"),
    name: $<HTMLInputElement>("field-name"),
    crop: $("field-crop"),
    stats: $("field-stats"),
    note: $("field-note"),
    fit: $<HTMLButtonElement>("field-fit"),
    fall: $<HTMLButtonElement>("field-fall"),
    edit: $<HTMLButtonElement>("field-edit"),
    save: $<HTMLButtonElement>("field-save"),
    geojson: $<HTMLButtonElement>("field-geojson"),
    shp: $<HTMLButtonElement>("field-shp"),
    clear: $<HTMLButtonElement>("field-clear"),
    mine: $("mine"),
    mineList: $<HTMLUListElement>("mine-list"),
    mineStatus: $("mine-status"),
    mineGeojson: $<HTMLButtonElement>("mine-geojson"),
    mineShp: $<HTMLButtonElement>("mine-shp"),
    toolbar: $("toolbar"),
    toolbarText: $("toolbar-text"),
    toolUndo: $<HTMLButtonElement>("tool-undo"),
    toolCancel: $<HTMLButtonElement>("tool-cancel"),
    toolDone: $<HTMLButtonElement>("tool-done"),
    drawer: $("drawer"),
    drawerTitle: $("drawer-title"),
    drawerStats: $("drawer-stats"),
    drawerCsv: $<HTMLButtonElement>("drawer-csv"),
    drawerClose: $<HTMLButtonElement>("drawer-close"),
    chart: $("chart"),
  };

  const setOverlay = (key: OverlayKey, features: GeoJSON.Feature[]) => {
    overlays[key] = collection(features);
    (map.getSource(`ov-${key}`) as GeoJSONSource | undefined)?.setData(
      overlays[key],
    );
  };

  const fitTo = (points: LngLat[]) => {
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of points) {
      [w, e] = [Math.min(w, p.lng), Math.max(e, p.lng)];
      [s, n] = [Math.min(s, p.lat), Math.max(n, p.lat)];
    }
    const phone = window.innerWidth <= 700;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      {
        padding: phone
          ? {
              top: 60,
              bottom: window.innerHeight * 0.48 + 24,
              left: 28,
              right: 56,
            }
          : { top: 64, bottom: 64, left: 64, right: 64 },
        maxZoom: 17.5,
        duration: 900,
      },
    );
  };

  // ── Files out ──
  const host = (
    window as unknown as { claude?: { use(n: string): Promise<unknown> } }
  ).claude;
  const downloadsReady: Promise<DownloadsHost | null> = host?.use
    ? (host.use("downloads").catch(() => null) as Promise<DownloadsHost | null>)
    : Promise.resolve(null);

  const offerFile = async (filename: string, data: string | Uint8Array) => {
    const blob = new Blob([data as BlobPart]);
    const downloads = await downloadsReady;
    if (!host?.use) {
      // A plain browser (local preview): an ordinary download link.
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return;
    }
    if (!downloads) {
      if (typeof data === "string" && navigator.clipboard) {
        await navigator.clipboard.writeText(data).then(
          () =>
            ctx.setStatus(
              `Saving files is not available in this view; ${filename} was copied to the clipboard instead.`,
            ),
          () =>
            ctx.setStatus(
              "Saving files is not available in this view.",
              "error",
            ),
        );
      } else
        ctx.setStatus("Saving files is not available in this view.", "error");
      return;
    }
    try {
      await downloads.save({ filename, data: blob });
      ctx.setStatus(`${filename} saved.`);
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "declined") return;
      ctx.setStatus(
        code === "rate_limited"
          ? "Another save is waiting for your answer."
          : `${filename} could not be saved (${code ?? "error"}).`,
        "error",
      );
    }
  };

  const surface = installSurface({
    map,
    setStatus: ctx.setStatus,
    offerFile: (filename, data) => offerFile(filename, data),
    fieldStem: () => fileStem(current?.name ?? "field"),
    onMapShown: (on) => ctx.onDesignMap?.(on),
  });

  /** The selected field's tag at its top-left bracket. */
  let tag: maplibregl.Marker | null = null;
  const drawTarget = (f: CurrentField | null) => {
    if (!f) {
      setOverlay("target", []);
      tag?.remove();
      tag = null;
      return;
    }
    const { features, corner } = targetBrackets(f.ring);
    setOverlay("target", features);
    const ha = polygonsAreaM2(polygonsOf(f.geometry)) / 1e4;
    if (!tag) {
      const el = document.createElement("div");
      el.className = "gx-tag";
      tag = new maplibregl.Marker({ element: el, anchor: "bottom-left" });
    }
    tag.getElement().textContent = `Target · ${ha.toFixed(2)} ha`;
    tag.setLngLat([corner.lng, corner.lat]).addTo(map);
  };

  /** The field's cells on a pack grid: the 1 m LiDAR square, or the 20 m context. */
  const packWindow = (
    f: CurrentField,
  ): { w: FieldWindow | null; note: string } => {
    const polys = polygonsOf(f.geometry);
    const want = polygonsAreaM2(polys);
    const fine = fieldWindow(ctx.grids.fine, polys);
    if (fine && fine.validCount * fine.cellArea >= 0.97 * want)
      return { w: fine, note: "" };
    const coarse = fieldWindow(ctx.grids.context, polys);
    if (coarse && coarse.validCount >= 12)
      return {
        w: coarse,
        note: "Designed on the pack's 20 m context grid: volumes are rough here. Live IGN designs this field at up to 0.5 m.",
      };
    return { w: null, note: "" };
  };

  // ── Saved fields (filled in once the store answers) ──
  let store: FieldStore | null = null;
  let saved: SavedField[] = [];
  let armedDelete: string | null = null;

  // ── Current field ──
  let current: CurrentField | null = null;
  let measureSeq = 0;

  const exportFieldOf = (f: CurrentField): ExportField => ({
    name: f.name,
    ring: f.ring,
    areaHa: polygonsAreaM2(polygonsOf(f.geometry)) / 1e4,
    crop: f.crop,
    slopePct: f.stats?.plane ? f.stats.slopePct : null,
    fallDeg: f.stats?.plane ? f.stats.fallDeg : null,
    design: surface.summary(),
  });

  const renderCard = () => {
    const f = current;
    ui.card.hidden = !f;
    ui.hint.hidden = !!f;
    if (!f) return;
    if (document.activeElement !== ui.name) ui.name.value = f.name;
    ui.crop.textContent = f.crop ?? "";
    ui.crop.hidden = !f.crop;
    const polys = polygonsOf(f.geometry);
    const ha = polygonsAreaM2(polys) / 1e4;
    const rows: [string, string][] = [
      [
        "Area",
        `${ha.toFixed(2)} ha · ${(ha / HA_PER_ACRE).toFixed(2)} ac${f.declaredHa ? ` (${f.declaredHa} ha declared)` : ""}`,
      ],
      ["Perimeter", `${whole(ringPerimeterM(f.ring))} m`],
    ];
    const s = f.stats;
    if (s) {
      rows.push(
        [
          "Elevation",
          `${formatHeight(s.min)} to ${formatHeight(s.max)} · mean ${formatHeight(s.mean)}`,
        ],
        [
          "Relief",
          `${formatHeight(s.max - s.min)} · ${formatHeight(s.p99 - s.p1)} without ditches`,
        ],
      );
      if (s.plane) {
        rows.push(
          [
            "Natural fall",
            s.slopePct < 0.02
              ? "level (under 0.02 %)"
              : `${s.slopePct.toFixed(2)} % toward ${compassPoint(s.fallDeg)} · ${whole(s.slopePct * 100)} cm per 100 m`,
          ],
          [
            "Evenness",
            `±${(s.rmsM * 100).toFixed(0)} cm from its best-fit plane (RMS)`,
          ],
        );
      }
    }
    ui.stats.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement("dt");
        dt.textContent = k;
        const dd = document.createElement("dd");
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    const gaps =
      s && s.nodataShare > 0.02
        ? ` · ${Math.round(s.nodataShare * 100)} % of the field has no LiDAR value`
        : "";
    ui.note.textContent = `${f.note}${gaps}`;
    ui.fit.disabled = !s;
    const level = !s?.plane || s.slopePct < 0.02;
    ui.fall.disabled = !s;
    ui.fall.textContent = level
      ? "Profile along the field"
      : "Profile down the fall";
    ui.save.hidden = !store;
    ui.save.disabled = !!f.savedId && !f.dirty;
    ui.save.textContent = f.savedId
      ? f.dirty
        ? "Save changes"
        : "Saved ✓"
      : "Save to My fields";
  };

  const drawFall = () => {
    const s = current?.stats;
    if (!current || !s?.plane || s.slopePct < 0.02) {
      setOverlay("fall", []);
      return;
    }
    const size = Math.sqrt(polygonsAreaM2(polygonsOf(current.geometry)));
    setOverlay(
      "fall",
      fallArrow(
        ringCentroid(current.ring),
        s.fallDeg,
        Math.min(400, size * 0.45),
      ),
    );
  };

  const measurePack = (
    f: CurrentField,
  ): { stats: Stats | null; note: string } => {
    const polys = polygonsOf(f.geometry);
    const want = polygonsAreaM2(polys);
    const fine = fieldSurface(ctx.grids.fine, polys);
    const covered = fine ? (fine.areaHa * 1e4) / want : 0;
    if (fine && covered > 0.97 && fine.nodataShare < 0.5)
      return { stats: fine, note: "LiDAR HD, 1 m grid of the pack" };
    const coarse = fieldSurface(ctx.grids.context, polys);
    if (coarse && coarse.areaHa > 0)
      return {
        stats: coarse,
        note: "20 m context grid: this field is outside the pack's 1 m LiDAR square, so heights are coarse. Live IGN measures it at 0.5 m.",
      };
    return {
      stats: null,
      note: "No terrain for this field in the pack. Switch to Live IGN to measure it.",
    };
  };

  const measure = () => {
    const f = current;
    if (!f) return;
    const seq = ++measureSeq;
    if (ctx.source() === "pack") {
      Object.assign(f, measurePack(f));
      renderCard();
      drawFall();
      const { w, note } = packWindow(f);
      surface.setField(w, note);
      return;
    }
    const live = ctx.live();
    if (!live) return;
    f.stats = null;
    f.note = "Measuring on IGN LiDAR HD…";
    renderCard();
    drawFall();
    surface.message("Loading the field's height grid for the design…");
    track(live.fieldGrid(f.geometry.coordinates))
      .then((grid) => {
        if (seq !== measureSeq || current !== f) return;
        const w = fieldWindow(grid, polygonsOf(f.geometry));
        if (w)
          surface.setField(w, `${grid.source}, ${grid.cellSize} m design grid`);
        else
          surface.message(
            "The field is smaller than one cell of the design grid.",
          );
      })
      .catch((err) => {
        if (seq === measureSeq && current === f)
          surface.message(describeMcpError(err));
      });
    track(live.field(f.geometry.coordinates))
      .then((s) => {
        if (seq !== measureSeq || current !== f) return;
        if (s?.areaHa === undefined) {
          f.note = "No LiDAR heights for this field.";
        } else {
          f.stats = s;
          f.note = `${s.source}, ${s.cellSize} m grid`;
        }
        renderCard();
        drawFall();
      })
      .catch((err) => {
        if (seq !== measureSeq || current !== f) return;
        f.note = describeMcpError(err);
        renderCard();
      });
  };

  const showField = (
    field: Omit<CurrentField, "stats" | "note" | "dirty"> & { dirty?: boolean },
    fit = false,
  ) => {
    current = { ...field, dirty: field.dirty ?? false, stats: null, note: "" };
    setOverlay("current", [
      { type: "Feature", properties: {}, geometry: field.geometry },
    ]);
    setOverlay("fall", []);
    drawTarget(current);
    if (fit) fitTo(field.ring);
    measure();
    renderMine();
  };

  const clearField = () => {
    current = null;
    measureSeq++;
    setOverlay("current", []);
    setOverlay("fall", []);
    drawTarget(null);
    surface.setField(null);
    renderCard();
    renderMine();
  };

  /** An RPG parcel becomes the current field. */
  const selectRpg = (f: GeoJSON.Feature) => {
    if (editor) return;
    const g = f.geometry;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") return;
    const ring = outerRing(g);
    if (!ring) return;
    const p = (f.properties ?? {}) as {
      crop?: string;
      code?: string;
      ha?: number;
      organic?: boolean;
    };
    showField({
      savedId: null,
      dirty: true,
      name: p.crop ?? "RPG field",
      ring,
      geometry: g,
      crop: p.crop
        ? `${p.crop}${p.code ? ` (${p.code})` : ""}${p.organic ? " · organic" : ""} · RPG`
        : null,
      declaredHa: typeof p.ha === "number" ? p.ha : null,
    });
  };

  /** Brings a field into view, switching to Live IGN when the pack cannot measure it. */
  const openField = (field: Parameters<typeof showField>[0], fit: boolean) => {
    const c = ringCentroid(field.ring);
    if (ctx.source() === "pack" && !inside(ctx.packArea, c)) {
      if (!ctx.useLive()) {
        ctx.setStatus(
          "This field is outside the Camargue pack. Live IGN, through your Supabase connector on claude.ai, measures fields anywhere in France.",
          "error",
        );
        return;
      }
    }
    showField(field, fit);
  };

  ui.name.addEventListener("input", () => {
    if (!current) return;
    current.name = ui.name.value.trim() || "Field";
    current.dirty = true;
    renderCard();
  });
  ui.fit.addEventListener("click", () => {
    const s = current?.stats;
    if (s) ctx.colourTo(s.p1, s.p99);
  });
  ui.clear.addEventListener("click", () => {
    clearField();
    ctx.colourAuto();
  });
  ui.edit.addEventListener("click", () => {
    if (current) startEditor("polygon", current.ring);
  });
  ui.fall.addEventListener("click", () => {
    const f = current;
    const s = f?.stats;
    if (!f || !s) return;
    // Down the fall when there is one; a levelled basin along its long side.
    const sloped = !!s.plane && s.slopePct >= 0.02;
    const bearing = sloped ? s.fallDeg : longAxisBearing(f.ring);
    const chord = lineThroughRing(f.ring, ringCentroid(f.ring), bearing);
    if (!chord) return;
    void runProfile(
      chord,
      sloped
        ? `Down the natural fall, toward ${compassPoint(bearing)}`
        : `Along the field, toward ${compassPoint(bearing)}`,
    );
  });
  ui.geojson.addEventListener("click", () => {
    if (!current) return;
    void offerFile(
      `${fileStem(current.name)}.json`,
      fieldsGeoJson([exportFieldOf(current)]),
    );
  });
  ui.shp.addEventListener("click", () => {
    if (!current) return;
    const stem = fileStem(current.name);
    void offerFile(
      `${stem}-shapefile.zip`,
      fieldsShapefileZip([exportFieldOf(current)], stem),
    );
  });

  // ── Drawing ──
  let editor: OutlineEditor | null = null;
  let editorKind: EditorKind = "polygon";
  let editingExisting = false;

  const describeDraft = (points: LngLat[]) => {
    if (editorKind === "line") {
      if (points.length < 2)
        return "Click the map along the line you want to read";
      return `${points.length} points · ${formatDistance(ringPerimeterM(points, false))} · double-click or Done to read it`;
    }
    if (points.length < 3)
      return editingExisting
        ? "Drag corners to adjust the outline"
        : `Click the map to place corners (${points.length} so far)`;
    const ha = ringAreaM2(points) / 1e4;
    const crosses = selfIntersects(points)
      ? " · the outline crosses itself"
      : "";
    return `${points.length} corners · ${ha.toFixed(2)} ha${crosses}`;
  };

  const onDraft = (points: LngLat[]) => {
    const coords = points.map((p) => [p.lng, p.lat]);
    const features: GeoJSON.Feature[] = [];
    if (editorKind === "polygon" && points.length >= 3)
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[...coords, coords[0]]] },
      });
    else if (points.length >= 2)
      features.push({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    setOverlay("edit", features);
    ui.toolbarText.textContent = describeDraft(points);
    ui.toolUndo.disabled = points.length === 0 || editingExisting;
    ui.toolDone.disabled =
      points.length < (editorKind === "polygon" ? 3 : 2) ||
      (editorKind === "polygon" && selfIntersects(points));
  };

  const stopEditor = () => {
    editor?.destroy();
    editor = null;
    setOverlay("edit", []);
    ui.toolbar.hidden = true;
    document.body.classList.remove("tool-on");
    ui.drawField.setAttribute("aria-pressed", "false");
    ui.drawProfile.setAttribute("aria-pressed", "false");
  };

  const finishEditor = () => {
    if (!editor) return;
    const points = [...editor.points];
    if (editorKind === "line") {
      if (points.length < 2) return;
      stopEditor();
      void runProfile(points, `Profile along ${points.length} points`);
      return;
    }
    if (points.length < 3) return;
    if (selfIntersects(points)) {
      ctx.setStatus(
        "The outline crosses itself. Drag a corner to untangle it.",
        "error",
      );
      return;
    }
    stopEditor();
    ctx.setStatus("");
    if (editingExisting && current) {
      showField({
        ...current,
        ring: points,
        geometry: polygonOf(points),
        declaredHa: null,
        dirty: true,
      });
    } else {
      showField({
        savedId: null,
        dirty: true,
        name: `Field ${stamp()}`,
        ring: points,
        geometry: polygonOf(points),
        crop: null,
        declaredHa: null,
      });
    }
  };

  const startEditor = (kind: EditorKind, points?: LngLat[]) => {
    stopEditor();
    editorKind = kind;
    editingExisting = !!points?.length;
    ui.toolbar.hidden = false;
    document.body.classList.add("tool-on");
    (kind === "line" ? ui.drawProfile : ui.drawField).setAttribute(
      "aria-pressed",
      "true",
    );
    if (editingExisting) setOverlay("current", []);
    editor = new OutlineEditor(map, {
      kind,
      points,
      onChange: onDraft,
      onFinish: finishEditor,
    });
  };

  const cancelEditor = () => {
    const wasEditing = editingExisting;
    stopEditor();
    if (wasEditing && current)
      setOverlay("current", [
        { type: "Feature", properties: {}, geometry: current.geometry },
      ]);
  };

  ui.drawField.addEventListener("click", () =>
    editor && editorKind === "polygon" && !editingExisting
      ? cancelEditor()
      : startEditor("polygon"),
  );
  ui.drawProfile.addEventListener("click", () =>
    editor && editorKind === "line" ? cancelEditor() : startEditor("line"),
  );
  ui.toolUndo.addEventListener("click", () => editor?.undo());
  ui.toolCancel.addEventListener("click", cancelEditor);
  ui.toolDone.addEventListener("click", finishEditor);
  document.addEventListener("keydown", (e) => {
    if (!editor || (e.target as HTMLElement)?.tagName === "INPUT") return;
    if (e.key === "Escape") cancelEditor();
    else if (e.key === "Enter") finishEditor();
    else if (e.key === "Backspace" && !editingExisting) {
      e.preventDefault();
      editor.undo();
    }
  });

  // ── Profile ──
  let closeChart: (() => void) | null = null;
  let profileSamples: ProfileSample[] = [];
  let profileSeq = 0;

  const closeProfile = () => {
    profileSeq++;
    closeChart?.();
    closeChart = null;
    ui.drawer.hidden = true;
    document.body.classList.remove("profile-open");
    setOverlay("profile", []);
    setOverlay("cursor", []);
  };
  ui.drawerClose.addEventListener("click", closeProfile);
  ui.drawerCsv.addEventListener("click", () => {
    if (profileSamples.length)
      void offerFile(`profile-${stamp()}.csv`, profileCsv(profileSamples));
  });

  const heightAtPack = (p: XY) => {
    const fine = sampleGrid(ctx.grids.fine, p);
    return Number.isNaN(fine) ? sampleGrid(ctx.grids.context, p) : fine;
  };

  const runProfile = async (points: LngLat[], title: string) => {
    const seq = ++profileSeq;
    closeChart?.();
    closeChart = null;
    profileSamples = [];
    ui.drawer.hidden = false;
    document.body.classList.add("profile-open");
    ui.drawerTitle.textContent = title;
    ui.drawerCsv.disabled = true;
    ui.drawerStats.textContent = "Reading heights…";
    ui.chart.replaceChildren();
    setOverlay("profile", [
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lng, p.lat]),
        },
      },
    ]);
    const length = ringPerimeterM(points, false);
    let samples: ProfileSample[];
    let source: string;
    try {
      if (ctx.source() === "pack") {
        samples = sampleProfile(points, profileStep(length), heightAtPack);
        const fine = samples.filter(
          (s) =>
            !Number.isNaN(sampleGrid(ctx.grids.fine, lngLatToLambert93(s))),
        ).length;
        source =
          fine === samples.length
            ? "LiDAR HD 1 m (pack)"
            : fine
              ? "LiDAR HD 1 m, 20 m context outside the pack square"
              : "20 m context grid";
      } else {
        const live = ctx.live();
        if (!live) throw new Error("Live IGN is off");
        if (length > 10_000)
          throw new Error("Profiles are limited to 10 km in Live IGN.");
        const r = await track(live.profile(points.map((p) => [p.lng, p.lat])));
        samples = sampleProfile(points, r.step, () => NaN);
        const n = Math.min(samples.length, r.h.length);
        samples = samples.slice(0, n).map((s, i) => ({
          ...s,
          d: r.d[i] ?? s.d,
          h: r.h[i] ?? NaN,
        }));
        source = `${r.source}, ${r.cellSize} m grid`;
      }
    } catch (e) {
      if (seq === profileSeq)
        ui.drawerStats.textContent =
          e instanceof Error && !("code" in e)
            ? e.message
            : describeMcpError(e);
      return;
    }
    if (seq !== profileSeq) return;
    profileSamples = samples;
    const step = samples.length > 1 ? samples[1].d - samples[0].d : 1;
    const window = Math.max(10, Math.round(step * 3));
    const st = profileStats(samples, window);
    ui.drawerCsv.disabled = false;
    ui.drawerStats.textContent = st
      ? [
          formatDistance(st.lengthM),
          `${formatHeight(st.start)} → ${formatHeight(st.end)}`,
          `${st.fall >= 0 ? "falls" : "rises"} ${formatHeight(Math.abs(st.fall))} (${Math.abs(st.gradePct).toFixed(2)} %)`,
          `steepest ${window} m: +${st.maxRisePct.toFixed(1)} % / −${st.maxDropPct.toFixed(1)} %`,
          `low ${formatHeight(st.min)} · high ${formatHeight(st.max)}`,
          source,
        ].join(" · ")
      : `No heights along this line (${source}).`;
    closeChart = drawProfileChart(ui.chart, samples, (s) =>
      setOverlay(
        "cursor",
        s
          ? [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "Point", coordinates: [s.lng, s.lat] },
              },
            ]
          : [],
      ),
    );
  };

  // ── Import ──
  ui.importBtn.addEventListener("click", () => ui.importFile.click());
  ui.importFile.addEventListener("change", async () => {
    const file = ui.importFile.files?.[0];
    ui.importFile.value = "";
    if (!file) return;
    try {
      const found = await readFieldFile(
        file.name,
        new Uint8Array(await file.arrayBuffer()),
      );
      if (!found.length) {
        ctx.setStatus(`No field outlines in ${file.name}.`, "error");
        return;
      }
      const named = found.map((f, i) => ({
        ...f,
        name:
          f.name ??
          `${file.name.replace(/\.[^.]+$/, "")} ${found.length > 1 ? i + 1 : ""}`.trim(),
      }));
      if (named.length > 1 && store) {
        const batch = named.slice(0, 200);
        ctx.setStatus(`Saving ${batch.length} fields to My fields…`);
        for (const f of batch)
          await store.save({
            name: f.name,
            ring: f.ring,
            areaHa: ringAreaM2(f.ring) / 1e4,
            crop: null,
          });
        ctx.setStatus(
          `Imported ${batch.length} fields from ${file.name} into My fields${named.length > batch.length ? ` (the first ${batch.length})` : ""}.`,
        );
      } else if (named.length > 1) {
        ctx.setStatus(
          `${file.name} holds ${named.length} fields; showing the first. Saving them all needs this page on claude.ai.`,
        );
      } else ctx.setStatus("");
      const first = named[0];
      openField(
        {
          savedId: null,
          dirty: true,
          name: first.name,
          ring: first.ring,
          geometry: polygonOf(first.ring),
          crop: null,
          declaredHa: null,
        },
        true,
      );
    } catch (e) {
      ctx.setStatus(
        `${file.name} could not be read: ${e instanceof Error ? e.message : e}`,
        "error",
      );
    }
  });

  // ── My fields ──
  const renderMine = () => {
    if (!store) return;
    ui.mine.hidden = false;
    ui.mineGeojson.disabled = ui.mineShp.disabled = saved.length === 0;
    ui.mineList.replaceChildren(
      ...saved.map((f) => {
        const li = document.createElement("li");
        if (current?.savedId === f.id) li.classList.add("on");
        const open = document.createElement("button");
        open.type = "button";
        open.className = "open";
        const name = document.createElement("span");
        name.textContent = f.name;
        const area = document.createElement("span");
        area.className = "area";
        area.textContent = `${f.areaHa.toFixed(2)} ha`;
        open.append(name, area);
        open.addEventListener("click", () =>
          openField(
            {
              savedId: f.id,
              name: f.name,
              ring: f.ring,
              geometry: polygonOf(f.ring),
              crop: f.crop,
              declaredHa: null,
            },
            true,
          ),
        );
        const del = document.createElement("button");
        del.type = "button";
        del.className = "del";
        const armed = armedDelete === f.id;
        del.textContent = armed ? "Delete?" : "×";
        del.setAttribute(
          "aria-label",
          armed ? `Confirm deleting ${f.name}` : `Delete ${f.name}`,
        );
        del.addEventListener("click", () => {
          if (armedDelete !== f.id) {
            armedDelete = f.id;
            renderMine();
            setTimeout(() => {
              if (armedDelete === f.id) {
                armedDelete = null;
                renderMine();
              }
            }, 4000);
            return;
          }
          armedDelete = null;
          store
            ?.remove(f.id)
            .then(() => {
              if (current?.savedId === f.id) {
                current.savedId = null;
                current.dirty = true;
                renderCard();
              }
            })
            .catch((e) => ctx.setStatus(String(e.message ?? e), "error"));
        });
        li.append(open, del);
        return li;
      }),
    );
  };

  ui.save.addEventListener("click", () => {
    const f = current;
    if (!f || !store) return;
    ui.save.disabled = true;
    store
      .save({
        id: f.savedId ?? undefined,
        name: f.name,
        ring: f.ring,
        areaHa: polygonsAreaM2(polygonsOf(f.geometry)) / 1e4,
        crop: f.crop,
      })
      .then((id) => {
        f.savedId = id;
        f.dirty = false;
        if (current === f) renderCard();
        renderMine();
      })
      .catch((e) => {
        ctx.setStatus(String(e.message ?? e), "error");
        renderCard();
      });
  });

  const allSaved = (): ExportField[] =>
    saved.map((f) => ({
      name: f.name,
      ring: f.ring,
      areaHa: f.areaHa,
      crop: f.crop,
    }));
  ui.mineGeojson.addEventListener("click", () =>
    offerFile(`my-fields-${stamp()}.json`, fieldsGeoJson(allSaved())),
  );
  ui.mineShp.addEventListener("click", () =>
    offerFile(
      `my-fields-${stamp()}-shapefile.zip`,
      fieldsShapefileZip(allSaved(), `my-fields-${stamp()}`),
    ),
  );

  void openFieldStore().then((s) => {
    store = s;
    if (!s) return;
    ui.mine.hidden = false;
    ui.mineStatus.textContent = "Loading your saved fields…";
    const slow = setTimeout(() => {
      ui.mineStatus.textContent =
        "Your saved fields can't be reached yet; they will appear when the connection answers.";
    }, 10_000);
    s.subscribe(
      (list, confirmed) => {
        saved = list;
        if (confirmed) clearTimeout(slow);
        ui.mineStatus.textContent = list.length
          ? ""
          : "Fields you save appear here, private to you, on any device.";
        renderMine();
      },
      (message) => {
        clearTimeout(slow);
        ui.mineStatus.textContent = message;
      },
    );
    renderCard();
  });

  return {
    selectRpg,
    /** Cut or fill under the cursor when a design is on, for the readout. */
    describeAt: (p: LngLat) => surface.describeAt(p),
    isEditing: () => editor !== null,
    /** The data source changed: drop what was measured on the old one. */
    onSourceChange: () => {
      cancelEditor();
      closeProfile();
      if (current) measure();
    },
  };
};
