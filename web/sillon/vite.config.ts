/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";

import { build, defineConfig, type Plugin } from "vite";

const SW_ENTRY = fileURLToPath(
  new URL("./src/sw/demServiceWorker.ts", import.meta.url),
);
const SW_FILE = "dem-sw.js";

/**
 * Bundles the DEM service worker into one classic (IIFE) script served at the
 * app root, so it can control the whole origin. A module worker would be
 * simpler, but Rollup splits modules it shares with the app into chunks the
 * worker would then have to import.
 */
const bundleServiceWorker = async (minify: boolean): Promise<string> => {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      minify,
      lib: {
        entry: SW_ENTRY,
        formats: ["iife"],
        name: "SillonDemServiceWorker",
        fileName: () => SW_FILE,
      },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const out of outputs) {
    if (!("output" in out)) continue;
    const chunk = out.output.find((o) => o.type === "chunk");
    if (chunk && chunk.type === "chunk") return chunk.code;
  }
  throw new Error("service worker bundle produced no chunk");
};

const demServiceWorker = (): Plugin => ({
  name: "sillon-dem-service-worker",
  configureServer(server) {
    server.middlewares.use(`/${SW_FILE}`, (_req, res, next) => {
      bundleServiceWorker(false).then((code) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(code);
      }, next);
    });
  },
  async generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: SW_FILE,
      source: await bundleServiceWorker(true),
    });
  },
});

export default defineConfig({
  plugins: [demServiceWorker()],
  // pnpm gives each workspace package its own three; one copy must run.
  resolve: { dedupe: ["three", "postprocessing"] },
  build: { target: "es2022" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
