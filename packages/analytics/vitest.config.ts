import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "happy-dom",
    coverage: {
      provider: "v8",
      thresholds: { perFile: true, lines: 95, functions: 95, branches: 95, statements: 95 },
      exclude: [
        "dist/**",
        "src/__tests__/**",
        "src/_generated-events.ts",
        "src/index.ts",
        "tsup.config.ts",
        "vitest.config.ts",
      ],
    },
  },
});
