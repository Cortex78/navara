import type { AcquisitionSummary } from "../ign/lidarMetadata";

const dateFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthFmt = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** "27 May 2021", or "Dec 2023 – Feb 2024" when the flights span months. */
export const formatAcquisitionDates = (start: string, end: string): string => {
  if (!start) return "date unknown";
  if (!end || start === end) return dateFmt.format(parse(start));
  const s = parse(start);
  const e = parse(end);
  if (
    s.getUTCFullYear() === e.getUTCFullYear() &&
    s.getUTCMonth() === e.getUTCMonth()
  ) {
    return `${s.getUTCDate()}–${dateFmt.format(e)}`;
  }
  return `${monthFmt.format(s)} – ${monthFmt.format(e)}`;
};

export const formatAcquisition = (a: AcquisitionSummary): string => {
  const parts = [`LiDAR HD flown ${formatAcquisitionDates(a.start, a.end)}`];
  if (a.sensors.length) parts.push(a.sensors.join(", "));
  parts.push(`${a.meanDensity.toFixed(1)} pts/m²`);
  return parts.join(" · ");
};

export const formatHeight = (m: number) => `${m.toFixed(2)} m`;

export const formatLngLat = (lng: number, lat: number) =>
  `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

export const formatBytes = (n: number) =>
  n >= 1 << 20
    ? `${(n / (1 << 20)).toFixed(1)} MB`
    : `${Math.round(n / 1024)} kB`;
