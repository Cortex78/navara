import maplibregl, {
  type GeoJSONSource,
  type ImageSource,
  type LayerSpecification,
  type Map as MapLibreMap,
  type SourceSpecification,
} from "maplibre-gl";

import {
  autoInterval,
  contourLines,
  smoothValues,
} from "../../src/dem/contours";
import {
  autoMaxDepth,
  cutFillRgba,
  legendStops,
  rampColor,
  windowCorners,
  type CutFillStyle,
} from "../../src/dem/cutFillRaster";
import {
  design,
  designGrid,
  designHeight,
  robustFit,
  transportHaulM,
  type DesignPlane,
  type DesignSpec,
  type Earthworks,
  type FieldWindow,
} from "../../src/dem/design";
import { sampleGrid } from "../../src/dem/elevationGrid";
import { compassPoint, type PlaneFit } from "../../src/dem/planeFit";
import { encodePngRgba } from "../../src/dem/png";
import {
  lambert93ToLngLat,
  lngLatToLambert93,
  type LngLat,
} from "../../src/geo/lambert93";

import { CUT_FILL_RAMP, MAP } from "./brand";
import { height as fmtHeight, grouped, signedFixed } from "./units";

/*
 * Surface design: the field's target surface (its natural fall, a slope
 * set by hand, or dead level), balanced to a cut:fill ratio, with the
 * earthworks it implies, a cut/fill map, contours of the ground and of
 * the design, and a cut sheet of stakes for the contractor.
 */

export type SurfaceMode = "fit" | "slope" | "level";

/** Fewer heights than this inside a field and no design is offered. */
const MIN_DESIGN_CELLS = 12;

/** Every n-th contour is drawn heavy. */
const MAJOR_EVERY = 5;

/** Within this of the design, ground counts as on grade (map, areas, readout). */
const ON_GRADE_M = 0.02;

/** float32 depths: within a micrometre of a class edge counts as on it (cutFillRaster). */
const EDGE_SLACK_M = 1e-6;

/** Most contour labels on the map at once. */
const MAX_LABELS = 24;

/** Cut-sheet stakes: every 10 m, every 20 m over 50 ha. */
const stakeSpacing = (w: FieldWindow) => (w.areaM2 > 500_000 ? 20 : 10);

/** "20 cm" below a metre, "1.00 m" from a metre. */
const lengthText = (m: number) =>
  m < 1 ? `${Math.round(m * 100)} cm` : `${m.toFixed(2)} m`;

const collection = (
  features: GeoJSON.Feature[] = [],
): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features });

/** Kept across style rebuilds (a data-source switch rebuilds the style). */
const data = {
  contours: collection(),
  fall: collection(),
  haul: collection(),
};

/** PNG bytes of the cut/fill map, served to MapLibre through `sillon://cutfill/<n>/0/0`. */
const pngs = new Map<number, ArrayBuffer>();
export const cutFillPng = (n: number) => pngs.get(n) ?? null;

export const surfaceSources = (): Record<string, SourceSpecification> => ({
  "sd-contours": { type: "geojson", data: data.contours },
  "sd-fall": { type: "geojson", data: data.fall },
  // Line metrics let the haul wire fade from cut (ember) to fill (cyan).
  "sd-haul": { type: "geojson", data: data.haul, lineMetrics: true },
});

const isKind = (kind: string): ["==", ["get", string], string] => [
  "==",
  ["get", "kind"],
  kind,
];
const major = (a: number, b: number) =>
  ["case", ["get", "major"], a, b] as unknown as number;

/** Contours and the design fall arrow; the cut/fill image goes under them. */
export const surfaceLayers = (): LayerSpecification[] => [
  {
    id: "sd-contour-exist",
    type: "line",
    source: "sd-contours",
    filter: isKind("exist"),
    layout: { "line-join": "round" },
    paint: {
      "line-color": MAP.bone,
      "line-opacity": major(0.8, 0.42),
      "line-width": major(1.4, 0.7),
    },
  },
  {
    id: "sd-contour-design",
    type: "line",
    source: "sd-contours",
    filter: isKind("design"),
    layout: { "line-join": "round" },
    paint: {
      "line-color": MAP.signalLight,
      "line-opacity": 0.95,
      "line-width": major(1.8, 1),
      "line-dasharray": [3, 2],
    },
  },
  {
    id: "sd-haul-casing",
    type: "line",
    source: "sd-haul",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP.casing, "line-width": 7, "line-opacity": 0.55 },
  },
  {
    // Earth movement as one wire: soil leaves the cut (ember) for the fill (cyan).
    id: "sd-haul-line",
    type: "line",
    source: "sd-haul",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round" },
    paint: {
      "line-width": 3.2,
      // Through bone, not grey: orange to cyan in RGB would go muddy midway.
      "line-gradient": [
        "interpolate",
        ["linear"],
        ["line-progress"],
        0,
        MAP.ember,
        0.5,
        MAP.bone,
        1,
        MAP.fillCyan,
      ],
    },
  },
  {
    id: "sd-haul-head",
    type: "fill",
    source: "sd-haul",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": MAP.fillCyan },
  },
  {
    id: "sd-fall-casing",
    type: "line",
    source: "sd-fall",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP.casing, "line-width": 7, "line-opacity": 0.55 },
  },
  {
    id: "sd-fall-line",
    type: "line",
    source: "sd-fall",
    filter: ["==", ["geometry-type"], "LineString"],
    layout: { "line-cap": "round" },
    paint: { "line-color": MAP.signalLight, "line-width": 3.5 },
  },
  {
    id: "sd-fall-head",
    type: "fill",
    source: "sd-fall",
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": MAP.signalLight },
  },
];

