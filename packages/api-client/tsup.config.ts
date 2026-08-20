import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts", "query-client": "src/query-client.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@ventora/observability", "@tanstack/react-query"],
});
