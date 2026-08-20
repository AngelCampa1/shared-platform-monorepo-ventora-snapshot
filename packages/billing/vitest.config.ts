import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      thresholds: { perFile: true, lines: 95, functions: 95, branches: 95, statements: 95 },
      exclude: [
        "dist/**",
        "src/__tests__/**",
        "src/index.ts",
        "tsup.config.ts",
        "vitest.config.ts",
      ],
    },
  },
});
