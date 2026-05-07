import { describe, expect, it } from 'vitest';
import {
  buildPreviewProxyTarget,
  isAllowedPreviewHost,
  PREVIEW_PROXY_PREFIX,
  toPreviewFrameUrl,
} from './previewProxy';

describe('preview iframe proxy', () => {
  it('allows localhost and Tailnet IPv4 preview hosts', () => {
    expect(isAllowedPreviewHost('localhost')).toBe(true);
    expect(isAllowedPreviewHost('127.0.0.1')).toBe(true);
    expect(isAllowedPreviewHost('100.64.0.1')).toBe(true);
    expect(isAllowedPreviewHost('100.79.14.108')).toBe(true);
    expect(isAllowedPreviewHost('100.127.255.254')).toBe(true);

    expect(isAllowedPreviewHost('100.128.0.1')).toBe(false);
    expect(isAllowedPreviewHost('192.168.1.20')).toBe(false);
    expect(isAllowedPreviewHost('example.com')).toBe(false);
  });

  it('converts an allowed VM URL into a same-origin iframe path', () => {
    expect(toPreviewFrameUrl('http://100.79.14.108:8080/')).toBe(
      `${PREVIEW_PROXY_PREFIX}100.79.14.108:8080/`,
    );
    expect(toPreviewFrameUrl('http://100.79.14.108:8080/assets/site.css')).toBe(
      `${PREVIEW_PROXY_PREFIX}100.79.14.108:8080/assets/site.css`,
    );
  });

  it('keeps unsupported targets unproxied', () => {
    expect(toPreviewFrameUrl('https://100.79.14.108:8080/')).toBe(
      'https://100.79.14.108:8080/',
    );
    expect(toPreviewFrameUrl('http://192.168.1.20:8080/')).toBe(
      'http://192.168.1.20:8080/',
    );
  });

  it('builds a strict HTTP target for the dev proxy', () => {
    expect(
      buildPreviewProxyTarget(
        `${PREVIEW_PROXY_PREFIX}100.79.14.108:8080/assets/site.css`,
      ).href,
    ).toBe('http://100.79.14.108:8080/assets/site.css');

    expect(() =>
      buildPreviewProxyTarget(`${PREVIEW_PROXY_PREFIX}100.79.14.108:3000/`),
    ).toThrow('port 8080');
    expect(() =>
      buildPreviewProxyTarget(`${PREVIEW_PROXY_PREFIX}192.168.1.20:8080/`),
    ).toThrow('Tailnet');
  });
});
