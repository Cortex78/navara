import type { ElevationGrid } from "../../src/dem/elevationGrid";
import type { FieldSurface } from "../../src/dem/fieldMask";
import { decodeTerrarium } from "../../src/dem/terrarium";
import { KEY_PATTERN } from "../../supabase/keys";
// Type only: the Edge code itself stays out of the page bundle.
import type { FieldGridAnswer } from "../../supabase/proxy";
import { decodeGrid, fromBase64 } from "../pack";

/*
 * Live IGN data for the artifact. The page cannot fetch other sites, but it
 * can call the viewer's Supabase connector: `execute_sql` runs
 * `sillon.proxy(keys)` in the sillon-tiles project, which answers from its
 * cache or fetches through the ign-proxy Edge Function.
 */

export const SUPABASE_SERVER = "Supabase";
export const SUPABASE_PROJECT = "khdclylglmelwnzwqhan";

export type ProxyItem = { status: number; ctype: string; b64: string };

type CallToolResult = {
  payload?: unknown;
  content?: { type: string; text?: string }[];
};
export type McpLike = {
  callTool(
    server: string,
    tool: string,
    input?: unknown,
    options?: unknown,
  ): Promise<CallToolResult>;
};

type McpError = { code?: string; message?: string; server?: string };

/** Edge refusals the page can say better than by quoting them. */
const EDGE_REFUSALS: [RegExp, string][] = [
  [
    /bounding box over 4 km/,
    "This field is too large for live IGN: its bounding box is over 4 km². Draw it in parts.",
  ],
  [
    /too long for \d+ cells/,
    "This field is too long for the live design grid. Draw it in parts.",
  ],
  [/longer than 10 km/, "A profile can be at most 10 km long."],
];

/**
 * The reason inside an "ign-proxy HTTP n: {...}" exception (raised by
 * `sillon.edge` in schema.sql), in the page's words; null for any other
 * message. The Edge function answers every failure, its own refusals and
 * IGN's outages alike, with `{"error": "..."}`.
 */
export const describeEdgeError = (message?: string): string | null => {
  const m = /ign-proxy HTTP (\d+):\s*([\s\S]*)/.exec(message ?? "");
  if (!m) return null;
  const body = m[2];
  for (const [re, text] of EDGE_REFUSALS) if (re.test(body)) return text;
  // The JSON may arrive escaped inside the connector's own message.
  const reason = /"error\\?"\s*:\s*\\?"([^"\\]+)/.exec(body)?.[1]?.trim();
  return `Live IGN could not serve this${reason ? `: ${reason}` : ` (HTTP ${m[1]})`}. Try again in a moment.`;
};

/**
 * What to tell the viewer when a connector call fails, by error code.
 * `retry` says how to try again where a timeout is worth retrying: panning
 * reloads tiles, but a field or a profile has to be asked for again.
 */
export const describeMcpError = (
  e: unknown,
  retry = "Pan the map to try again.",
): string => {
  const { code, message } = (e ?? {}) as McpError;
  switch (code) {
    case "not_in_manifest":
    case "approval_required":
    case "consent_required":
      return "Live IGN needs your permission to use the Supabase connector. Choose Live IGN again to be asked.";
    case "server_not_connected":
    case "selection_required":
      return "Live IGN needs the Supabase connector: add it in claude.ai Settings → Connectors.";
    case "needs_reauth":
      return "Reconnect Supabase in claude.ai Settings → Connectors to use live IGN data.";
    case "server_unavailable":
      return `Supabase did not answer in time. ${retry}`;
    case "tool_error":
      return (
        describeEdgeError(message) ??
        `The sillon-tiles database refused the request: ${message ?? "unknown error"}. It may be paused; restore it in the Supabase dashboard.`
      );
    default:
      // A plain Error is the page's own (an empty or unreadable answer),
      // not the connector's: its message says more than "no connector".
      if (code === undefined && e instanceof Error) return e.message;
      return `Live IGN is unavailable here (${code ?? "no connector"}).`;
  }
};

