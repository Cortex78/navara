import {
  parseDemTilePath,
  renderDemTile,
  type DemTileRequest,
} from "../dem/demTileBridge";

/**
 * Service worker answering `/__sillon/dem/...` tile requests (see
 * demTileBridge). Rendered tiles go to the Cache API, so a field visited once
 * keeps its terrain offline.
 *
 * The WebWorker lib cannot share a tsconfig with DOM, so the few service
 * worker types used here are declared locally.
 */

type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void };
type FetchEvent = ExtendableEvent & {
  request: Request;
  respondWith(r: Promise<Response>): void;
};
type ServiceWorkerScope = {
  addEventListener(
    type: "install" | "activate" | "message",
    cb: (e: ExtendableEvent) => void,
  ): void;
  addEventListener(type: "fetch", cb: (e: FetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
};

const sw = self as unknown as ServiceWorkerScope;

/** Bump when the tile encoding changes, so stale tiles are dropped. */
const CACHE = "sillon-dem-v1";

sw.addEventListener("install", (e) => e.waitUntil(sw.skipWaiting()));

sw.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("sillon-dem-") && key !== CACHE)
          await caches.delete(key);
      }
      await sw.clients.claim();
    })(),
  ),
);

// Sent by the page after a hard reload, which leaves it uncontrolled.
sw.addEventListener("message", (e) => {
  if ((e as ExtendableEvent & { data?: unknown }).data === "claim")
    e.waitUntil(sw.clients.claim());
});

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== sw.location.origin) return;
  const tile = parseDemTilePath(url.pathname);
  if (tile) event.respondWith(respond(event, tile));
});

const respond = async (
  event: FetchEvent,
  tile: DemTileRequest,
): Promise<Response> => {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  try {
    const { png, degraded } = await renderDemTile(tile, {
      signal: event.request.signal,
      retries: 3,
    });
    const res = new Response(png as BodyInit, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": degraded ? "no-store" : "max-age=1814400",
      },
    });
    if (!degraded) event.waitUntil(cache.put(event.request, res.clone()));
    return res;
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), {
      status: 502,
    });
  }
};
