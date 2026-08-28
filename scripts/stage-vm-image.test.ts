// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadToPartialWithRetries,
  stageVmImage,
  withEightRetries,
} from './stage-vm-image.mjs';

const servers: Server[] = [];
const temporaryRoots: string[] = [];
const FIXTURE_COMMIT = 'a'.repeat(40);
// These release-staging cases intentionally exercise real localhost HTTP,
// streaming, hashing, atomic filesystem writes, and cleanup. Shared CI runners
// can take longer than Vitest's 5 s unit-test default while the full suite runs
// in parallel, even though no production timeout has fired.
const RELEASE_STAGING_TEST_TIMEOUT_MS = 20_000;

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createReleaseFixture(options: {
  diskBody?: Buffer;
  checksumSha?: string;
  checksumFile?: string;
  checksumBody?: string;
  manifestOverrides?: Record<string, unknown>;
} = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'sparkrun-stage-main-test-'));
  temporaryRoots.push(root);
  const diskBody = options.diskBody ?? Buffer.alloc(1024 * 1024, 0x5a);
  const metadata = {
    schemaVersion: 1,
    profileId: 'fixture-image',
    version: 'fixture-rc1',
    diskFile: 'fixture-rc1.ext2',
    imageSizeMiB: 1,
  };
  const checksumSha = options.checksumSha ?? sha256(diskBody);
  const manifest = {
    ...metadata,
    diskSha256: checksumSha,
    sourceCommit: FIXTURE_COMMIT,
    toolchain: {
      smokePassed: true,
      nodeCompatibility: { conformancePassed: true },
    },
    ...options.manifestOverrides,
  };
  const distRoot = join(root, 'dist');
  const metadataPath = join(root, 'image.json');
  const releaseManifestPath = join(distRoot, 'release.json');
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await fs.writeFile(
    releaseManifestPath,
    JSON.stringify({
      schemaVersion: 1,
      state: 'built',
      app: {
        assets: [
          {
            path: 'index.html',
            sizeBytes: 0,
            sha256: '0'.repeat(64),
          },
        ],
      },
      image: {
        profileId: metadata.profileId,
        version: metadata.version,
        diskFile: metadata.diskFile,
        sizeBytes: metadata.imageSizeMiB * 1024 * 1024,
        sha256: null,
        sourceCommit: null,
        releaseTag: `vm-image-${metadata.version}`,
        releaseUrl: null,
        releaseManifestSha256: null,
        stagedPath: null,
      },
    }),
  );

  const requests = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    requests.set(path, (requests.get(path) ?? 0) + 1);
    if (path === '/disk.sha256') {
      response.end(
        options.checksumBody ??
          `${checksumSha}  ${options.checksumFile ?? metadata.diskFile}\n`,
      );
      return;
    }
    if (path === '/manifest.json') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(manifest));
      return;
    }
    if (path === `/${metadata.diskFile}`) {
      response.end(diskBody);
      return;
    }
    response.writeHead(404).end('missing');
  });
  servers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not bind a TCP port');
  }
  const destinationRoot = join(distRoot, 'vm-images');
  const cacheRoot = join(root, 'cache');
  const stageOptions = {
    projectRoot: root,
    imageMetadataPath: metadataPath,
    releaseRoot: `http://127.0.0.1:${address.port}`,
    destinationRoot,
    cacheRoot,
    releaseManifestPath,
    attemptTimeoutMs: 2_000,
    retryDelay: async () => undefined,
  };
  return {
    root,
    diskBody,
    metadata,
    manifest,
    requests,
    destinationRoot,
    cacheRoot,
    releaseManifestPath,
    stageOptions,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  await Promise.all(
    temporaryRoots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});

