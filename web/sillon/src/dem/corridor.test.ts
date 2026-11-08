import { describe, expect, it, vi } from "vitest";

import { loadHeightsAt } from "./corridor";

/** A stand-in WMS whose height is the cell centre's easting minus 825000. */
const wms = () =>
  vi.fn(async (url: string | URL | Request) => {
    const q = new URL(String(url)).searchParams;
    const [minX, , maxX] = (q.get("BBOX") ?? "").split(",").map(Number);
    const w = Number(q.get("WIDTH"));
    const h = Number(q.get("HEIGHT"));
    const cs = (maxX - minX) / w;
    const data = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
      for (let c = 0; c < w; c++)
        data[r * w + c] = minX + (c + 0.5) * cs - 825000;
    return new Response(data.buffer);
  });

describe("loadHeightsAt", () => {
  it("loads one block per occupied tile and samples each point", async () => {
    const fetchImpl = wms();
    const points = [
      { x: 825010.25, y: 6277010 },
      { x: 825060.75, y: 6277020 },
      { x: 825300, y: 6277300 },
    ];
    const h = await loadHeightsAt(points, {
      layer: "test",
      cellSize: 0.5,
      tileM: 256,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // The first two share a block; the third is two blocks away.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    points.forEach((p, i) => expect(h[i]).toBeCloseTo(p.x - 825000, 3));
  });
});

describe("loadHeightsAt with tolerateFailures", () => {
  it("leaves a refused block NaN after one retry and keeps the others", async () => {
    const ok = wms();
    let refusals = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const minX = Number(
        (new URL(String(url)).searchParams.get("BBOX") ?? "").split(",")[0],
      );
      if (minX > 825000) {
        refusals++;
        return new Response(
          "<ExceptionReport><Exception><ExceptionText>Layer unknown</ExceptionText></Exception></ExceptionReport>",
          { status: 400, headers: { "content-type": "text/xml" } },
        );
      }
      return ok(url);
    });
    const points = [
      { x: 825010, y: 6277010 },
      { x: 825300, y: 6277300 },
    ];
    const opts = {
      layer: "test",
      cellSize: 0.5,
      tileM: 256,
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    };
    await expect(loadHeightsAt(points, opts)).rejects.toThrow(/Layer unknown/);
    refusals = 0;
    const h = await loadHeightsAt(points, { ...opts, tolerateFailures: true });
    expect(refusals).toBe(2);
    expect(h[0]).toBeCloseTo(10, 3);
    expect(h[1]).toBeNaN();
  });
});
