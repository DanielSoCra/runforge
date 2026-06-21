import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // Playwright e2e specs (e2e/**) run via `pnpm e2e` (playwright), NOT vitest —
    // they import @playwright/test and must not be collected by the unit runner.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
