/**
 * Assembles the artifact page: one HTML file with the CSS and the bundled
 * script inline (the artifact CSP admits scripts only from a few CDNs, so
 * MapLibre loads from jsDelivr and everything else ships in the page).
 *
 *   tsx artifact/build.ts <outDir>   (the pack from bake.ts goes beside it)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const MAPLIBRE_VERSION = "5.24.0";
/** The cuneiform signs the page shows (section marks, standby triad), so Google Fonts sends only these. */
const CUNEIFORM = "𒆠𒆳𒀭𒌓𒁾𒅆𒍃";
const out = process.argv[2];
if (!out) throw new Error("usage: build.ts <outDir>");

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const require = createRequire(import.meta.url);

const bundlePage = async () => {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    build: {
      write: false,
      minify: true,
      target: "es2022",
      lib: {
        entry: here("./page/main.ts"),
        formats: ["iife"],
        name: "Sillon",
        fileName: () => "page.js",
      },
      rollupOptions: {
        external: ["maplibre-gl"],
        output: { globals: { "maplibre-gl": "maplibregl" } },
      },
    },
  });
  for (const o of Array.isArray(result) ? result : [result]) {
    if (!("output" in o)) continue;
    const chunk = o.output.find((c) => c.type === "chunk");
    if (chunk && chunk.type === "chunk") return chunk.code;
  }
  throw new Error("page bundle produced no chunk");
};

const maplibreCss = readFileSync(
  require.resolve("maplibre-gl/dist/maplibre-gl.css"),
  "utf8",
);
const pageCss = readFileSync(here("./page/style.css"), "utf8");
const body = readFileSync(here("./page/body.html"), "utf8");
const script = (await bundlePage()).replaceAll("</script", "<\\/script");

const html = `<title>Sillon Camargue</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@1,6..72,400&display=swap" />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+Cuneiform&text=${encodeURIComponent(CUNEIFORM)}&display=swap" />
<style>
${pageCss}
${maplibreCss}
</style>
${body}
<script src="https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js"></script>
<script>
${script}
</script>
`;

writeFileSync(join(out, "index.html"), html);
console.log(`index.html: ${(html.length / 1024).toFixed(0)} kB`);
