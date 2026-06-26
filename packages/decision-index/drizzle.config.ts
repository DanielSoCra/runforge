import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env.AUTO_CLAUDE_DATABASE_URL ??
      "postgres://postgres:postgres@localhost:5432/auto_claude",
  },
});
