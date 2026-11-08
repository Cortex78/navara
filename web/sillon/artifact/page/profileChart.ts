import type { ProfileSample } from "../../src/dem/profile";

const SVG = "http://www.w3.org/2000/svg";

const el = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
  parent?: Element,
) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
};

/** A 1-2-5 step giving about `count` intervals over `span`. */
const niceStep = (span: number, count: number) => {
  const raw = span / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
};

const ticks = (lo: number, hi: number, count: number) => {
  const step = niceStep(Math.max(hi - lo, 1e-6), count);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step)
    out.push(Number(v.toFixed(10)));
  return { step, values: out };
};

const decimals = (step: number) =>
  Math.max(0, Math.min(3, -Math.floor(Math.log10(step) + 1e-9)));

export const formatDistance = (m: number) =>
  m >= 2000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;

/**
 * Draws an elevation profile as inline SVG in `host`, redrawn at the
 * host's width. `onHover` gets the sample under the pointer, or null.
 * Returns a function that removes the chart.
 */
export const drawProfileChart = (
  host: HTMLElement,
  samples: ProfileSample[],
  onHover: (s: ProfileSample | null) => void,
): (() => void) => {
  const valid = samples.filter((s) => !Number.isNaN(s.h));
  if (valid.length < 2) {
    host.textContent = "No heights along this line.";
    return () => (host.textContent = "");
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of valid) [lo, hi] = [Math.min(lo, s.h), Math.max(hi, s.h)];
  // Keep a little air, and never zoom a flat line into noise: at least 0.5 m.
  const pad = Math.max((hi - lo) * 0.08, (0.5 - (hi - lo)) / 2, 0.05);
  lo -= pad;
  hi += pad;
  const length = samples[samples.length - 1].d;

  let svg: SVGSVGElement | null = null;
  const draw = () => {
    svg?.remove();
    const width = Math.max(240, host.clientWidth);
    const height = Math.max(120, host.clientHeight || 150);
    const m = { left: 44, right: 10, top: 8, bottom: 22 };
    const w = width - m.left - m.right;
    const h = height - m.top - m.bottom;
    const x = (d: number) => m.left + (d / length) * w;
    const y = (v: number) => m.top + (1 - (v - lo) / (hi - lo)) * h;
    svg = el("svg", {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      class: "chart",
      role: "img",
      "aria-label": `Elevation profile over ${formatDistance(length)}, from ${valid[0].h.toFixed(2)} m to ${valid[valid.length - 1].h.toFixed(2)} m`,
    });

    const yt = ticks(lo, hi, 4);
    const yd = decimals(yt.step);
    for (const v of yt.values) {
      el(
        "line",
        { x1: m.left, x2: m.left + w, y1: y(v), y2: y(v), class: "grid" },
        svg,
      );
      const t = el(
        "text",
        { x: m.left - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" },
        svg,
      );
      t.textContent = v.toFixed(yd);
    }
    const xt = ticks(0, length, Math.max(2, Math.floor(w / 90)));
    // The last tick gives way to the unit label at the right end.
    for (const v of xt.values.filter((v) => x(v) < m.left + w - 22)) {
      const t = el(
        "text",
        { x: x(v), y: m.top + h + 16, class: "tick", "text-anchor": "middle" },
        svg,
      );
      t.textContent =
        length >= 2000
          ? `${(v / 1000).toFixed(decimals(xt.step / 1000))}`
          : `${v}`;
    }
    const unit = el(
      "text",
      {
        x: m.left + w,
        y: m.top + h + 16,
        class: "tick unit",
        "text-anchor": "end",
      },
      svg,
    );
    unit.textContent = length >= 2000 ? "km" : "m";

    // One path per run of valid heights; gaps stay open.
    let line = "";
    let area = "";
    let run: ProfileSample[] = [];
    const flush = () => {
      if (run.length > 1) {
        const pts = run.map((s) => `${x(s.d).toFixed(1)},${y(s.h).toFixed(1)}`);
        line += `M${pts.join("L")}`;
        area += `M${x(run[0].d).toFixed(1)},${m.top + h}L${pts.join("L")}L${x(run[run.length - 1].d).toFixed(1)},${m.top + h}Z`;
      }
      run = [];
    };
    for (const s of samples) {
      if (Number.isNaN(s.h)) flush();
      else run.push(s);
    }
    flush();
    el("path", { d: area, class: "area" }, svg);
    el("path", { d: line, class: "line" }, svg);

    const cursor = el("g", { class: "cursor", visibility: "hidden" }, svg);
    const cl = el("line", { y1: m.top, y2: m.top + h, x1: 0, x2: 0 }, cursor);
    const dot = el("circle", { r: 4, cx: 0, cy: 0 }, cursor);
    const label = el(
      "text",
      { x: 0, y: m.top + 12, class: "cursor-label" },
      cursor,
    );
    const hit = el(
      "rect",
      { x: m.left, y: m.top, width: w, height: h, fill: "transparent" },
      svg,
    );

    const at = (clientX: number) => {
      const r = hit.getBoundingClientRect();
      const d = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * length;
      let a = 0;
      let b = samples.length - 1;
      while (b - a > 1) {
        const mid = (a + b) >> 1;
        if (samples[mid].d < d) a = mid;
        else b = mid;
      }
      return d - samples[a].d < samples[b].d - d ? samples[a] : samples[b];
    };
    const show = (s: ProfileSample) => {
      const px = x(s.d);
      cursor.setAttribute("visibility", "visible");
      cl.setAttribute("x1", String(px));
      cl.setAttribute("x2", String(px));
      const ok = !Number.isNaN(s.h);
      dot.setAttribute("visibility", ok ? "visible" : "hidden");
      if (ok) {
        dot.setAttribute("cx", String(px));
        dot.setAttribute("cy", String(y(s.h)));
      }
      const right = px > m.left + w * 0.6;
      label.setAttribute("x", String(px + (right ? -6 : 6)));
      label.setAttribute("text-anchor", right ? "end" : "start");
      label.textContent = `${formatDistance(s.d)} · ${ok ? `${s.h.toFixed(2)} m` : "no data"}`;
      onHover(s);
    };
    hit.addEventListener("pointermove", (e) => show(at(e.clientX)));
    hit.addEventListener("pointerdown", (e) => show(at(e.clientX)));
    hit.addEventListener("pointerleave", () => {
      cursor.setAttribute("visibility", "hidden");
      onHover(null);
    });
    host.appendChild(svg);
  };
  draw();
  const resize = new ResizeObserver(() => draw());
  resize.observe(host);
  return () => {
    resize.disconnect();
    svg?.remove();
    onHover(null);
  };
};
