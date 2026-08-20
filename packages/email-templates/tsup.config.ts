import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  jsx: "transform",
  external: ["react", "@react-email/components", "@react-email/render"],
});
