import { defineConfig } from "tsup";
export default defineConfig({
  entry: {
    index: "src/index.ts",
    factory: "src/factory.ts",
    helpers: "src/helpers.ts",
    advanced: "src/advanced.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["better-auth"],
});
