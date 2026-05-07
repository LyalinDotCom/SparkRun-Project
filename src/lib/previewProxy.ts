export const PREVIEW_PROXY_PREFIX = '/__sparkrun_preview__/';

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255 ||
        String(octet) !== parts[index],
    )
  ) {
    return null;
  }
  return octets;
}

export function isAllowedPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') {
    return true;
  }

  const octets = parseIpv4(host);
  if (!octets) {
    return false;
  }

  // Tailscale CGNAT range: 100.64.0.0/10.
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

export function toPreviewFrameUrl(previewUrl: string): string {
  const target = new URL(previewUrl);
  if (target.protocol !== 'http:' || !isAllowedPreviewHost(target.hostname)) {
    return previewUrl;
  }
  return `${PREVIEW_PROXY_PREFIX}${target.host}${target.pathname}${target.search}${target.hash}`;
}

export function buildPreviewProxyTarget(requestUrl: string): URL {
  const path = requestUrl.startsWith(PREVIEW_PROXY_PREFIX)
    ? requestUrl.slice(PREVIEW_PROXY_PREFIX.length)
    : requestUrl.replace(/^\/+/, '');
  const slashIndex = path.indexOf('/');
  const authority = slashIndex === -1 ? path : path.slice(0, slashIndex);
  const targetPath = slashIndex === -1 ? '/' : path.slice(slashIndex);
  const target = new URL(`http://${authority}${targetPath}`);

  if (target.protocol !== 'http:') {
    throw new Error('Preview proxy only supports HTTP targets.');
  }
  if (target.port && target.port !== '8080') {
    throw new Error('Preview proxy only supports VM port 8080.');
  }
  if (!isAllowedPreviewHost(target.hostname)) {
    throw new Error('Preview proxy target must be localhost or a Tailnet IPv4 address.');
  }

  return target;
}
