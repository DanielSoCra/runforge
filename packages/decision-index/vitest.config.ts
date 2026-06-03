import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // On-disk temp SQLite needs real fs; keep tests isolated per file.
    pool: "forks",
  },
});
