/** Blue (low) → red (high), the field-relief ramp farmers read at a glance. RGB in 0..1. */
export const RELIEF_STOPS: [number, number, number][] = [
  [0.19, 0.21, 0.58],
  [0.16, 0.45, 0.76],
  [0.27, 0.68, 0.8],
  [0.56, 0.82, 0.67],
  [0.89, 0.91, 0.56],
  [0.99, 0.77, 0.4],
  [0.96, 0.47, 0.25],
  [0.8, 0.13, 0.16],
];

export const reliefCss = ([r, g, b]: [number, number, number], alpha = 1) =>
  `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;

export const reliefGradientCss = () =>
  `linear-gradient(90deg, ${RELIEF_STOPS.map(
    (c, i) =>
      `${reliefCss(c)} ${((i / (RELIEF_STOPS.length - 1)) * 100).toFixed(1)}%`,
  ).join(", ")})`;
