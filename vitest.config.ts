import { defineConfig } from "vitest/config";

// One configuration for both suites. Without BOOKING_TEST_DATABASE_URL the tests that need PostgreSQL are skipped and
// only the thresholds of the pure layers apply. With it (scripts/integration.sh starts a throwaway database) every
// test runs and the overall threshold applies too, because the PostgreSQL adapters are only exercised there.
const withDatabase = Boolean(process.env.BOOKING_TEST_DATABASE_URL);

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**"],
    // the suites that talk to PostgreSQL run 50 connections at once on a shared runner
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // every database test file creates and drops its own database, one file at a time
    fileParallelism: !withDatabase,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/bin.ts", "src/demo/main.ts", "src/**/*.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "out/coverage",
      thresholds: {
        "src/domain/**": { lines: 95, statements: 95 },
        "src/application/**": { lines: 90, statements: 90 },
        ...(withDatabase ? { lines: 85, statements: 85 } : {}),
      },
    },
  },
});
