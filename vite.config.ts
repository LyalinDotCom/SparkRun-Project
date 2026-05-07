import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@leaningtech/cheerpx'],
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
