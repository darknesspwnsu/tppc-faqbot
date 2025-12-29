// vitest.config.js
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Keep it strict:
      lines: 90,
      functions: 90,
      branches: 90,
      statements: 90,
      // If you want to exclude some files:
      exclude: ["**/node_modules/**", "**/dist/**"]
    }
  }
});
