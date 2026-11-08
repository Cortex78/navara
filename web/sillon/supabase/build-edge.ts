/**
 * Bundles the ign-proxy Edge Function into one self-contained module, ready
 * to deploy (the Sillon sources import each other without file extensions,
 * which Deno does not resolve).
 *
 *   tsx supabase/build-edge.ts <outFile>
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { build } from "vite";

const out = process.argv[2];
if (!out) throw new Error("usage: build-edge.ts <outFile>");

const result = await build({
  configFile: false,
  logLevel: "warn",
  build: {
    write: false,
    minify: false,
    target: "es2022",
    lib: {
      entry: fileURLToPath(
        new URL("./functions/ign-proxy/index.ts", import.meta.url),
      ),
      formats: ["es"],
      fileName: () => "index.js",
    },
  },
});
for (const o of Array.isArray(result) ? result : [result]) {
  if (!("output" in o)) continue;
  const chunk = o.output.find((c) => c.type === "chunk");
  if (chunk && chunk.type === "chunk") {
    writeFileSync(out, chunk.code);
    console.log(`${out}: ${(chunk.code.length / 1024).toFixed(1)} kB`);
  }
}
