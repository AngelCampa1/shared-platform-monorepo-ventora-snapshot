import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    browser: "src/browser.ts",
    server: "src/server.ts",
    "_generated-events": "src/_generated-events.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["posthog-js"],
});
