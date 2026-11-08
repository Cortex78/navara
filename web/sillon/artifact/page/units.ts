/*
 * Surveyor typography for the instrument's numbers (GAïa doctrine): a true
 * minus sign (U+2212), narrow no-break thousands separators (U+202F),
 * DMS angles with ′ ″, and Lambert-93 coordinates as E / N pairs.
 */

export const MINUS = "−";
const NNBSP = " ";

/** `v` to `digits` decimals with a true minus sign. */
export const signedFixed = (v: number, digits: number) =>
  `${v < 0 && Math.abs(v) >= 0.5 * 10 ** -digits ? MINUS : ""}${Math.abs(v).toFixed(digits)}`;

/** A height in metres, e.g. "−0.34 m". */
export const height = (m: number) => `${signedFixed(m, 2)} m`;

/** Thousands grouped with narrow no-break spaces: "6 277 610.1". */
export const grouped = (v: number, digits = 1) => {
  const [int, frac] = Math.abs(v).toFixed(digits).split(".");
  // No sign on a value that rounds to zero ("0", never "−0").
  const sign = v < 0 && /[1-9]/.test(`${int}${frac ?? ""}`) ? MINUS : "";
  return `${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)}${frac ? `.${frac}` : ""}`;
};

/** One angle in degrees, minutes, seconds to 0.01″, zero-padded. */
export const dms = (deg: number, pos: string, neg: string, pad: number) => {
  const hemi = deg < 0 ? neg : pos;
  const total = Math.round(Math.abs(deg) * 360000); // hundredths of a second
  const d = Math.floor(total / 360000);
  const m = Math.floor((total % 360000) / 6000);
  const s = (total % 6000) / 100;
  return `${String(d).padStart(pad, "0")}°${String(m).padStart(2, "0")}′${s.toFixed(2).padStart(5, "0")}″${hemi}`;
};

/** "43°35′13.63″N 004°33′00.76″E" */
export const latLonDms = (lat: number, lng: number) =>
  `${dms(lat, "N", "S", 2)} ${dms(lng, "E", "W", 3)}`;

/** "L93 E 825 512.3 · N 6 277 610.1" */
export const l93 = (x: number, y: number) =>
  `L93 E ${grouped(x)} · N ${grouped(y)}`;

/**
 * Capitals for the Technical register, typed rather than left to CSS
 * text-transform, so tokens keep their canonical casing: "LiDAR", and unit
 * symbols after a number ("20 m", "15.25 ha", "13.9 pts/m²").
 */
export const technicalCaps = (text: string) =>
  text
    .toUpperCase()
    .replace(/LIDAR/g, "LiDAR")
    .replace(
      /(\d) ?(PTS\/M²|M²|M³|CM|MM|KM|HA|M)(?![A-Z0-9²³])/g,
      (all, d: string, unit: string) =>
        `${d}${all.includes(" ") ? " " : ""}${unit.toLowerCase()}`,
    );
