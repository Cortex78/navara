import type { XY } from "../geo/lambert93";
import type { FetchOptions } from "../ign/geoplateforme";

import { loadElevationGrid, sampleGrid } from "./elevationGrid";

export type HeightsAtOptions = FetchOptions & {
  layer: string;
  cellSize: number;
  /** Side of the square Lambert-93 blocks loaded around the points, in metres. */
  tileM: number;
  concurrency?: number;
  /**
   * Leave a block NaN when the service refuses it, after one retry, rather
   * than fail every point: the caller fills the gaps from another layer.
   * The Géoplateforme answers bursts with a transient "layer unknown".
   */
  tolerateFailures?: boolean;
};

/**
 * Heights at scattered Lambert-93 points (a profile line, a set of stakes),
 * loading only the square blocks the points fall in rather than their whole
 * bounding box: a 5 km diagonal costs ~30 small requests, not 12 km².
 * NaN where the layer has no data.
 */
export const loadHeightsAt = async (
  points: XY[],
  {
    layer,
    cellSize,
    tileM,
    concurrency = 6,
    tolerateFailures = false,
    ...fetchOptions
  }: HeightsAtOptions,
): Promise<Float32Array> => {
  const out = new Float32Array(points.length).fill(NaN);
  const blocks = new Map<string, { tx: number; ty: number; idx: number[] }>();
  points.forEach((p, i) => {
    const tx = Math.floor(p.x / tileM);
    const ty = Math.floor(p.y / tileM);
    const key = `${tx}/${ty}`;
    let b = blocks.get(key);
    if (!b) blocks.set(key, (b = { tx, ty, idx: [] }));
    b.idx.push(i);
  });
  const queue = [...blocks.values()];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      // One cell of margin so bilinear sampling at the block edge has neighbours.
      const load = () =>
        loadElevationGrid({
          bbox: {
            minX: b.tx * tileM - cellSize,
            minY: b.ty * tileM - cellSize,
            maxX: (b.tx + 1) * tileM + cellSize,
            maxY: (b.ty + 1) * tileM + cellSize,
          },
          cellSize,
          layer,
          concurrency: 1,
          ...fetchOptions,
        });
      let grid;
      try {
        grid = await load();
      } catch (e) {
        if (!tolerateFailures || fetchOptions.signal?.aborted) throw e;
        await new Promise((r) => setTimeout(r, 400));
        grid = await load().catch(() => null);
        if (!grid) continue;
      }
      for (const i of b.idx) out[i] = sampleGrid(grid, points[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker),
  );
  return out;
};