/**
 * Rows of an `execute_sql` answer. The Supabase connector wraps the JSON
 * rows in a text envelope that fences them between untrusted-data tags.
 */
export const parseSqlRows = (payload: unknown): Record<string, unknown>[] => {
  const text =
    typeof payload === "string"
      ? payload
      : typeof (payload as { result?: unknown })?.result === "string"
        ? (payload as { result: string }).result
        : JSON.stringify(payload);
  // The preamble names the fence tag too, so the rows start after the last
  // opening tag before the closing one.
  const close = text.indexOf("</untrusted-data-");
  const open = close < 0 ? -1 : text.lastIndexOf("<untrusted-data-", close);
  const body = open < 0 ? text : text.slice(text.indexOf(">", open) + 1, close);
  const rows = JSON.parse(body) as unknown;
  if (!Array.isArray(rows)) throw new Error("unexpected execute_sql answer");
  return rows as Record<string, unknown>[];
};

export const fromBase64Bytes = (b64: string) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

type Waiter = {
  resolve: (item: ProxyItem) => void;
  reject: (e: unknown) => void;
};

/**
 * Batches proxy keys requested within a few milliseconds into one
 * `execute_sql` call, a few calls at a time, so a screenful of tiles costs
 * a handful of connector round trips.
 */
export type LiveFieldStats = FieldSurface & {
  cellSize: number;
  source: string;
};

export type LiveProfile = {
  step: number;
  cellSize: number;
  source: string;
  d: number[];
  h: (number | null)[];
};

/** Coordinates as a JSON literal safe to quote in SQL: numbers and brackets only. */
const numericJson = (coordinates: unknown) => {
  const literal = JSON.stringify(coordinates);
  if (!/^[-\d.,[\]e]+$/.test(literal))
    throw new Error("coordinates must be numbers");
  return literal;
};

/** A field's height grid from live IGN, and the DTM it came from. */
export type LiveFieldGrid = ElevationGrid & { source: string };

/**
 * Reads handleFieldGrid's answer the way main.ts reads a pack grid (base64,
 * zlib inflate, int16 row deltas), then adds back the base height.
 */
