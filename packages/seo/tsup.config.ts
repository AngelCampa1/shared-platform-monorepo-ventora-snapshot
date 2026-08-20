import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    schema: "src/schema.ts",
    metadata: "src/metadata.ts",
    sitemap: "src/sitemap.ts",
    feed: "src/feed.ts",
    indexnow: "src/indexnow.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
