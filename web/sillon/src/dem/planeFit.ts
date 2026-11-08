/**
 * Least-squares plane z = z0 + dzdx·(x − x0) + dzdy·(y − y0) through
 * points in a metric, north-up frame (Lambert-93). The field's natural
 * fall: the slope a land leveller would keep, and the earthwork to reach it.
 */
export type PlaneFit = {
  x0: number;
  y0: number;
  /** Plane height at the centroid (x0, y0). */
  z0: number;
  dzdx: number;
  dzdy: number;
  /** Steepest slope of the plane, in percent. */
  slopePct: number;
  /** Direction the plane falls toward, degrees clockwise from north. */
  fallDeg: number;
  /** Root-mean-square distance of the points from the plane, in metres. */
  rms: number;
  n: number;
};

/**
 * Fits the points `i` in [0, n) for which `include(i)` holds, reading
 * coordinates through accessors so a caller with a million grid cells need
 * not allocate coordinate arrays.
 */
export const fitPlaneBy = (
  n: number,
  x: (i: number) => number,
  y: (i: number) => number,
  z: (i: number) => number,
  include: (i: number) => boolean = () => true,
): PlaneFit | null => {
  let count = 0;
  let x0 = 0;
  let y0 = 0;
  let z0 = 0;
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    x0 += x(i);
    y0 += y(i);
    z0 += z(i);
    count++;
  }
  if (count < 3) return null;
  x0 /= count;
  y0 /= count;
  z0 /= count;
  // Centred sums keep the normal equations well conditioned at Lambert-93
  // magnitudes (x ≈ 10⁶ m).
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxz = 0;
  let syz = 0;
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const dx = x(i) - x0;
    const dy = y(i) - y0;
    const dz = z(i) - z0;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-9 * (sxx * syy || 1))) return null;
  const dzdx = (sxz * syy - syz * sxy) / det;
  const dzdy = (syz * sxx - sxz * sxy) / det;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const r = z(i) - (z0 + dzdx * (x(i) - x0) + dzdy * (y(i) - y0));
    ss += r * r;
  }
  const fall = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
  return {
    x0,
    y0,
    z0,
    dzdx,
    dzdy,
    slopePct: Math.hypot(dzdx, dzdy) * 100,
    fallDeg: (fall + 360) % 360,
    rms: Math.sqrt(ss / count),
    n: count,
  };
};

export const fitPlane = (
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  zs: ArrayLike<number>,
): PlaneFit | null =>
  fitPlaneBy(
    zs.length,
    (i) => xs[i],
    (i) => ys[i],
    (i) => zs[i],
  );

export const planeHeight = (p: PlaneFit, x: number, y: number) =>
  p.z0 + p.dzdx * (x - p.x0) + p.dzdy * (y - p.y0);

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** "SE" for 135°: the eight-point direction a farmer names a slope by. */
export const compassPoint = (deg: number) =>
  COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
