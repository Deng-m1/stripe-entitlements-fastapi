import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    teardownTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/build/**", "src/node/bin.ts"],
      thresholds: {
        branches: 70,
        functions: 85,
        lines: 80,
        statements: 80,
        "src/checkout.ts": {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        "src/clawbacks.ts": {
          branches: 60,
          functions: 100,
          lines: 85,
          statements: 85,
        },
        "src/credit-pack-coordinator.ts": {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        "src/plan-changes.ts": {
          branches: 80,
          functions: 95,
          lines: 85,
          statements: 85,
        },
        "src/stripe-request-snapshots.ts": {
          branches: 85,
          functions: 90,
          lines: 90,
          statements: 90,
        },
      },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts", "tests/parity/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "postgres",
          include: ["tests/postgres/**/*.test.ts"],
          globalSetup: ["./tests/support/postgres-global-setup.ts"],
          setupFiles: ["./tests/support/postgres-setup.ts"],
          environment: "node",
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "real-stripe",
          include: ["tests/real-stripe/**/*.test.ts"],
          globalSetup: ["./tests/real-stripe/global-setup.ts"],
          environment: "node",
          fileParallelism: false,
          hookTimeout: 120_000,
          testTimeout: 600_000,
        },
      },
    ],
  },
});
