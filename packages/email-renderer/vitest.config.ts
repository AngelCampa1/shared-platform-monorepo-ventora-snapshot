import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      thresholds: { perFile: true, lines: 95, functions: 95, branches: 95, statements: 95 },
      exclude: ["dist/**", "src/__tests__/**", "tsup.config.ts", "vitest.config.ts"],
    },
  },
});
