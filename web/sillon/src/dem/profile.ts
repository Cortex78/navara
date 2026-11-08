import {
  lambert93ScaleFactor,
  lambert93ToLngLat,
  lngLatToLambert93,
  type LngLat,
  type XY,
} from "../geo/lambert93";

/** Most samples a profile carries; longer lines step wider. */
export const MAX_PROFILE_SAMPLES = 2000;

/** Sample spacing in ground metres for a line this long: 1 m, wider past 2 km. */
export const profileStep = (lengthM: number) =>
  Math.max(1, Math.ceil(lengthM / MAX_PROFILE_SAMPLES));

/** One point of an elevation profile. `d` is ground distance from the start. */
export type ProfileSample = { d: number; h: number; lng: number; lat: number };

/**
 * Samples heights every `step` ground metres along a polyline, through its
 * vertices, ending on the last point. `heightAt` takes Lambert-93
 * coordinates and returns NaN where it has no data.
 */
export const sampleProfile = (
  points: LngLat[],
  step: number,
  heightAt: (p: XY) => number,
): ProfileSample[] => {
  if (points.length < 2) return [];
  const k = lambert93ScaleFactor(
    points.reduce((s, p) => s + p.lat, 0) / points.length,
  );
  const xy = points.map(lngLatToLambert93);
  // Steps are in ground metres; Lambert-93 metres are k times longer.
  const mapStep = step * k;
  const out: ProfileSample[] = [];
  const push = (p: XY, mapDistance: number) => {
    const { lng, lat } = lambert93ToLngLat(p);
    out.push({ d: mapDistance / k, h: heightAt(p), lng, lat });
  };
  let walked = 0;
  let carry = 0;
  for (let i = 0; i + 1 < xy.length; i++) {
    const a = xy[i];
    const b = xy[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let t = carry;
    for (; t < len; t += mapStep) {
      const f = t / len;
      push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, walked + t);
    }
    // The next sample falls this far into the following segment.
    carry = t - len;
    walked += len;
  }
  push(xy[xy.length - 1], walked);
  return out;
};

export type ProfileStats = {
  lengthM: number;
  start: number;
  end: number;
  min: number;
  max: number;
  /** Start height minus end height: positive when the line runs downhill. */
  fall: number;
  /** Fall over length, in percent. */
  gradePct: number;
  /** Steepest rise and drop over any `window` metres, in percent. */
  maxRisePct: number;
  maxDropPct: number;
};

export const profileStats = (
  samples: ProfileSample[],
  window = 10,
): ProfileStats | null => {
  const valid = samples.filter((s) => !Number.isNaN(s.h));
  if (valid.length < 2) return null;
  const first = valid[0];
  const last = valid[valid.length - 1];
  let min = Infinity;
  let max = -Infinity;
  for (const s of valid) {
    min = Math.min(min, s.h);
    max = Math.max(max, s.h);
  }
  let maxRise = 0;
  let maxDrop = 0;
  for (let i = 0, j = 0; i < valid.length; i++) {
    while (j < valid.length && valid[j].d - valid[i].d < window) j++;
    if (j >= valid.length) break;
    const grade = ((valid[j].h - valid[i].h) / (valid[j].d - valid[i].d)) * 100;
    maxRise = Math.max(maxRise, grade);
    maxDrop = Math.max(maxDrop, -grade);
  }
  const lengthM = samples[samples.length - 1].d;
  return {
    lengthM,
    start: first.h,
    end: last.h,
    min,
    max,
    fall: first.h - last.h,
    gradePct: ((first.h - last.h) / (last.d - first.d)) * 100,
    maxRisePct: maxRise,
    maxDropPct: maxDrop,
  };
};

/** CSV of a profile: distance, height, longitude, latitude. */
export const profileCsv = (samples: ProfileSample[]) =>
  [
    "distance_m,height_m_ngf_ign69,lng,lat",
    ...samples.map(
      (s) =>
        `${s.d.toFixed(2)},${Number.isNaN(s.h) ? "" : s.h.toFixed(3)},${s.lng.toFixed(7)},${s.lat.toFixed(7)}`,
    ),
  ].join("\n");
