// @vitest-environment node

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  validateFirebaseHostingConfig,
  validateDiagnosticsCheerpxPin,
  verifyReleaseDist,
} from './verify-release-dist.mjs';

const roots: string[] = [];
const APP_COMMIT = 'b'.repeat(40);
const IMAGE_COMMIT = 'a'.repeat(40);

function validFirebaseConfig() {
  const cacheRule = (source: string, value: string) => ({
    source,
    headers: [{ key: 'Cache-Control', value }],
  });
  return {
    hosting: {
      public: 'dist',
      predeploy: ['npm run release:verify'],
      headers: [
        cacheRule('/', 'no-cache'),
        cacheRule('/index.html', 'no-cache'),
        cacheRule('/diag.html', 'no-cache'),
        cacheRule('/release.json', 'no-cache'),
        cacheRule('/assets/**', 'public, max-age=31536000, immutable'),
        {
          source: '/vm-images/**',
          headers: [
            { key: 'Access-Control-Allow-Origin', value: '*' },
            { key: 'Access-Control-Allow-Headers', value: 'Range, If-Range' },
            { key: 'Access-Control-Allow-Methods', value: 'GET, HEAD, OPTIONS' },
            { key: 'Access-Control-Expose-Headers', value: 'Content-Range' },
            { key: 'Cross-Origin-Resource-Policy', value: 'cross-origin' },
            { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
          ],
        },
        {
          source: '**',
          headers: [
            { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
          ],
        },
      ],
    },
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createFixture(mode: 'built' | 'deploy' = 'built') {
  const root = await fs.mkdtemp(join(tmpdir(), 'sparkrun-release-verify-'));
  roots.push(root);
  const distRoot = join(root, 'dist');
  await fs.mkdir(join(root, 'public'), { recursive: true });
  await fs.writeFile(
    join(root, 'public/diag.html'),
    `<!doctype html>
<html>
  <head><title>CheerpX 1.3.9 Isolation Test</title></head>
  <body>
    <h1>CheerpX 1.3.9 — isolation test</h1>
    <script type="module">
      await import('https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js');
      await import('https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js');
    </script>
  </body>
</html>`,
  );
  await fs.mkdir(join(distRoot, 'assets'), { recursive: true });
  const appAssetPath = 'assets/app-abcdefgh.js';
  const indexHtml = `<script type="module" src="/${appAssetPath}"></script>`;
  const appJs = 'console.log("release fixture")\n';
  await fs.writeFile(join(distRoot, 'index.html'), indexHtml);
  await fs.writeFile(join(distRoot, appAssetPath), appJs);

  const expected = {
    cheerpxPinnedVersion: '1.3.9',
    packageLockSha256: 'c'.repeat(64),
    disks: {
      default: {
        id: 'default-disk',
        label: 'Default disk',
        distribution: 'Default Linux',
        kind: 'cloud',
        url: 'wss://example.invalid/default.ext2',
      },
      candidate: {
        id: 'fixture-image-fixture-rc1',
        label: 'Fixture image',
        distribution: 'Fixture Linux',
        kind: 'bytes',
        url: '/vm-images/fixture-rc1.ext2',
      },
    },
    imageMetadata: {
      schemaVersion: 1,
      profileId: 'fixture-image',
      version: 'fixture-rc1',
      diskFile: 'fixture-rc1.ext2',
      imageSizeMiB: 1 / 1024,
    },
    releaseUrl: 'https://example.invalid/releases/fixture-rc1',
  };
  const image = Buffer.alloc(1024, 0x71);
  const manifest = {
    schemaVersion: 1,
    state: mode === 'deploy' ? 'staged' : 'built',
    app: {
      commit: APP_COMMIT,
      dirty: false,
      buildTime: '2026-08-28T03:30:00.000Z',
      cheerpxPinnedVersion: expected.cheerpxPinnedVersion,
      packageLockSha256: expected.packageLockSha256,
      assets: [
        {
          path: appAssetPath,
          sizeBytes: Buffer.byteLength(appJs),
          sha256: sha256(appJs),
        },
        {
          path: 'index.html',
          sizeBytes: Buffer.byteLength(indexHtml),
          sha256: sha256(indexHtml),
        },
      ],
    },
    disks: expected.disks,
    image: {
      profileId: expected.imageMetadata.profileId,
      version: expected.imageMetadata.version,
      diskFile: expected.imageMetadata.diskFile,
      sizeBytes: image.length,
      sha256: mode === 'deploy' ? sha256(image) : null,
      sourceCommit: mode === 'deploy' ? IMAGE_COMMIT : null,
      releaseTag: `vm-image-${expected.imageMetadata.version}`,
      releaseUrl:
        mode === 'deploy'
          ? expected.releaseUrl
          : null,
      releaseManifestSha256: mode === 'deploy' ? 'd'.repeat(64) : null,
      stagedPath:
        mode === 'deploy'
          ? `vm-images/${expected.imageMetadata.diskFile}`
          : null,
    },
  };
  if (mode === 'deploy') {
    await fs.mkdir(join(distRoot, 'vm-images'));
    await fs.writeFile(
      join(distRoot, 'vm-images', expected.imageMetadata.diskFile),
      image,
    );
  }
  await fs.writeFile(
    join(distRoot, 'release.json'),
    JSON.stringify(manifest),
  );
  return { root, distRoot, expected, image, manifest };
}

function options(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mode: 'source' | 'built' | 'deploy',
) {
  return {
    projectRoot: fixture.root,
    mode,
    expected: fixture.expected,
    gitState: { commit: APP_COMMIT, dirty: false },
    isAncestor: () => true,
  };
}

describe('release dist verification', () => {
  it('requires every diagnostics runtime URL and visible version to use the installed pin', () => {
    const valid = `
      <title>CheerpX 1.3.9 Isolation Test</title>
      <body><h1>CheerpX 1.3.9</h1></body>
      <script>
        import('https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js');
        import('https://cxrtnc.leaningtech.com/1.3.9/cx.esm.js');
      </script>
    `;
    expect(validateDiagnosticsCheerpxPin(valid, '1.3.9')).toEqual({
      runtimeUrlCount: 2,
      version: '1.3.9',
    });
    expect(() =>
      validateDiagnosticsCheerpxPin(
        valid.replace(
          'https://cxrtnc.leaningtech.com/1.3.9/',
          'https://cxrtnc.leaningtech.com/1.3.8/',
        ),
        '1.3.9',
      ),
    ).toThrow('runtime version 1.3.8 does not match installed package 1.3.9');
    expect(() =>
      validateDiagnosticsCheerpxPin(
        valid.replaceAll(
          'https://cxrtnc.leaningtech.com/1.3.9/',
          'https://cxrtnc.leaningtech.com/latest/',
        ),
        '1.3.9',
      ),
    ).toThrow('malformed');
    expect(() =>
      validateDiagnosticsCheerpxPin(
        valid.replaceAll(
          /https:\/\/cxrtnc\.leaningtech\.com\/1\.3\.9\/cx\.esm\.js/g,
          'local-runtime.js',
        ),
        '1.3.9',
      ),
    ).toThrow('contains no CheerpX runtime URL');
    expect(() =>
      validateDiagnosticsCheerpxPin(
        valid.replaceAll('CheerpX 1.3.9', 'CheerpX 1.3.8'),
        '1.3.9',
      ),
    ).toThrow('visible CheerpX version 1.3.8');
  });

  it.each(['source', 'built', 'deploy'] as const)(
    'rejects a retargeted diagnostics import during %s verification',
    async (mode) => {
      const fixture = await createFixture(
        mode === 'deploy' ? 'deploy' : 'built',
      );
      const diagnosticsPath = join(fixture.root, 'public/diag.html');
      const diagnostics = await fs.readFile(diagnosticsPath, 'utf8');
      await fs.writeFile(
        diagnosticsPath,
        diagnostics.replace(
          'https://cxrtnc.leaningtech.com/1.3.9/',
          'https://cxrtnc.leaningtech.com/1.3.8/',
        ),
      );

      await expect(
        verifyReleaseDist(options(fixture, mode)),
      ).rejects.toThrow(
        'runtime version 1.3.8 does not match installed package 1.3.9',
      );
    },
  );

  it('pins isolation, HTML revalidation, immutable assets, and VM-image CORS', () => {
    const config = validFirebaseConfig();
    expect(() => validateFirebaseHostingConfig(config)).not.toThrow();

    const missingCoep = structuredClone(config);
    missingCoep.hosting.headers.find(({ source }) => source === '**')!.headers = [];
    expect(() => validateFirebaseHostingConfig(missingCoep)).toThrow(
      'Cross-Origin-Opener-Policy',
    );

    const staleHtml = structuredClone(config);
    staleHtml.hosting.headers.find(({ source }) => source === '/diag.html')!
      .headers[0].value = 'max-age=3600';
    expect(() => validateFirebaseHostingConfig(staleHtml)).toThrow(
      '/diag.html cache policy',
    );

    const staleReleaseMetadata = structuredClone(config);
    staleReleaseMetadata.hosting.headers.find(
      ({ source }) => source === '/release.json',
    )!.headers[0].value = 'max-age=3600';
    expect(() => validateFirebaseHostingConfig(staleReleaseMetadata)).toThrow(
      '/release.json cache policy',
    );

    const mutableAssets = structuredClone(config);
    mutableAssets.hosting.headers.find(({ source }) => source === '/assets/**')!
      .headers[0].value = 'public, max-age=31536000';
    expect(() => validateFirebaseHostingConfig(mutableAssets)).toThrow(
      '/assets/** cache policy',
    );

    const duplicateHeaderKey = structuredClone(config);
    duplicateHeaderKey.hosting.headers.find(
      ({ source }) => source === '/diag.html',
    )!.headers.push({ key: 'cache-control', value: 'max-age=3600' });
    expect(() => validateFirebaseHostingConfig(duplicateHeaderKey)).toThrow(
      'declares cache-control more than once',
    );

    const missingVmCors = structuredClone(config);
    missingVmCors.hosting.headers.find(({ source }) => source === '/vm-images/**')!
      .headers = [];
    expect(() => validateFirebaseHostingConfig(missingVmCors)).toThrow(
      'browser diagnostics on another origin',
    );

    const missingConditionalRange = structuredClone(config);
    missingConditionalRange.hosting.headers.find(
      ({ source }) => source === '/vm-images/**',
    )!.headers.find(
      ({ key }) => key === 'Access-Control-Allow-Headers',
    )!.value = 'Range';
    expect(() => validateFirebaseHostingConfig(missingConditionalRange)).toThrow(
      'Range and If-Range',
    );

    const missingPreflightMethod = structuredClone(config);
    missingPreflightMethod.hosting.headers.find(
      ({ source }) => source === '/vm-images/**',
    )!.headers.find(
      ({ key }) => key === 'Access-Control-Allow-Methods',
    )!.value = 'GET, HEAD';
    expect(() => validateFirebaseHostingConfig(missingPreflightMethod)).toThrow(
      'GET, HEAD, and OPTIONS',
    );
  });

  it('keeps the repository Firebase and release-script guards wired', async () => {
    await expect(
      verifyReleaseDist({
        projectRoot: process.cwd(),
        mode: 'source',
        gitState: { commit: APP_COMMIT, dirty: false },
      }),
    ).resolves.toMatchObject({ mode: 'source', commit: APP_COMMIT });
  });

  it('accepts a clean build with a byte-exact app asset inventory and no VM image', async () => {
    const fixture = await createFixture('built');

    const result = await verifyReleaseDist(options(fixture, 'built'));

    expect(result.mode).toBe('built');
  });

  it('accepts a deploy only when the exact staged image and provenance are present', async () => {
    const fixture = await createFixture('deploy');

    const result = await verifyReleaseDist(options(fixture, 'deploy'));

    expect(result.manifest.image.sha256).toBe(sha256(fixture.image));
  });

  it('rejects a dirty source tree before trusting dist', async () => {
    const fixture = await createFixture('built');

    await expect(
      verifyReleaseDist({
        ...options(fixture, 'built'),
        gitState: { commit: APP_COMMIT, dirty: true },
      }),
    ).rejects.toThrow('clean Git worktree');
  });

  it.skipIf(process.getuid?.() === 0)(
    'propagates dist listing failures with the failing path instead of a missing-root report',
    async () => {
      const fixture = await createFixture('built');
      const assetsDir = join(fixture.distRoot, 'assets');
      await fs.chmod(assetsDir, 0o000);

      try {
        await expect(
          verifyReleaseDist(options(fixture, 'built')),
        ).rejects.toThrow(
          `Could not read release output directory: ${assetsDir}`,
        );
      } finally {
        await fs.chmod(assetsDir, 0o755);
      }
    },
  );

  it('rejects app files changed after the build manifest was generated', async () => {
    const fixture = await createFixture('built');
    await fs.writeFile(join(fixture.distRoot, 'assets/app-abcdefgh.js'), 'tampered');

    await expect(
      verifyReleaseDist(options(fixture, 'built')),
    ).rejects.toThrow(/asset (size|content) changed/i);
  });

  it('rejects an immutable app asset without a content-hashed filename', async () => {
    const fixture = await createFixture('built');
    const hashedPath = join(fixture.distRoot, 'assets/app-abcdefgh.js');
    const unhashedPath = join(fixture.distRoot, 'assets/app.js');
    await fs.rename(hashedPath, unhashedPath);
    fixture.manifest.app.assets[0].path = 'assets/app.js';
    fixture.manifest.app.assets[1].sha256 = sha256(
      '<script type="module" src="/assets/app.js"></script>',
    );
    fixture.manifest.app.assets[1].sizeBytes = Buffer.byteLength(
      '<script type="module" src="/assets/app.js"></script>',
    );
    await fs.writeFile(
      join(fixture.distRoot, 'index.html'),
      '<script type="module" src="/assets/app.js"></script>',
    );
    await fs.writeFile(
      join(fixture.distRoot, 'release.json'),
      JSON.stringify(fixture.manifest),
    );

    await expect(
      verifyReleaseDist(options(fixture, 'built')),
    ).rejects.toThrow('does not have a content-hashed filename');
  });

  it('rejects deploy verification before the image has been staged', async () => {
    const fixture = await createFixture('built');

    await expect(
      verifyReleaseDist(options(fixture, 'deploy')),
    ).rejects.toThrow('not in staged state');
  });

  it('rejects an image staged from a noncanonical release origin', async () => {
    const fixture = await createFixture('deploy');
    fixture.manifest.image.releaseUrl =
      'https://attacker.invalid/releases/fixture-rc1';
    await fs.writeFile(
      join(fixture.distRoot, 'release.json'),
      JSON.stringify(fixture.manifest),
    );

    await expect(
      verifyReleaseDist(options(fixture, 'deploy')),
    ).rejects.toThrow('not the canonical pinned GitHub Release');
  });

  it('rejects a staged image whose bytes no longer match release.json', async () => {
    const fixture = await createFixture('deploy');
    await fs.writeFile(
      join(
        fixture.distRoot,
        'vm-images',
        fixture.expected.imageMetadata.diskFile,
      ),
      Buffer.alloc(fixture.image.length, 0x72),
    );

    await expect(
      verifyReleaseDist(options(fixture, 'deploy')),
    ).rejects.toThrow('SHA-256 does not match');
  });

  it('rejects extra VM images and a source commit outside app history', async () => {
    const fixture = await createFixture('deploy');
    await fs.writeFile(join(fixture.distRoot, 'vm-images/old.ext2'), 'old');

    await expect(
      verifyReleaseDist(options(fixture, 'deploy')),
    ).rejects.toThrow('exactly the pinned VM image');

    await fs.rm(join(fixture.distRoot, 'vm-images/old.ext2'));
    await expect(
      verifyReleaseDist({
        ...options(fixture, 'deploy'),
        isAncestor: () => false,
      }),
    ).rejects.toThrow('not an ancestor');
  });
});
