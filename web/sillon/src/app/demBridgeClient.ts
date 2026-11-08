/**
 * Registers the DEM service worker and resolves once it controls this page,
 * so the engine's first `/__sillon/dem/...` request is already intercepted.
 * Returns the app base URL the tile template is built on.
 */
export const ensureDemBridge = async (timeoutMs = 15_000): Promise<string> => {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "Service workers are unavailable: serve Sillon over https or from localhost.",
    );
  }
  const base = new URL(import.meta.env.BASE_URL, location.href).href;
  const sw = navigator.serviceWorker;
  const registration = await sw.register(`${base}dem-sw.js`, { scope: base });
  await sw.ready;
  if (sw.controller) return base;

  const controlled = new Promise<void>((resolve) =>
    sw.addEventListener("controllerchange", () => resolve(), { once: true }),
  );
  // A hard reload bypasses the active worker; ask it to claim the page again.
  registration.active?.postMessage("claim");
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error("DEM service worker did not take control of the page"),
        ),
      timeoutMs,
    ),
  );
  await Promise.race([controlled, timeout]);
  return base;
};