export const decodeFieldGrid = async (
  g: FieldGridAnswer,
): Promise<LiveFieldGrid> => {
  const inflated = await new Response(
    new Blob([fromBase64(g.data) as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate")),
  ).arrayBuffer();
  const data = decodeGrid(new Uint8Array(inflated), g.width, g.scale);
  if (data.length !== g.width * g.height)
    throw new Error(
      `The field's height grid has ${data.length} cells, not ${g.width} × ${g.height}.`,
    );
  for (let i = 0; i < data.length; i++) data[i] += g.base;
  return {
    crs: "EPSG:2154",
    layer: g.layer,
    cellSize: g.cellSize,
    originX: g.originX,
    originY: g.originY,
    width: g.width,
    height: g.height,
    data,
    source: g.source,
  };
};

export class LiveProxy {
  private waiting = new Map<string, Waiter[]>();
  private queued: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  /** Set when the connector refuses; every later request fails fast with it. */
  failure: unknown = null;
  onFailure: (e: unknown) => void = () => {};

  constructor(
    private readonly mcp: McpLike,
    private readonly maxBatch = 8,
    private readonly maxInFlight = 3,
  ) {}

  get(key: string): Promise<ProxyItem> {
    if (!KEY_PATTERN.test(key))
      return Promise.reject(new Error(`malformed key ${key}`));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiters = this.waiting.get(key);
      if (waiters) {
        waiters.push({ resolve, reject });
        return;
      }
      this.waiting.set(key, [{ resolve, reject }]);
      this.queued.push(key);
      this.timer ??= setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, 25);
    });
  }

  async bytes(key: string): Promise<ArrayBuffer> {
    const item = await this.get(key);
    const bytes = fromBase64Bytes(item.b64);
    if (item.status !== 200) throw new Error(new TextDecoder().decode(bytes));
    return bytes.buffer as ArrayBuffer;
  }

  async json<T>(key: string): Promise<T> {
    return JSON.parse(new TextDecoder().decode(await this.bytes(key))) as T;
  }

  /** Area, relief, natural fall and earthwork of a field from the native LiDAR HD grid. */
  async field(coordinates: unknown): Promise<LiveFieldStats | undefined> {
    if (this.failure) throw this.failure;
    const res = await this.call(
      `select sillon.field('${numericJson(coordinates)}'::jsonb) as stats`,
    );
    return parseSqlRows(res.payload)[0]?.stats as LiveFieldStats | undefined;
  }

  /** Heights along a line every `step` ground metres (see handleProfile). */
  async profile(coordinates: number[][]): Promise<LiveProfile> {
    if (this.failure) throw this.failure;
    const res = await this.call(
      `select sillon.profile('${numericJson(coordinates)}'::jsonb) as r`,
    );
    const r = parseSqlRows(res.payload)[0]?.r as LiveProfile | undefined;
    if (!r?.d) throw new Error("the profile came back empty");
    return r;
  }

  /**
   * The field's height grid for the cut/fill design, cropped to it with NaN
   * outside (see handleFieldGrid); 0 × 0 when IGN has no heights there.
   */
  async fieldGrid(coordinates: unknown): Promise<LiveFieldGrid> {
    if (this.failure) throw this.failure;
    const res = await this.call(
      `select sillon.field_grid('${numericJson(coordinates)}'::jsonb) as g`,
    );
    const g = parseSqlRows(res.payload)[0]?.g as FieldGridAnswer | undefined;
    if (typeof g?.data !== "string")
      throw new Error("Live IGN sent back no height grid for this field.");
    return decodeFieldGrid(g);
  }

  private call(query: string) {
    return this.mcp.callTool(SUPABASE_SERVER, "execute_sql", {
      project_id: SUPABASE_PROJECT,
      query,
    });
  }

  private pump() {
    while (this.queued.length && this.inFlight < this.maxInFlight) {
      // Keep each answer to roughly 1 MB of base64: elevation and shade PNGs
      // are ~4x a JPEG tile, and a field lookup can reach 200 kB or more.
      const batch: string[] = [];
      let weight = 0;
      while (this.queued.length && batch.length < this.maxBatch) {
        const w = /^kind=rpg&/.test(this.queued[0])
          ? 16
          : /^kind=(dem|shade)&/.test(this.queued[0])
            ? 4
            : 1;
        if (batch.length && weight + w > 16) break;
        weight += w;
        batch.push(this.queued.shift() as string);
      }
      void this.run(batch);
    }
  }

  private async run(keys: string[]) {
    this.inFlight++;
    try {
      const res = await this.call(
        `select sillon.proxy(array[${keys.map((k) => `'${k}'`).join(",")}]) as r`,
      );
      const answer = (parseSqlRows(res.payload)[0]?.r ?? {}) as Record<
        string,
        ProxyItem
      >;
      for (const key of keys) {
        const item = answer[key];
        for (const w of this.waiting.get(key) ?? []) {
          if (item) w.resolve(item);
          else w.reject(new Error(`no answer for ${key}`));
        }
        this.waiting.delete(key);
      }
    } catch (e) {
      const code = (e as McpError)?.code;
      if (
        code &&
        !["server_unavailable", "upstream_error", "cancelled"].includes(code)
      ) {
        this.failure = e;
        this.onFailure(e);
      }
      for (const key of keys) {
        for (const w of this.waiting.get(key) ?? []) w.reject(e);
        this.waiting.delete(key);
      }
    } finally {
      this.inFlight--;
      this.pump();
    }
  }
}

/** Heights of a Terrarium PNG tile, row-major, north first. */
export const decodeDemPng = async (bytes: ArrayBuffer) => {
  const bitmap = await createImageBitmap(
    new Blob([bytes], { type: "image/png" }),
    {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    },
  );
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("no 2D canvas");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = ctx.getImageData(0, 0, width, height);
  const heights = new Float32Array(width * height);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = decodeTerrarium(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return { heights, size: width };
};
