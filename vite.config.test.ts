// @vitest-environment node

import { describe, expect, it } from 'vitest';
import config from './vite.config';

describe('local VM image delivery', () => {
  it('proxies the production same-origin image path during development', () => {
    const resolved = config as {
      server?: {
        proxy?: Record<
          string,
          { target?: string; changeOrigin?: boolean; secure?: boolean }
        >;
      };
    };

    expect(resolved.server?.proxy?.['/vm-images']).toEqual({
      target: 'https://spark-run-poc.web.app',
      changeOrigin: true,
      secure: true,
    });
  });
});
