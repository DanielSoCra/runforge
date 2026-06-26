import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Each test file boots its own in-process PGlite (real Postgres compiled to
    // WASM). Running dozens of WASM instances in parallel forked workers spikes
    // memory and can abort the WASM runtime, so cap the worker pool — stability
    // over raw parallelism for the in-memory-Postgres backend.
    pool: "forks",
    poolOptions: { forks: { maxForks: 3, minForks: 1 } },
  },
});