/** A whole number, thousands grouped with narrow no-break spaces. */
const whole = (v: number) => grouped(v, 0);

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

/** Arrow along a bearing through `centre`: a shaft and a head, in lng/lat. */
const arrow = (
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
  const head = lengthM * 0.26;
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
            at(half - head, head * 0.5),
            at(half - head, -head * 0.5),
            at(half),
          ],
        ],
      },
    },
  ];
};

/** PNG of an RGBA raster: the browser's own encoder when it has one, ours otherwise. */
const toPng = async (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ArrayBuffer> => {
  if (typeof OffscreenCanvas !== "undefined") {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.putImageData(
          new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height),
          0,
          0,
        );
        const blob = await canvas.convertToBlob({ type: "image/png" });
        return await blob.arrayBuffer();
      }
    } catch {
      // Fall back to the pure encoder below.
    }
  }
  return (await encodePngRgba(rgba, width, height)).buffer as ArrayBuffer;
};

export type SurfaceResult = {
  spec: DesignSpec;
  plane: DesignPlane;
  works: Earthworks;
  fall: { slopePct: number; fallDeg: number };
  ratio: number;
  /** How far the design was raised (+) or lowered (−) after balancing, cm. */
  offsetCm: number;
  /** Lower bound on the mean haul, ground metres (0 when nothing moves). */
  haulMeanM: number;
};

export type SurfaceContext = {
  map: MapLibreMap;
  setStatus: (text: string, kind?: "info" | "error") => void;
  offerFile: (filename: string, data: string) => Promise<void> | void;
  /** File-name stem of the current field, for downloads. */
  fieldStem: () => string;
  /** The cut/fill map went on or off (the page pauses elevation colour meanwhile). */
  onMapShown?: (on: boolean) => void;
};

