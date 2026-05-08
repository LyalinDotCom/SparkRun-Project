import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const cheerpxPkg = JSON.parse(
  readFileSync('node_modules/@leaningtech/cheerpx/package.json', 'utf8'),
) as { version: string };

let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (dirty.length > 0) {
    gitSha = `${gitSha}+dirty`;
  }
} catch {
  // Outside a git repo or git not available — fall through.
}

const buildTimestamp = new Date().toISOString();

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['@leaningtech/cheerpx'],
  },
  define: {
    __CHEERPX_PINNED_VERSION__: JSON.stringify(cheerpxPkg.version),
    __SPARKRUN_BUILD_SHA__: JSON.stringify(gitSha),
    __SPARKRUN_BUILD_TIME__: JSON.stringify(buildTimestamp),
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