describe('VM image staging retries', () => {
  it('makes an initial attempt plus exactly eight retries', async () => {
    let attempts = 0;
    await expect(
      withEightRetries(
        'test operation',
        async () => {
          attempts += 1;
          throw new Error('transient');
        },
        { retryDelay: async () => undefined },
      ),
    ).rejects.toThrow('failed after 8 retries');
    expect(attempts).toBe(9);
  });

  it('aborts stalled response bodies nine times and removes the partial file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let attempts = 0;
    const server = createServer((_request, response) => {
      attempts += 1;
      response.writeHead(200, { 'content-type': 'application/octet-stream' });
      response.flushHeaders();
      response.write('partial');
      // Deliberately never end the response. Each per-attempt AbortSignal must
      // terminate both fetch body streaming and the destination pipeline.
    });
    servers.push(server);
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind a TCP port');
    }

    const root = await fs.mkdtemp(join(tmpdir(), 'sparkrun-stage-test-'));
    temporaryRoots.push(root);
    const partialPath = join(root, 'image.ext2.partial');

    await expect(
      downloadToPartialWithRetries({
        url: `http://127.0.0.1:${address.port}/image.ext2`,
        partialPath,
        // Leave enough time for the request to reach the local server even
        // while the full suite and production build are sharing CPU. The body
        // still stalls until the per-attempt abort fires.
        attemptTimeoutMs: 200,
        retryDelay: async () => undefined,
      }),
    ).rejects.toThrow('failed after 8 retries');

    expect(attempts).toBe(9);
    await expect(fs.stat(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('VM image release staging', () => {
  it(
    'links checksum, manifest, exact image bytes, cache, and dist/release.json',
    async () => {
      const fixture = await createReleaseFixture();

      const result = await stageVmImage(fixture.stageOptions);

      expect(await fs.readFile(result.destinationPath)).toEqual(fixture.diskBody);
      expect(await fs.readFile(result.cachePath)).toEqual(fixture.diskBody);
      expect(result.expectedSha256).toBe(sha256(fixture.diskBody));
      const release = JSON.parse(
        await fs.readFile(fixture.releaseManifestPath, 'utf8'),
      );
      expect(release).toMatchObject({
        state: 'staged',
        image: {
          version: fixture.metadata.version,
          diskFile: fixture.metadata.diskFile,
          sizeBytes: fixture.diskBody.length,
          sha256: sha256(fixture.diskBody),
          sourceCommit: FIXTURE_COMMIT,
          releaseTag: `vm-image-${fixture.metadata.version}`,
          stagedPath: `vm-images/${fixture.metadata.diskFile}`,
        },
      });
      expect(release.image.releaseManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    },
    RELEASE_STAGING_TEST_TIMEOUT_MS,
  );

  it('rejects a checksum filename that does not match image metadata', async () => {
    const fixture = await createReleaseFixture({ checksumFile: 'other.ext2' });

    await expect(stageVmImage(fixture.stageOptions)).rejects.toThrow(
      'checksum does not match',
    );
    await expect(
      fs.stat(join(fixture.destinationRoot, fixture.metadata.diskFile)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it(
    'selects the checksum entry whose filename matches the disk file',
    async () => {
      const diskBody = Buffer.alloc(1024 * 1024, 0x5a);
      const fixture = await createReleaseFixture({
        diskBody,
        checksumBody:
          `${'e'.repeat(64)}  other.ext2\n` +
          `${sha256(diskBody)}  fixture-rc1.ext2\n`,
      });

      const result = await stageVmImage(fixture.stageOptions);

      expect(result.expectedSha256).toBe(sha256(diskBody));
    },
    RELEASE_STAGING_TEST_TIMEOUT_MS,
  );

  it('rejects a checksum whose hash and filename only pair across lines', async () => {
    const diskBody = Buffer.alloc(1024 * 1024, 0x5a);
    const fixture = await createReleaseFixture({
      diskBody,
      checksumBody: `${sha256(diskBody)}\nfixture-rc1.ext2\n`,
    });

    await expect(stageVmImage(fixture.stageOptions)).rejects.toThrow(
      'checksum does not match',
    );
  });

  it('rejects a manifest that is not linked to the checksum and image metadata', async () => {
    const fixture = await createReleaseFixture({
      manifestOverrides: { diskSha256: 'f'.repeat(64) },
    });

    await expect(stageVmImage(fixture.stageOptions)).rejects.toThrow(
      'manifest SHA-256 does not match',
    );
  });

  it('rejects the wrong byte size without replacing an existing destination', async () => {
    const fixture = await createReleaseFixture({
      diskBody: Buffer.from('too-small'),
    });
    await fs.mkdir(fixture.destinationRoot, { recursive: true });
    const destination = join(fixture.destinationRoot, fixture.metadata.diskFile);
    await fs.writeFile(destination, 'previous-good-image');

    await expect(stageVmImage(fixture.stageOptions)).rejects.toThrow(
      'image size mismatch',
    );

    expect(await fs.readFile(destination, 'utf8')).toBe('previous-good-image');
    await expect(
      fs.stat(join(fixture.cacheRoot, fixture.metadata.diskFile)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a same-size image with the wrong SHA without publishing partial bytes', async () => {
    const expectedBody = Buffer.alloc(1024 * 1024, 0x41);
    const deliveredBody = Buffer.alloc(1024 * 1024, 0x42);
    const fixture = await createReleaseFixture({
      diskBody: deliveredBody,
      checksumSha: sha256(expectedBody),
    });

    await expect(stageVmImage(fixture.stageOptions)).rejects.toThrow(
      'SHA-256 mismatch',
    );
    await expect(
      fs.stat(join(fixture.destinationRoot, fixture.metadata.diskFile)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it(
    'stages an independent dist copy that later cache writes cannot mutate',
    async () => {
      const fixture = await createReleaseFixture();

      const result = await stageVmImage(fixture.stageOptions);

      const cacheStat = await fs.stat(result.cachePath);
      const destinationStat = await fs.stat(result.destinationPath);
      expect(destinationStat.ino).not.toBe(cacheStat.ino);

      await fs.writeFile(result.cachePath, 'corrupted-cache-bytes');
      expect(await fs.readFile(result.destinationPath)).toEqual(
        fixture.diskBody,
      );
    },
    RELEASE_STAGING_TEST_TIMEOUT_MS,
  );

  it(
    'reuses a verified cache without downloading the image again',
    async () => {
      const fixture = await createReleaseFixture();
      await stageVmImage(fixture.stageOptions);
      const destination = join(
        fixture.destinationRoot,
        fixture.metadata.diskFile,
      );
      await fs.rm(destination);

      await stageVmImage(fixture.stageOptions);

      expect(fixture.requests.get(`/${fixture.metadata.diskFile}`)).toBe(1);
      expect(await fs.readFile(destination)).toEqual(fixture.diskBody);
    },
    RELEASE_STAGING_TEST_TIMEOUT_MS,
  );
});