export const installSurface = (ctx: SurfaceContext) => {
  const { map } = ctx;
  const ui = {
    section: $("surface"),
    fit: $<HTMLButtonElement>("sd-fit"),
    slope: $<HTMLButtonElement>("sd-slope"),
    level: $<HTMLButtonElement>("sd-level"),
    slopeBox: $("sd-slope-box"),
    main: $<HTMLInputElement>("sd-main"),
    bearing: $<HTMLInputElement>("sd-bearing"),
    compass: $("sd-compass"),
    cross: $<HTMLInputElement>("sd-cross"),
    natural: $<HTMLButtonElement>("sd-natural"),
    ratio: $<HTMLSelectElement>("sd-ratio"),
    offset: $<HTMLInputElement>("sd-offset"),
    offsetOut: $("sd-offset-out"),
    works: $("sd-works"),
    showMap: $<HTMLInputElement>("sd-map"),
    showContours: $<HTMLInputElement>("sd-contours"),
    interval: $<HTMLSelectElement>("sd-interval"),
    legend: $("sd-legend"),
    sheet: $<HTMLButtonElement>("sd-sheet"),
    note: $("sd-note"),
    live: $("sd-live"),
    contourRow: $("sd-contour-row"),
    major: $("sd-major"),
    intervalAuto: $<HTMLOptionElement>("sd-interval-auto"),
    sheetNote: $("sd-sheet-note"),
    design: $("sd-design"),
  };

  const st = {
    mode: "fit" as SurfaceMode,
    mainPct: 0,
    bearingDeg: 0,
    crossPct: 0,
    ratio: 1,
    offsetCm: 0,
    showMap: true,
    showContours: true,
    interval: "auto" as "auto" | number,
  };

  let w: FieldWindow | null = null;
  let fit: PlaneFit | null = null;
  /** The field (its designKey) whose design the slope, offset… values are. */
  let designOwner: number | undefined;
  /** The viewer typed a fall, bearing or cross fall for that field. */
  let slopeTouched = false;
  let last: SurfaceResult | null = null;
  /** About the field's grid (its source, coverage); set with the field. */
  let baseNote = "";
  /** About the contours at the chosen interval. */
  let contourNote = "";
  let existContours: GeoJSON.Feature[] = [];
  let designContours: GeoJSON.Feature[] = [];
  let intervalUsed = 0;
  let rasterSeq = 0;
  let style: CutFillStyle | null = null;

  const showNote = () => {
    ui.note.textContent = [baseNote, contourNote].filter(Boolean).join(" ");
  };

  const setSourceData = (id: string, fc: GeoJSON.FeatureCollection) =>
    (map.getSource(id) as GeoJSONSource | undefined)?.setData(fc);

  /**
   * Runs `fn` once the style's layers exist: now, or at the first
   * "style.load" while the map starts. Not isStyleLoaded(): that stays false
   * while any tile is still loading. (A data-source switch rebuilds the
   * style by a diff, inside setStyle, so the layers are back when it returns.)
   */
  const whenStyleReady = (fn: () => void) => {
    if (map.getLayer("sd-contour-exist")) fn();
    else map.once("style.load", () => fn());
  };

  // ── Earthworks table ──
  const renderWorks = () => {
    if (!w || !last) {
      ui.works.replaceChildren();
      return;
    }
    const k = last.works;
    const ha = w.areaM2 / 1e4;
    const rows: [string, string, string?][] = [
      ["Cut", `${whole(k.cutM3)} m³`, "cut"],
      ["Fill", `${whole(k.fillM3)} m³`, "fill"],
      [
        "Cut : fill",
        Number.isFinite(k.ratio)
          ? `${k.ratio.toFixed(2)} · target ${last.ratio.toFixed(2)}`
          : "all cut",
      ],
      ["Balance", balanceText(last)],
      ["Per hectare", `${whole(k.m3PerHa)} m³/ha cut`],
      [
        "Depth",
        `±${(k.meanDepthM * 100).toFixed(0)} cm mean · cut ≤ ${k.maxCutM.toFixed(2)} m · fill ≤ ${k.maxFillM.toFixed(2)} m`,
      ],
      [
        "Areas",
        `cut ${k.cutAreaHa.toFixed(2)} · fill ${k.fillAreaHa.toFixed(2)} · on grade ${k.onGradeAreaHa.toFixed(2)} ha`,
      ],
      ["Haul", haulText(last)],
      [
        "Design",
        last.fall.slopePct < 0.005
          ? `level · ${formatDesignHeight()}`
          : `${last.fall.slopePct.toFixed(2)} % toward ${compassPoint(last.fall.fallDeg)} (${Math.round(last.fall.fallDeg)}°) · ${formatDesignHeight()}`,
      ],
    ];
    if (ha <= 0) rows.length = 0;
    ui.works.replaceChildren(
      ...rows.flatMap(([key, value, tone]) => {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = value;
        if (tone) dd.dataset.tone = tone;
        return [dt, dd];
      }),
    );
  };

  /**
   * The design's balance against its target ratio: cut − ratio × fill, in
   * cut (bank) m³. Above a ratio of 1 the spare cut is the allowance for
   * fill that shrinks as it is compacted, not soil to haul off. `met` when the
   * solver's exact balance holds (raising or lowering the design breaks it).
   */
  const balanceOf = (r: SurfaceResult) => {
    const k = r.works;
    const spare = k.cutM3 - r.ratio * k.fillM3;
    return { spare, met: Math.abs(spare) <= Math.max(0.5, 1e-4 * k.cutM3) };
  };

  const balanceText = (r: SurfaceResult) => {
    const k = r.works;
    const { spare, met } = balanceOf(r);
    const at = r.ratio === 1 ? "" : ` at ${r.ratio.toFixed(2)}`;
    if (met)
      return r.ratio === 1 || k.cutM3 - k.fillM3 < 0.5
        ? `balanced${at}`
        : `balanced${at} · ${whole(k.cutM3 - k.fillM3)} m³ allowed for shrinkage`;
    return spare > 0
      ? `${whole(spare)} m³ surplus to haul off${at}`
      : `${whole(-spare)} m³ to bring in${at}`;
  };

  /**
   * The mean haul. A lower bound ("≥") while every m³ of cut goes into the
   * fill, i.e. the target ratio is met; with a surplus or a shortfall part of
   * the soil leaves or arrives by road, so the figure is only an estimate
   * ("≈"). The centres' distance is added when it says something else: the
   * net direction the soil travels.
   */
  const haulText = (r: SurfaceResult) => {
    const k = r.works;
    if (!(r.haulMeanM > 0)) return "–";
    const mean = `${balanceOf(r).met ? "≥" : "≈"} ${whole(r.haulMeanM)} m mean`;
    return k.haulM >= 5 && k.haulM < 0.9 * r.haulMeanM
      ? `${mean} · centres ${whole(k.haulM)} m apart`
      : mean;
  };

  /** Design height at the centroid of the field's valid cells. */
  const formatDesignHeight = () => {
    if (!last) return "";
    return `${fmtHeight(last.plane.z0)} at centre`;
  };

  // ── Map layers ──
  /** The wire from the volume-weighted centre of the cut to that of the fill. */
  const drawHaul = () => {
    data.haul = collection();
    if (w && last && st.showMap) {
      const { originX, originY, cellSize, width, height } = w.grid;
      const d = last.works.depth;
      let cv = 0;
      let cx = 0;
      let cy = 0;
      let fv = 0;
      let fx = 0;
      let fy = 0;
      for (let r = 0; r < height; r++) {
        const y = originY - (r + 0.5) * cellSize;
        for (let c = 0; c < width; c++) {
          const v = d[r * width + c];
          if (!(Math.abs(v) >= 0.02)) continue; // NaN and on-grade move no soil worth drawing
          const x = originX + (c + 0.5) * cellSize;
          if (v > 0) {
            cv += v;
            cx += v * x;
            cy += v * y;
          } else {
            fv -= v;
            fx -= v * x;
            fy -= v * y;
          }
        }
      }
      if (cv > 0 && fv > 0) {
        const a = { x: cx / cv, y: cy / cv };
        const b = { x: fx / fv, y: fy / fv };
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > 4 * cellSize) {
          const ux = (b.x - a.x) / len;
          const uy = (b.y - a.y) / len;
          const head = Math.min(len * 0.3, Math.max(8, len * 0.12));
          const ll = (x: number, y: number): GeoJSON.Position => {
            const q = lambert93ToLngLat({ x, y });
            return [q.lng, q.lat];
          };
          const neck = { x: b.x - ux * head, y: b.y - uy * head };
          data.haul = collection([
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "LineString",
                coordinates: [ll(a.x, a.y), ll(neck.x, neck.y)],
              },
            },
            {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    ll(b.x, b.y),
                    ll(neck.x - uy * head * 0.45, neck.y + ux * head * 0.45),
                    ll(neck.x + uy * head * 0.45, neck.y - ux * head * 0.45),
                    ll(b.x, b.y),
                  ],
                ],
              },
            },
          ]);
        }
      }
    }
    setSourceData("sd-haul", data.haul);
  };

  const drawFall = () => {
    if (!w || !last || last.fall.slopePct < 0.005 || st.mode === "fit") {
      data.fall = collection();
    } else {
      const c = lambert93ToLngLat({ x: last.plane.x0, y: last.plane.y0 });
      const size = Math.sqrt(w.areaM2);
      data.fall = collection(
        arrow(c, last.fall.fallDeg, Math.min(380, size * 0.42)),
      );
    }
    setSourceData("sd-fall", data.fall);
  };

  let labels: maplibregl.Marker[] = [];
  /**
   * Heights of the ground contours on the map (m NGF-IGN69): each level once,
   * the heavy levels first, at the first spot along its lines (longest
   * first) that overlaps no label already placed at this camera.
   */
  const drawLabels = () => {
    for (const m of labels) m.remove();
    labels = [];
    if (!st.showContours || !w) return;
    const byLevel = new Map<
      number,
      { lines: GeoJSON.Position[][]; major: boolean }
    >();
    for (const f of existContours) {
      if (f.geometry.type !== "LineString" || f.geometry.coordinates.length < 2)
        continue;
      const level = Number(f.properties?.level);
      const entry = byLevel.get(level) ?? {
        lines: [],
        major: !!f.properties?.major,
      };
      entry.lines.push(f.geometry.coordinates);
      byLevel.set(level, entry);
    }
    const order = [...byLevel.entries()]
      .map(([level, e]) => ({
        level,
        major: e.major,
        lines: e.lines.sort((a, b) => b.length - a.length).slice(0, 6),
      }))
      .sort(
        (a, b) =>
          Number(b.major) - Number(a.major) ||
          b.lines[0].length - a.lines[0].length,
      );
    const placed: { x: number; y: number }[] = [];
    const SPOTS = [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875];
    for (const { level, lines } of order) {
      if (labels.length >= MAX_LABELS) break;
      let at: GeoJSON.Position | null = null;
      for (const c of lines) {
        for (const along of SPOTS) {
          const q = c[Math.floor((c.length - 1) * along)];
          const p = map.project([q[0], q[1]]);
          if (
            placed.some(
              (o) => Math.abs(o.x - p.x) < 40 && Math.abs(o.y - p.y) < 16,
            )
          )
            continue;
          placed.push(p);
          at = q;
          break;
        }
        if (at) break;
      }
      if (!at) continue;
      const el = document.createElement("div");
      el.className = "gx-clabel";
      el.textContent = signedFixed(level, 2);
      // Visual only (the readout gives heights): not a "Map marker" button.
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("role", "presentation");
      el.setAttribute("aria-label", "");
      labels.push(
        new maplibregl.Marker({ element: el })
          .setLngLat([at[0], at[1]])
          .addTo(map),
      );
    }
  };
  for (const ev of ["zoomend", "rotateend", "pitchend"] as const)
    map.on(ev, drawLabels);

  const pushContours = () => {
    data.contours = collection(
      st.showContours ? [...existContours, ...designContours] : [],
    );
    setSourceData("sd-contours", data.contours);
    ui.contourRow.hidden = !st.showContours || !w;
    drawLabels();
  };

  const computeExistContours = () => {
    existContours = [];
    intervalUsed = 0;
    contourNote = "";
    if (!w) return;
    const { width, height, cellSize } = w.grid;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of w.grid.data)
      if (!Number.isNaN(v)) [lo, hi] = [Math.min(lo, v), Math.max(hi, v)];
    if (!Number.isFinite(lo)) return;
    intervalUsed =
      st.interval === "auto" ? autoInterval(lo, hi, 14) : st.interval;
    ui.intervalAuto.textContent =
      st.interval === "auto" ? `Auto · ${lengthText(intervalUsed)}` : "Auto";
    ui.major.textContent = `· heavy every ${lengthText(intervalUsed * MAJOR_EVERY)}`;
    // About 2 m of smoothing: LiDAR texture would otherwise fray every line.
    const radius = Math.max(1, Math.round(2 / cellSize));
    const smooth = smoothValues(w.grid.data, width, height, radius);
    try {
      existContours = contourLines(w.grid, smooth, {
        interval: intervalUsed,
        majorEvery: MAJOR_EVERY,
      }).map((f) => ({ ...f, properties: { ...f.properties, kind: "exist" } }));
    } catch (e) {
      if (e instanceof RangeError) {
        contourNote =
          "Contours are too dense at this interval; choose a larger one.";
      } else throw e;
    }
  };

  const computeDesignContours = () => {
    designContours = [];
    if (!w || !last || !intervalUsed) return;
    const g = designGrid(w, last.plane);
    try {
      designContours = contourLines(g, g.data, {
        interval: intervalUsed,
        majorEvery: MAJOR_EVERY,
      }).map((f) => ({
        ...f,
        properties: { ...f.properties, kind: "design" },
      }));
    } catch {
      designContours = [];
    }
  };

  /**
   * Removes the cut/fill image. MapLibre keeps an image source's old picture
   * and corners until the new one has loaded, which can wait behind live tile
   * requests: a new field starts from no image rather than the last field's.
   */
  const dropRaster = () => {
    if (map.getLayer("sd-cutfill")) map.removeLayer("sd-cutfill");
    if (map.getSource("sd-cutfill")) map.removeSource("sd-cutfill");
  };

  let mapShown = false;
  const setRasterVisibility = () => {
    const on = !!(st.showMap && w);
    if (map.getLayer("sd-cutfill"))
      map.setLayoutProperty(
        "sd-cutfill",
        "visibility",
        on ? "visible" : "none",
      );
    if (on !== mapShown) {
      mapShown = on;
      ctx.onMapShown?.(on);
    }
  };

  /**
   * The cut/fill key: the map's own colours along −maxM … +maxM, each band to
   * scale (read with rampColor, so key and map cannot disagree), the class
   * edges printed under it, and the ends saying where the colour saturates.
   */
  const renderLegend = () => {
    if (!style || !w) {
      ui.legend.replaceChildren();
      return;
    }
    const cs = style;
    const { maxM, bandM, onGradeM } = cs;
    // Past ±maxM the map paints one saturated colour: a cap at each end.
    const cap = Math.max(bandM, maxM * 0.08);
    const end = maxM + cap;
    const pct = (d: number) => ((d + end) / (2 * end)) * 100;
    const edges = [-end, -maxM, 0, maxM, end];
    if (onGradeM > 0) edges.push(-onGradeM, onGradeM);
    if (bandM > 0)
      for (let e = bandM; e < maxM - 1e-6; e += bandM) edges.push(e, -e);
    edges.sort((a, b) => a - b);
    const cuts = edges.filter((v, i) => i === 0 || v - edges[i - 1] > 1e-6);
    const stops: string[] = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [r, g, b, a] = rampColor(
        CUT_FILL_RAMP,
        cs,
        (cuts[i] + cuts[i + 1]) / 2,
      );
      const c = `rgb(${r} ${g} ${b} / ${(a / 255).toFixed(3)})`;
      stops.push(
        `${c} ${pct(cuts[i]).toFixed(2)}%`,
        `${c} ${pct(cuts[i + 1]).toFixed(2)}%`,
      );
    }
    const m2 = (d: number) => d.toFixed(2);
    const bar = document.createElement("div");
    bar.className = "cf-bar";
    bar.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
    bar.setAttribute("role", "img");
    bar.setAttribute(
      "aria-label",
      `Cut and fill colours: fill on the left, deepest from ${m2(maxM)} m; on grade within ${Math.round(onGradeM * 100)} cm in the middle; cut on the right, deepest from ${m2(maxM)} m.`,
    );
    // Class edges inside the bar, mirrored on both sides; a bare mark
    // where the saturated caps begin (their depth is in the end labels).
    const inner = legendStops(CUT_FILL_RAMP, cs)
      .map((t) => t.from)
      .filter((d) => d > onGradeM + 1e-6 && d < maxM - 1e-6);
    const ticks = document.createElement("div");
    ticks.className = "cf-ticks";
    ticks.setAttribute("aria-hidden", "true");
    for (const [d, text] of [
      ...inner.flatMap((v): [number, string][] => [
        [-v, m2(v)],
        [v, m2(v)],
      ]),
      [-maxM, ""],
      [maxM, ""],
    ] as [number, string][]) {
      const t = document.createElement("span");
      t.style.left = `${pct(d).toFixed(2)}%`;
      t.textContent = text;
      ticks.append(t);
    }
    const scale = document.createElement("div");
    scale.className = "cf-scale";
    scale.setAttribute("aria-hidden", "true");
    for (const text of [
      `FILL ≥ ${m2(maxM)} m`,
      `ON GRADE ±${Math.round(onGradeM * 100)} cm`,
      `CUT ≥ ${m2(maxM)} m`,
    ]) {
      const t = document.createElement("span");
      t.textContent = text;
      scale.append(t);
    }
    ui.legend.replaceChildren(bar, ticks, scale);
  };

  const renderRaster = async () => {
    const seq = ++rasterSeq;
    if (!w || !last) {
      setRasterVisibility();
      return;
    }
    const { width, height } = w.grid;
    style = {
      bandM: 0.05,
      maxM: autoMaxDepth(last.works.depth),
      onGradeM: ON_GRADE_M,
      alpha: 1,
    };
    renderLegend();
    const rgba = cutFillRgba(
      last.works.depth,
      width,
      height,
      CUT_FILL_RAMP,
      style,
    );
    const png = await toPng(rgba, width, height);
    if (seq !== rasterSeq || !w) return;
    pngs.clear();
    pngs.set(seq, png);
    const url = `sillon://cutfill/${seq}/0/0`;
    const coordinates = windowCorners(w.grid);
    whenStyleReady(() => {
      const src = map.getSource("sd-cutfill") as ImageSource | undefined;
      if (src) src.updateImage({ url, coordinates });
      else {
        map.addSource("sd-cutfill", { type: "image", url, coordinates });
        map.addLayer(
          {
            id: "sd-cutfill",
            type: "raster",
            source: "sd-cutfill",
            paint: {
              "raster-opacity": 0.88,
              "raster-resampling": "nearest",
              "raster-fade-duration": 0,
            },
          },
          map.getLayer("sd-contour-exist") ? "sd-contour-exist" : undefined,
        );
      }
      setRasterVisibility();
    });
  };

  // ── Design ──
  const specOf = (): DesignSpec =>
    st.mode === "fit"
      ? { mode: "fit" }
      : st.mode === "level"
        ? { mode: "level" }
        : {
            mode: "slope",
            mainPct: st.mainPct,
            bearingDeg: st.bearingDeg,
            crossPct: st.crossPct,
          };

  const naturalFall = () => {
    if (!fit || !w) return { pct: 0, deg: 0 };
    return {
      pct: Math.round(fit.slopePct * w.k * 100) / 100,
      deg: Math.round(fit.fallDeg) % 360,
    };
  };

  const syncInputs = () => {
    for (const [b, m] of [
      [ui.fit, "fit"],
      [ui.slope, "slope"],
      [ui.level, "level"],
    ] as const) {
      b.setAttribute("aria-pressed", String(st.mode === m));
      b.classList.toggle("on", st.mode === m);
    }
    ui.slopeBox.hidden = st.mode !== "slope";
    if (document.activeElement !== ui.main)
      ui.main.value = st.mainPct.toFixed(2);
    if (document.activeElement !== ui.bearing)
      ui.bearing.value = String(Math.round(st.bearingDeg));
    if (document.activeElement !== ui.cross)
      ui.cross.value = st.crossPct.toFixed(2);
    ui.compass.textContent = compassPoint(st.bearingDeg);
    ui.offsetOut.textContent = `${st.offsetCm > 0 ? "+" : st.offsetCm < 0 ? "−" : "±"}${Math.abs(st.offsetCm)} cm`;
    ui.offset.setAttribute(
      "aria-valuetext",
      st.offsetCm > 0
        ? `raised ${st.offsetCm} cm`
        : st.offsetCm < 0
          ? `lowered ${-st.offsetCm} cm`
          : "as balanced",
    );
    ui.showMap.checked = st.showMap;
    ui.showContours.checked = st.showContours;
  };

  let pending = 0;
  /** Recompute after input settles: balancing a large field takes a moment. */
  const schedule = (contoursToo = false) => {
    window.clearTimeout(pending);
    pending = window.setTimeout(() => compute(contoursToo), 90);
  };

  const compute = (contoursToo = false) => {
    if (!w) return;
    const spec = specOf();
    const res = design(
      w,
      spec,
      { ratio: st.ratio, offsetM: st.offsetCm / 100 },
      fit,
    );
    // Both are lower bounds on the mean haul; the larger is the better one.
    const haulMeanM = Math.max(
      transportHaulM(w, res.works.depth),
      res.works.haulM,
    );
    last = { ...res, spec, ratio: st.ratio, offsetCm: st.offsetCm, haulMeanM };
    if (contoursToo) computeExistContours();
    computeDesignContours();
    renderWorks();
    drawFall();
    drawHaul();
    pushContours();
    void renderRaster();
    showNote();
    ui.sheet.disabled = false;
    // One polite line for screen readers: the table itself changes silently.
    ui.live.textContent = `Cut ${whole(last.works.cutM3)} m³, fill ${whole(last.works.fillM3)} m³, ${balanceText(last)}.`;
  };

  // ── Inputs ──
  const setMode = (mode: SurfaceMode) => {
    if (mode === "slope" && st.mode !== "slope") {
      const nat = naturalFall();
      if (st.mainPct === 0 && st.bearingDeg === 0) {
        st.mainPct = nat.pct;
        st.bearingDeg = nat.deg;
      }
    }
    st.mode = mode;
    syncInputs();
    schedule();
  };
  ui.fit.addEventListener("click", () => setMode("fit"));
  ui.slope.addEventListener("click", () => setMode("slope"));
  ui.level.addEventListener("click", () => setMode("level"));
  const readNumber = (el: HTMLInputElement, lo: number, hi: number) => {
    const v = Number(el.value.replace(",", "."));
    return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;
  };
  ui.main.addEventListener("input", () => {
    const v = readNumber(ui.main, -10, 10);
    if (v === null) return;
    st.mainPct = v;
    slopeTouched = true;
    schedule();
  });
  ui.bearing.addEventListener("input", () => {
    const v = readNumber(ui.bearing, -360, 720);
    if (v === null) return;
    st.bearingDeg = ((v % 360) + 360) % 360;
    ui.compass.textContent = compassPoint(st.bearingDeg);
    slopeTouched = true;
    schedule();
  });
  ui.cross.addEventListener("input", () => {
    const v = readNumber(ui.cross, -10, 10);
    if (v === null) return;
    st.crossPct = v;
    slopeTouched = true;
    schedule();
  });
  for (const el of [ui.main, ui.bearing, ui.cross])
    el.addEventListener("change", syncInputs);
  ui.natural.addEventListener("click", () => {
    const nat = naturalFall();
    st.mainPct = nat.pct;
    st.bearingDeg = nat.deg;
    st.crossPct = 0;
    slopeTouched = false;
    syncInputs();
    schedule();
  });
  ui.ratio.addEventListener("change", () => {
    st.ratio = Number(ui.ratio.value) || 1;
    schedule();
  });
  ui.offset.addEventListener("input", () => {
    st.offsetCm = Number(ui.offset.value) || 0;
    syncInputs();
    schedule();
  });
  ui.showMap.addEventListener("change", () => {
    st.showMap = ui.showMap.checked;
    setRasterVisibility();
    drawHaul();
  });
  ui.showContours.addEventListener("change", () => {
    st.showContours = ui.showContours.checked;
    pushContours();
  });
  ui.interval.addEventListener("change", () => {
    st.interval =
      ui.interval.value === "auto" ? "auto" : Number(ui.interval.value) / 100;
    if (!w) return;
    computeExistContours();
    computeDesignContours();
    pushContours();
    showNote();
  });

  // ── Cut sheet ──
  /** Stakes on a square Lambert-93 lattice inside the field, with cut (+) or fill (−). */
  const cutSheet = () => {
    if (!w || !last) return "";
    const plane = last.plane;
    const { originX, originY, cellSize, width, height } = w.grid;
    const spacing = stakeSpacing(w);
    // A 20 m context grid does not know heights to the millimetre.
    const dp = w.grid.cellSize >= 5 ? 2 : 3;
    const rows = [
      "stake,easting_l93,northing_l93,lng,lat,existing_ngf69_m,design_ngf69_m,cut_m",
    ];
    let n = 0;
    const x0 = Math.ceil(originX / spacing) * spacing;
    const y0 = Math.floor(originY / spacing) * spacing;
    for (let y = y0; y > originY - height * cellSize; y -= spacing) {
      for (let x = x0; x < originX + width * cellSize; x += spacing) {
        const col = Math.floor((x - originX) / cellSize);
        const row = Math.floor((originY - y) / cellSize);
        if (col < 0 || row < 0 || col >= width || row >= height) continue;
        if (!w.inside[row * width + col]) continue;
        const e = sampleGrid(w.grid, { x, y });
        if (Number.isNaN(e)) continue;
        const d = designHeight(plane, x, y);
        const { lng, lat } = lambert93ToLngLat({ x, y });
        n++;
        // Rounded first, so cut = existing − design as printed, never "-0.00".
        const r = (v: number) => Number(v.toFixed(dp)) + 0;
        const eR = r(e);
        const dR = r(d);
        const fmt = (v: number) =>
          (Math.abs(v) < 10 ** -dp / 2 ? 0 : v).toFixed(dp);
        rows.push(
          `${n},${x.toFixed(1)},${y.toFixed(1)},${lng.toFixed(7)},${lat.toFixed(7)},${fmt(eR)},${fmt(dR)},${fmt(r(eR - dR))}`,
        );
      }
    }
    return rows.join("\n");
  };
  ui.sheet.addEventListener("click", () => {
    const csv = cutSheet();
    if (!csv) return;
    void ctx.offerFile(
      `${ctx.fieldStem()}-cut-sheet-${w ? stakeSpacing(w) : 10}m.csv`,
      csv,
    );
  });

  // ── API ──
  /**
   * Shows the design for a field window. `owner` names the field (fields.ts
   * designKey): measured again (another data source, an edited outline), the
   * same field keeps the offset and any slope the viewer typed, while an
   * untouched slope follows the new grid's natural fall; any other field
   * starts from its own natural fall.
   */
  const setField = (window_: FieldWindow | null, why = "", owner?: number) => {
    if (window_ && window_.validCount < MIN_DESIGN_CELLS) {
      message(
        ["Too few heights inside this field to design it.", why]
          .filter(Boolean)
          .join(" "),
      );
      return;
    }
    w = window_;
    baseNote = why;
    contourNote = "";
    last = null;
    rasterSeq++;
    dropRaster();
    ui.section.hidden = !w;
    ui.design.hidden = !w;
    ui.sheet.disabled = true;
    if (!w) {
      fit = null;
      existContours = [];
      designContours = [];
      style = null;
      pushContours();
      data.fall = collection();
      setSourceData("sd-fall", data.fall);
      data.haul = collection();
      setSourceData("sd-haul", data.haul);
      setRasterVisibility();
      renderWorks();
      renderLegend();
      showNote();
      return;
    }
    // Volumes come from the cells with heights only: say so when some lack one.
    const cover = (w.validCount * w.cellArea) / w.areaM2;
    if (cover < 0.98)
      baseNote = [
        baseNote,
        `Heights cover ${Math.floor(cover * 100)} % of the field; volumes count that part only.`,
      ]
        .filter(Boolean)
        .join(" ");
    ui.sheetNote.textContent = `Stakes every ${stakeSpacing(w)} m · heights m NGF-IGN69 · cut +, fill − · from the ${w.grid.cellSize} m grid`;
    fit = robustFit(w);
    const keep = owner !== undefined && owner === designOwner;
    const nat = naturalFall();
    if (!keep) {
      st.crossPct = 0;
      st.offsetCm = 0;
      ui.offset.value = "0";
      slopeTouched = false;
      designOwner = owner;
    }
    if (!slopeTouched) {
      st.mainPct = nat.pct;
      st.bearingDeg = nat.deg;
    }
    syncInputs();
    compute(true);
  };

  /**
   * The section with a message and no design: while the field's grid is on
   * its way (Live IGN), or when it holds too few heights.
   */
  const message = (text: string) => {
    w = null;
    last = null;
    rasterSeq++;
    dropRaster();
    ui.section.hidden = false;
    ui.design.hidden = true;
    ui.works.replaceChildren();
    ui.legend.replaceChildren();
    ui.live.textContent = "";
    ui.sheetNote.textContent = "";
    baseNote = text;
    contourNote = "";
    showNote();
    ui.sheet.disabled = true;
    existContours = [];
    designContours = [];
    pushContours();
    data.fall = collection();
    setSourceData("sd-fall", data.fall);
    data.haul = collection();
    setSourceData("sd-haul", data.haul);
    setRasterVisibility();
  };

  /** Cut or fill under the cursor, for the readout; null outside the field. */
  const describeAt = (p: LngLat): string | null => {
    if (!w || !last) return null;
    const { x, y } = lngLatToLambert93(p);
    const { originX, originY, cellSize, width, height } = w.grid;
    const col = Math.floor((x - originX) / cellSize);
    const row = Math.floor((originY - y) / cellSize);
    if (col < 0 || row < 0 || col >= width || row >= height) return null;
    const i = row * width + col;
    if (!w.inside[i]) return null;
    // The cell the map paints here, judged as the painter and the areas do
    // (its centre's depth, the same edge slack); its figures to the
    // centimetre, so the printed cut is ground − design exactly.
    const depth = last.works.depth[i];
    const e = w.grid.data[i];
    if (Number.isNaN(depth) || Number.isNaN(e)) return null;
    const ground = Math.round(e * 100) / 100;
    const z = Math.round((e - depth) * 100) / 100;
    const d = Math.round((ground - z) * 100) / 100;
    const tag =
      Math.abs(depth) < ON_GRADE_M - EDGE_SLACK_M
        ? `ON GRADE ±${ON_GRADE_M * 100} cm`
        : depth > 0
          ? `CUT ${Math.abs(d).toFixed(2)} m`
          : `FILL ${Math.abs(d).toFixed(2)} m`;
    return `${tag} · ground ${fmtHeight(ground)} · design ${fmtHeight(z)}`;
  };

  /** Design summary for exports (GeoJSON properties, shapefile columns). */
  const summary = () => {
    if (!last || !w) return null;
    const { spec, plane, fall } = last;
    const flat = fall.slopePct < 0.005;
    return {
      design:
        spec.mode === "fit"
          ? "natural fall"
          : spec.mode === "level"
            ? "dead level"
            : "set slope",
      designSlopePct: Math.round(fall.slopePct * 1000) / 1000,
      designToward: flat ? null : compassPoint(fall.fallDeg),
      /** Bearing of the fall, degrees clockwise from Lambert-93 grid north. */
      designFallDeg: flat ? null : Math.round(fall.fallDeg * 10) / 10,
      crossPct: spec.mode === "slope" ? spec.crossPct : null,
      offsetCm: last.offsetCm,
      /** The design passes through (x, y, z): Lambert-93 m, NGF-IGN69 m. */
      designX: Math.round(plane.x0 * 100) / 100,
      designY: Math.round(plane.y0 * 100) / 100,
      designZ: Math.round(plane.z0 * 1000) / 1000,
      cutM3: Math.round(last.works.cutM3),
      fillM3: Math.round(last.works.fillM3),
      ratioTarget: last.ratio,
    };
  };

  syncInputs();
  return {
    setField,
    message,
    describeAt,
    summary,
    /** After a style rebuild: put the cut/fill image back if there is one. */
    restyle: () => void renderRaster(),
  };
};

export type Surface = ReturnType<typeof installSurface>;
