import type {
  GeoJSONSource,
  ImageSource,
  LayerSpecification,
  Map as MapLibreMap,
  SourceSpecification,
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
import { height as fmtHeight, grouped } from "./units";

/*
 * Surface design: the field's target surface (its natural fall, a slope
 * set by hand, or dead level), balanced to a cut:fill ratio, with the
 * earthworks it implies, a cut/fill map, contours of the ground and of
 * the design, and a cut sheet of stakes for the contractor.
 */

export type SurfaceMode = "fit" | "slope" | "level";

/** Fewer heights than this inside a field and no design is offered. */
const MIN_DESIGN_CELLS = 12;

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
   * Runs `fn` once the style's layers exist. Not isStyleLoaded(): that stays
   * false while any tile is still loading, and "style.load" never fires again.
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
          ? `${k.ratio.toFixed(2)} · target ${st.ratio.toFixed(2)}`
          : "all cut",
      ],
      [
        "Balance",
        Math.abs(k.netM3) < 0.5
          ? "balanced"
          : k.netM3 > 0
            ? `${whole(k.netM3)} m³ surplus to haul off`
            : `${whole(-k.netM3)} m³ to bring in`,
      ],
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
   * The mean haul. A lower bound ("≥") when cut and fill balance; with a
   * surplus or a shortfall part of the soil leaves or arrives by road, so the
   * figure is only an estimate ("≈"). The centres' distance is added when it
   * says something else: the net direction the soil travels.
   */
  const haulText = (r: SurfaceResult) => {
    const k = r.works;
    if (!(r.haulMeanM > 0)) return "–";
    const balanced = Math.abs(k.netM3) <= 0.02 * Math.max(k.cutM3, k.fillM3);
    const mean = `${balanced ? "≥" : "≈"} ${whole(r.haulMeanM)} m mean`;
    return k.haulM < 0.9 * r.haulMeanM
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

  const pushContours = () => {
    data.contours = collection(
      st.showContours ? [...existContours, ...designContours] : [],
    );
    setSourceData("sd-contours", data.contours);
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
    // About 2 m of smoothing: LiDAR texture would otherwise fray every line.
    const radius = Math.max(1, Math.round(2 / cellSize));
    const smooth = smoothValues(w.grid.data, width, height, radius);
    try {
      existContours = contourLines(w.grid, smooth, {
        interval: intervalUsed,
        majorEvery: 5,
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
        majorEvery: 5,
      }).map((f) => ({
        ...f,
        properties: { ...f.properties, kind: "design" },
      }));
    } catch {
      designContours = [];
    }
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

  const renderLegend = () => {
    if (!style || !w) {
      ui.legend.replaceChildren();
      return;
    }
    const stops = legendStops(CUT_FILL_RAMP, style);
    const bar = document.createElement("div");
    bar.className = "cf-bar";
    for (const s of stops) {
      const sw = document.createElement("span");
      sw.style.background = s.color;
      sw.title = s.label;
      bar.append(sw);
    }
    const scale = document.createElement("div");
    scale.className = "cf-scale";
    const first = stops[0];
    const lastStop = stops[stops.length - 1];
    for (const text of [
      `fill ${first ? first.label.replace("−", "") : ""}`,
      "on grade",
      `cut ${lastStop ? lastStop.label.replace("+", "") : ""}`,
    ]) {
      const t = document.createElement("span");
      t.textContent = text;
      scale.append(t);
    }
    ui.legend.replaceChildren(bar, scale);
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
      onGradeM: 0.02,
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
    last = { ...res, spec, ratio: st.ratio, haulMeanM };
    if (contoursToo) computeExistContours();
    computeDesignContours();
    renderWorks();
    drawFall();
    drawHaul();
    pushContours();
    void renderRaster();
    showNote();
    ui.sheet.disabled = false;
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
    schedule();
  });
  ui.bearing.addEventListener("input", () => {
    const v = readNumber(ui.bearing, -360, 720);
    if (v === null) return;
    st.bearingDeg = ((v % 360) + 360) % 360;
    ui.compass.textContent = compassPoint(st.bearingDeg);
    schedule();
  });
  ui.cross.addEventListener("input", () => {
    const v = readNumber(ui.cross, -10, 10);
    if (v === null) return;
    st.crossPct = v;
    schedule();
  });
  for (const el of [ui.main, ui.bearing, ui.cross])
    el.addEventListener("change", syncInputs);
  ui.natural.addEventListener("click", () => {
    const nat = naturalFall();
    st.mainPct = nat.pct;
    st.bearingDeg = nat.deg;
    st.crossPct = 0;
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
    const spacing = w.areaM2 > 500_000 ? 20 : 10;
    const rows = [
      "stake,easting_l93,northing_l93,lng,lat,existing_m,design_m,cut_m",
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
        rows.push(
          `${n},${x.toFixed(1)},${y.toFixed(1)},${lng.toFixed(7)},${lat.toFixed(7)},${e.toFixed(3)},${d.toFixed(3)},${(e - d).toFixed(3)}`,
        );
      }
    }
    return rows.join("\n");
  };
  ui.sheet.addEventListener("click", () => {
    const csv = cutSheet();
    if (!csv) return;
    void ctx.offerFile(`${ctx.fieldStem()}-cut-sheet.csv`, csv);
  });

  // ── API ──
  const setField = (window_: FieldWindow | null, why = "") => {
    if (window_ && window_.validCount < MIN_DESIGN_CELLS) {
      message(why || "Too few heights inside this field to design it.");
      return;
    }
    w = window_;
    baseNote = why;
    contourNote = "";
    last = null;
    rasterSeq++;
    ui.section.hidden = !w;
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
    fit = robustFit(w);
    const nat = naturalFall();
    st.mainPct = nat.pct;
    st.bearingDeg = nat.deg;
    st.crossPct = 0;
    st.offsetCm = 0;
    ui.offset.value = "0";
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
    ui.section.hidden = false;
    ui.works.replaceChildren();
    ui.legend.replaceChildren();
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
    const e = sampleGrid(w.grid, { x, y });
    if (Number.isNaN(e)) return null;
    const z = designHeight(last.plane, x, y);
    const d = e - z;
    const tag =
      Math.abs(d) < 0.02
        ? "ON GRADE"
        : d > 0
          ? `CUT ${d.toFixed(2)} m`
          : `FILL ${(-d).toFixed(2)} m`;
    return `${tag} · ground ${fmtHeight(e)} · design ${fmtHeight(z)}`;
  };

  /** Design summary for exports (GeoJSON properties, shapefile columns). */
  const summary = () => {
    if (!last || !w) return null;
    return {
      design:
        st.mode === "fit"
          ? "natural fall"
          : st.mode === "level"
            ? "dead level"
            : "set slope",
      designSlopePct: Math.round(last.fall.slopePct * 1000) / 1000,
      designToward:
        last.fall.slopePct < 0.005 ? null : compassPoint(last.fall.fallDeg),
      cutM3: Math.round(last.works.cutM3),
      fillM3: Math.round(last.works.fillM3),
      ratioTarget: st.ratio,
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
