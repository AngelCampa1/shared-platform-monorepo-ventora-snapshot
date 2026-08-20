import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      thresholds: { perFile: true, lines: 95, functions: 95, branches: 95, statements: 95 },
      exclude: [
        "**/node_modules/**",
        "**/.wrangler/**",
        "dist/**",
        "src/__tests__/**",
        "vitest.config.ts",
      ],
    },
  },
});
