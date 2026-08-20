import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Smoke tests dynamically import freshly built packages; first-load module
    // resolution on a cold cache can exceed the default 5s under parallel load.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
