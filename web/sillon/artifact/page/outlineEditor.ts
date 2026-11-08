import maplibregl, {
  type Map as MapLibreMap,
  type MapMouseEvent,
} from "maplibre-gl";

import type { LngLat } from "../../src/geo/lambert93";

export type EditorKind = "polygon" | "line";

export type EditorOptions = {
  kind: EditorKind;
  /** Corners to start from (editing); empty to draw from scratch. */
  points?: LngLat[];
  /** Every change of the corners, including while one is dragged. */
  onChange: (points: LngLat[]) => void;
  /** Asked to finish: a double-click on the map, or a click on the first corner. */
  onFinish: () => void;
};

const isMarkerEvent = (e: MapMouseEvent) =>
  (e.originalEvent.target as Element | null)?.closest?.(".maplibregl-marker") !=
  null;

/**
 * Draws or edits an outline with numbered, draggable corners. A click on
 * the map adds a corner while drawing; a "+" between two corners inserts
 * one; a double-click on a corner removes it. The map's double-click
 * zoom is off while the editor is open.
 */
export class OutlineEditor {
  points: LngLat[];
  private readonly drawing: boolean;
  private markers: maplibregl.Marker[] = [];

  constructor(
    private readonly map: MapLibreMap,
    private readonly opts: EditorOptions,
  ) {
    this.points = [...(opts.points ?? [])];
    this.drawing = this.points.length === 0;
    map.doubleClickZoom.disable();
    map.on("click", this.onClick);
    map.on("dblclick", this.onDblClick);
    map.getCanvas().style.cursor = this.drawing ? "crosshair" : "";
    this.render();
  }

  get closed() {
    return this.opts.kind === "polygon";
  }

  private readonly onClick = (e: MapMouseEvent) => {
    if (!this.drawing || isMarkerEvent(e)) return;
    this.points.push({ lng: e.lngLat.lng, lat: e.lngLat.lat });
    this.render();
  };

  private readonly onDblClick = (e: MapMouseEvent) => {
    if (isMarkerEvent(e)) return;
    e.preventDefault();
    // The double-click's two clicks each placed a corner; keep one.
    if (this.drawing && this.points.length > 1) {
      const [a, b] = this.points.slice(-2);
      const pa = this.map.project([a.lng, a.lat]);
      const pb = this.map.project([b.lng, b.lat]);
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 8) this.points.pop();
      this.render();
    }
    this.opts.onFinish();
  };

  /** Places a corner while drawing (the keyboard's way in); false when editing. */
  addPoint(p: LngLat) {
    if (!this.drawing) return false;
    this.points.push({ lng: p.lng, lat: p.lat });
    this.render();
    return true;
  }

  undo() {
    if (this.points.length === 0) return;
    this.points.pop();
    this.render();
  }

  destroy() {
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.map.off("click", this.onClick);
    this.map.off("dblclick", this.onDblClick);
    this.map.getCanvas().style.cursor = "";
    // Re-enable after this double-click has finished bubbling.
    setTimeout(() => this.map.doubleClickZoom.enable(), 0);
  }

  private render() {
    for (const m of this.markers) m.remove();
    this.markers = [];
    const n = this.points.length;
    this.points.forEach((p, i) => {
      const el = document.createElement("div");
      el.className = "vertex";
      if (i === 0 && this.drawing && this.closed && n >= 3)
        el.classList.add("closer");
      el.textContent = String(i + 1);
      el.title =
        i === 0 && this.drawing && this.closed && n >= 3
          ? "Click to close the outline · drag to move"
          : "Drag to move · double-click to remove";
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([p.lng, p.lat])
        .addTo(this.map);
      marker.on("drag", () => {
        const ll = marker.getLngLat();
        this.points[i] = { lng: ll.lng, lat: ll.lat };
        this.opts.onChange(this.points);
      });
      marker.on("dragend", () => this.render());
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (i === 0 && this.drawing && this.closed && this.points.length >= 3)
          this.opts.onFinish();
      });
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        e.preventDefault();
        // While drawing, a double-click places a corner and lands its second
        // click on that corner: it means "finish here", not "remove".
        if (this.drawing && i === this.points.length - 1) {
          this.opts.onFinish();
          return;
        }
        if (this.points.length <= (this.closed ? 3 : 2)) return;
        this.points.splice(i, 1);
        this.render();
      });
      this.markers.push(marker);
    });
    // "+" handles halfway along each side insert a corner there.
    const sides = this.closed && n >= 3 ? n : n - 1;
    for (let i = 0; i < sides; i++) {
      const a = this.points[i];
      const b = this.points[(i + 1) % n];
      const el = document.createElement("button");
      el.type = "button";
      el.className = "midpoint";
      el.textContent = "+";
      el.title = "Add a corner here";
      el.setAttribute(
        "aria-label",
        `Add a corner between ${i + 1} and ${((i + 1) % n) + 1}`,
      );
      const mid = { lng: (a.lng + b.lng) / 2, lat: (a.lat + b.lat) / 2 };
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        this.points.splice(i + 1, 0, mid);
        this.render();
      });
      el.addEventListener("dblclick", (e) => e.stopPropagation());
      this.markers.push(
        new maplibregl.Marker({ element: el })
          .setLngLat([mid.lng, mid.lat])
          .addTo(this.map),
      );
    }
    this.opts.onChange(this.points);
  }
}
