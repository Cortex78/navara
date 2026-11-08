/**
 * RGF93 / Lambert-93 (EPSG:2154): Lambert conformal conic, two standard
 * parallels, GRS80 ellipsoid. RGF93 and WGS84 agree to well under a metre
 * and EPSG treats the datum shift between them as null, so WGS84 lng/lat go
 * in and out directly.
 */

const A = 6378137;
const F = 1 / 298.257222101;
const E = Math.sqrt(2 * F - F * F);

const LAT1 = (49 * Math.PI) / 180;
const LAT2 = (44 * Math.PI) / 180;
const LAT0 = (46.5 * Math.PI) / 180;
const LNG0 = (3 * Math.PI) / 180;
const X0 = 700000;
const Y0 = 6600000;

const m = (lat: number) =>
  Math.cos(lat) / Math.sqrt(1 - (E * Math.sin(lat)) ** 2);
const t = (lat: number) => {
  const es = E * Math.sin(lat);
  return Math.tan(Math.PI / 4 - lat / 2) / ((1 - es) / (1 + es)) ** (E / 2);
};

const N =
  (Math.log(m(LAT1)) - Math.log(m(LAT2))) /
  (Math.log(t(LAT1)) - Math.log(t(LAT2)));
const AF = (A * m(LAT1)) / (N * t(LAT1) ** N);
const RHO0 = AF * t(LAT0) ** N;

export type LngLat = { lng: number; lat: number };
export type XY = { x: number; y: number };

export const lngLatToLambert93 = ({ lng, lat }: LngLat): XY => {
  const rho = AF * t((lat * Math.PI) / 180) ** N;
  const theta = N * ((lng * Math.PI) / 180 - LNG0);
  return {
    x: X0 + rho * Math.sin(theta),
    y: Y0 + RHO0 - rho * Math.cos(theta),
  };
};

export const lambert93ToLngLat = ({ x, y }: XY): LngLat => {
  const dx = x - X0;
  const dy = RHO0 - (y - Y0);
  const rho = Math.hypot(dx, dy);
  const tp = (rho / AF) ** (1 / N);
  let lat = Math.PI / 2 - 2 * Math.atan(tp);
  for (let i = 0; i < 10; i++) {
    const es = E * Math.sin(lat);
    const next =
      Math.PI / 2 - 2 * Math.atan(tp * ((1 - es) / (1 + es)) ** (E / 2));
    if (Math.abs(next - lat) < 1e-14) {
      lat = next;
      break;
    }
    lat = next;
  }
  const lng = Math.atan2(dx, dy) / N + LNG0;
  return { lng: (lng * 180) / Math.PI, lat: (lat * 180) / Math.PI };
};

/**
 * Projects every (lngs[i], lats[j]) pair of a lng/lat lattice; outputs are
 * row-major with `lats` as rows. The conic's radius depends only on latitude
 * and its angle only on longitude, so each is computed once per row or
 * column — about 50× fewer transcendental calls than projecting each point,
 * which matters when building elevation tiles in the browser.
 */
export const lngLatLatticeToLambert93 = (
  lngs: ArrayLike<number>,
  lats: ArrayLike<number>,
) => {
  const xs = new Float64Array(lngs.length * lats.length);
  const ys = new Float64Array(xs.length);
  const sin = Float64Array.from(lngs, (lng) =>
    Math.sin(N * ((lng * Math.PI) / 180 - LNG0)),
  );
  const cos = Float64Array.from(lngs, (lng) =>
    Math.cos(N * ((lng * Math.PI) / 180 - LNG0)),
  );
  for (let j = 0; j < lats.length; j++) {
    const rho = AF * t((lats[j] * Math.PI) / 180) ** N;
    for (let i = 0; i < lngs.length; i++) {
      xs[j * lngs.length + i] = X0 + rho * sin[i];
      ys[j * lngs.length + i] = Y0 + RHO0 - rho * cos[i];
    }
  }
  return { xs, ys };
};

/**
 * Point scale factor of the projection at a latitude: a Lambert-93 metre
 * covers `1 / k` metres of ground. Within ±0.1 % over mainland France, so
 * grid areas and volumes are corrected with it rather than ignored.
 */
export const lambert93ScaleFactor = (lat: number): number => {
  const phi = (lat * Math.PI) / 180;
  return (N * AF * t(phi) ** N) / (A * m(phi));
};
