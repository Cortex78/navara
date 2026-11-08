import type { CutFillRamp } from "../../src/dem/cutFillRaster";

/*
 * GAïa colours the map draws with. CSS tokens style the page; MapLibre
 * paints need literal colours, so they live here, one name per role.
 */

export const MAP = {
  /** Indigo night behind the tiles. */
  ground: "#04041a",
  /** Bone hairlines: RPG outlines, existing contours. */
  bone: "#ece8dc",
  /** Cobalt signal: design surface, profile line, active controls. */
  cobalt: "#3c62ff",
  cobaltLight: "#7c9aff",
  /** Signal orange: the selected field, alerts. */
  signal: "#ff6b26",
  /** Phosphor: live/positive states, the profile cursor. */
  phosphor: "#3ce0a0",
  /** Dark casing under bright lines over imagery. */
  casing: "#06061a",
};

/** Cut warm (soil to remove), fill cool (soil to bring), on grade a faint bone veil. */
export const CUT_FILL_RAMP: CutFillRamp = {
  cut: [
    [255, 210, 184],
    [255, 154, 102],
    [255, 107, 38],
    [184, 66, 10],
  ],
  fill: [
    [201, 211, 255],
    [124, 154, 255],
    [60, 98, 255],
    [30, 30, 168],
  ],
  grade: [236, 232, 220, 46],
};
