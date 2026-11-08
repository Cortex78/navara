import { describe, expect, it } from "vitest";

import { formatAcquisition, formatAcquisitionDates } from "./format";

describe("formatAcquisitionDates", () => {
  it.each([
    ["2021-05-27", "2021-05-27", "27 May 2021"],
    ["2021-05-02", "2021-05-27", "2–27 May 2021"],
    ["2023-12-04", "2024-02-11", "Dec 2023 – Feb 2024"],
    ["", "", "date unknown"],
  ])("%s .. %s → %s", (start, end, expected) => {
    expect(formatAcquisitionDates(start, end)).toBe(expected);
  });
});

describe("formatAcquisition", () => {
  it("reads like a survey badge", () => {
    expect(
      formatAcquisition({
        tiles: 1,
        start: "2021-05-27",
        end: "2021-05-27",
        sensors: ["Leica TerrainMapper"],
        meanDensity: 13.900661,
      }),
    ).toBe("LiDAR HD flown 27 May 2021 · Leica TerrainMapper · 13.9 pts/m²");
  });
});
