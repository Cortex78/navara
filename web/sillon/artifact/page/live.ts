import { decodeTerrarium } from "../../src/dem/terrarium";
import { KEY_PATTERN } from "../../supabase/keys";

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

/** What to tell the viewer when a connector call fails, by error code. */
export const describeMcpError = (e: unknown): string => {
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
      return "Supabase did not answer in time. Pan the map to try again.";
    case "tool_error":
      return `The sillon-tiles database refused the request: ${message ?? "unknown error"}. It may be paused; restore it in the Supabase dashboard.`;
    default:
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

  /** Area and relief of a field polygon from the native LiDAR HD grid. */
  async field(coordinates: unknown) {
    if (this.failure) throw this.failure;
    const literal = JSON.stringify(coordinates);
    if (!/^[-\d.,[\]e]+$/.test(literal))
      throw new Error("field coordinates must be numbers");
    const res = await this.call(
      `select sillon.field('${literal}'::jsonb) as stats`,
    );
    return parseSqlRows(res.payload)[0]?.stats as {
      areaHa: number;
      min: number;
      max: number;
      mean: number;
      p1: number;
      p99: number;
      nodataShare: number;
      cellSize: number;
      source: string;
    };
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
