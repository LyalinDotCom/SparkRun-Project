import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import {
  buildPreviewProxyTarget,
  PREVIEW_PROXY_PREFIX,
} from './src/lib/previewProxy';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const skippedProxyHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'transfer-encoding',
]);

function sparkrunPreviewProxy(): Plugin {
  return {
    name: 'sparkrun-preview-proxy',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = request.url ?? '';
        if (!requestUrl.startsWith(PREVIEW_PROXY_PREFIX)) {
          next();
          return;
        }

        let target: URL;
        try {
          target = buildPreviewProxyTarget(requestUrl);
        } catch (error) {
          response.statusCode = 400;
          response.end(error instanceof Error ? error.message : String(error));
          return;
        }

        try {
          const upstream = await fetch(target);
          response.statusCode = upstream.status;
          upstream.headers.forEach((value, key) => {
            if (!skippedProxyHeaders.has(key.toLowerCase())) {
              response.setHeader(key, value);
            }
          });
          response.setHeader('Cache-Control', 'no-store');
          response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          response.setHeader('X-SparkRun-Preview-Source', target.origin);
          response.end(new Uint8Array(await upstream.arrayBuffer()));
        } catch (error) {
          response.statusCode = 502;
          response.end(
            error instanceof Error
              ? `Unable to reach VM preview: ${error.message}`
              : 'Unable to reach VM preview.',
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), sparkrunPreviewProxy()],
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
