import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { pathToFileURL } from 'node:url';

const fileUrlPlugin = () => ({
  name: 'file-url-for-test-files',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    // Vitest v4 serves modules over http, so import.meta.url is not a file URL.
    // Some gate tests construct file URLs from import.meta.url to read source
    // files; restore the real filesystem URL for those test modules.
    if (!id.includes('.test.')) return;
    if (!code.includes('import.meta.url')) return;
    const fileUrl = JSON.stringify(pathToFileURL(id).href);
    return {
      code: code.replace(/\bimport\.meta\.url\b/g, fileUrl),
      map: null,
    };
  },
});

export default defineConfig({
  plugins: [react(), fileUrlPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
});
