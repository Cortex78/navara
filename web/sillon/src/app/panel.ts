import type { ColorMap } from "@navaramap/three";

import type { LidarMode } from "./mapView";

type Handlers = {
  goTo: (query: string) => void;
  imagery: (id: string) => void;
  viewMode: (mode: "plan" | "3d") => void;
  lidarMode: (mode: LidarMode) => void;
  lidarOpacity: (v: number) => void;
  heightStretch: (v: number) => void;
  fitRange: () => void;
  loadGrid: () => void;
  clearGrid: () => void;
};

const LIDAR_MODES: { id: LidarMode; label: string }[] = [
  { id: "hypsometric", label: "Elevation colour (LiDAR HD)" },
  { id: "hillshade", label: "Shaded relief (LiDAR HD)" },
  { id: "ign-shade", label: "IGN shaded relief" },
  { id: "classes", label: "LiDAR point classes" },
  { id: "off", label: "Off — imagery only" },
];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const section = (title: string, ...children: Node[]) =>
  el(
    "section",
    { className: "section" },
    el("h2", { textContent: title }),
    ...children,
  );

/** A labelled control; the `<label>` names the first input or select inside it. */
const field = (label: string, control: Node, value?: HTMLElement) =>
  el(
    "label",
    { className: "field" },
    el("span", { className: "field-label", textContent: label }),
    ...(value ? [value] : []),
    control,
  );

/** A labelled set of buttons. A `<label>` would name only the first button. */
const group = (label: string, ...buttons: HTMLButtonElement[]) => {
  const node = el(
    "div",
    { className: "field" },
    el("span", { className: "field-label", textContent: label }),
    el("div", { className: "row" }, ...buttons),
  );
  node.setAttribute("role", "group");
  node.setAttribute("aria-label", label);
  return node;
};

const gradientCss = (cm: ColorMap) => {
  const flat = cm.flatten();
  const n = flat.length / 4;
  const stops = Array.from({ length: n }, (_, i) => {
    const [r, g, b] = [flat[i * 4], flat[i * 4 + 1], flat[i * 4 + 2]].map((c) =>
      Math.round(c * 255),
    );
    return `rgb(${r} ${g} ${b}) ${((i / (n - 1)) * 100).toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
};

export const buildPanel = (
  root: HTMLElement,
  opts: { imagery: { id: string; label: string }[]; reliefGradient: ColorMap },
) => {
  const handlers: Partial<Handlers> = {};
  const emit = <K extends keyof Handlers>(
    k: K,
    ...args: Parameters<Handlers[K]>
  ) =>
    (handlers[k] as ((...a: Parameters<Handlers[K]>) => void) | undefined)?.(
      ...args,
    );

  // Map
  const search = el("input", {
    type: "search",
    placeholder: "Commune, address, or lat, lng",
  });
  const goBtn = el("button", { textContent: "Go", type: "submit" });
  const form = el("form", { className: "row" }, search, goBtn);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (search.value.trim()) emit("goTo", search.value.trim());
  });
  const imagery = el("select");
  for (const o of opts.imagery)
    imagery.append(el("option", { value: o.id, textContent: o.label }));
  imagery.addEventListener("change", () => emit("imagery", imagery.value));
  const planBtn = el("button", {
    textContent: "Plan",
    className: "seg active",
    type: "button",
  });
  const threeBtn = el("button", {
    textContent: "3D",
    className: "seg",
    type: "button",
  });
  for (const [btn, mode] of [
    [planBtn, "plan"],
    [threeBtn, "3d"],
  ] as const) {
    btn.addEventListener("click", () => {
      planBtn.classList.toggle("active", mode === "plan");
      threeBtn.classList.toggle("active", mode === "3d");
      emit("viewMode", mode);
    });
  }

  // LiDAR
  const mode = el("select");
  for (const m of LIDAR_MODES)
    mode.append(el("option", { value: m.id, textContent: m.label }));
  mode.addEventListener("change", () =>
    emit("lidarMode", mode.value as LidarMode),
  );
  const opacityValue = el("span", {
    className: "field-value",
    textContent: "65%",
  });
  const opacity = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: "65",
  });
  opacity.addEventListener("input", () => {
    opacityValue.textContent = `${opacity.value}%`;
    emit("lidarOpacity", Number(opacity.value) / 100);
  });
  const stretchValue = el("span", {
    className: "field-value",
    textContent: "1×",
  });
  const stretch = el("input", {
    type: "range",
    min: "1",
    max: "30",
    value: "1",
  });
  stretch.addEventListener("input", () => {
    stretchValue.textContent = `${stretch.value}×`;
    emit("heightStretch", Number(stretch.value));
  });
  const legendMin = el("span");
  const legendMax = el("span");
  const fitBtn = el("button", {
    textContent: "Fit to view",
    type: "button",
    className: "link",
  });
  fitBtn.addEventListener("click", () => emit("fitRange"));
  const legend = el(
    "div",
    { className: "legend" },
    el(
      "div",
      { className: "legend-title", textContent: "Elevation, m (NGF-IGN69)" },
      fitBtn,
    ),
    el("div", { className: "legend-bar" }),
    el("div", { className: "legend-range" }, legendMin, legendMax),
  );
  (legend.querySelector(".legend-bar") as HTMLElement).style.background =
    gradientCss(opts.reliefGradient);

  // Data
  const loadBtn = el("button", {
    textContent: "Load LiDAR grid for view",
    type: "button",
    className: "primary",
  });
  loadBtn.addEventListener("click", () => emit("loadGrid"));
  const clearBtn = el("button", { textContent: "Clear", type: "button" });
  clearBtn.addEventListener("click", () => emit("clearGrid"));
  const gridInfo = el("pre", { className: "grid-info" });

  const status = el("div", { className: "status" });
  const panel = el(
    "aside",
    { className: "panel" },
    el(
      "header",
      {},
      el("span", { className: "logo" }),
      el("h1", {}, "Sillon", el("small", { textContent: " LiDAR HD" })),
    ),
    status,
    section(
      "Map",
      field("Go to", form),
      field("Imagery", imagery),
      group("View", planBtn, threeBtn),
    ),
    section(
      "LiDAR",
      field("Rendering", mode),
      field("LiDAR", opacity, opacityValue),
      field("Height stretch", stretch, stretchValue),
      legend,
    ),
    section(
      "Data",
      el("div", { className: "row" }, loadBtn, clearBtn),
      gridInfo,
    ),
  );
  const readout = el("div", { className: "readout", hidden: true });
  const acquisition = el("div", { className: "acquisition" });
  root.append(panel, readout, acquisition);

  return {
    on<K extends keyof Handlers>(event: K, cb: Handlers[K]) {
      handlers[event] = cb;
    },
    setStatus(text: string, kind: "info" | "error" = "info") {
      status.textContent = text;
      status.dataset.kind = kind;
    },
    setReadout(text: string) {
      readout.textContent = text;
      readout.hidden = !text;
    },
    setAcquisition(text: string) {
      acquisition.textContent = text;
    },
    showLegend(show: boolean) {
      legend.hidden = !show;
    },
    setLegendRange(min: number, max: number) {
      legendMin.textContent = min.toFixed(2);
      legendMax.textContent = max.toFixed(2);
    },
    setGridInfo(text: string) {
      gridInfo.textContent = text;
    },
  };
};
