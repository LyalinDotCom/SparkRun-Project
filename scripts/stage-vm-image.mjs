import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  promises as fs,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const MAX_RETRIES = 8;
export const CANONICAL_RELEASE_ROOT =
  'https://github.com/LyalinDotCom/SparkRun-Project/releases/download';
// A 1600 MiB immutable image can legitimately take several minutes even on a
// healthy connection. Keep each attempt bounded, but do not turn ordinary
// consumer-bandwidth downloads into nine guaranteed full restarts.
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 15 * 60_000;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function withEightRetries(
  label,
  operation,
  {
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    retryDelay = delay,
  } = {},
) {
  let lastError;
  for (let retry = 0; retry <= MAX_RETRIES; retry += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(`${label} attempt ${retry + 1} timed out`),
      );
    }, attemptTimeoutMs);
    try {
      return await operation(retry, controller.signal);
    } catch (error) {
      lastError = error;
      if (retry === MAX_RETRIES) {
        break;
      }
      const waitMs = Math.min(500 * 2 ** retry, 8_000);
      console.warn(
        `${label} failed; retry ${retry + 1}/${MAX_RETRIES} in ${waitMs}ms`,
      );
      await retryDelay(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`${label} failed after 8 retries`, { cause: lastError });
}

export async function fetchChecked(
  url,
  signal,
  fetchImplementation = globalThis.fetch,
) {
  const response = await fetchImplementation(url, {
    redirect: 'follow',
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response;
}

export async function downloadToPartialWithRetries({
  url,
  partialPath,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  retryDelay,
  fetchImplementation = globalThis.fetch,
}) {
  await fs.rm(partialPath, { force: true });
  try {
    await withEightRetries(
      'VM image download',
      async (_retry, signal) => {
        await fs.rm(partialPath, { force: true });
        const response = await fetchChecked(url, signal, fetchImplementation);
        if (!response.body) {
          throw new Error('VM image response did not include a body');
        }
        await pipeline(
          Readable.fromWeb(response.body),
          createWriteStream(partialPath, { flags: 'wx' }),
          { signal },
        );
      },
      { attemptTimeoutMs, retryDelay },
    );
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}

export async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(path, label) {
  let text;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${label} is missing: ${path}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}`, { cause: error });
  }
}

function validateImageMetadata(imageMetadata) {
  invariant(isRecord(imageMetadata), 'vm-image/image.json must contain an object');
  invariant(
    Number.isSafeInteger(imageMetadata.schemaVersion) &&
      imageMetadata.schemaVersion > 0,
    'VM image schemaVersion must be a positive integer',
  );
  invariant(
    typeof imageMetadata.profileId === 'string' && imageMetadata.profileId.length > 0,
    'VM image profileId is missing',
  );
  invariant(
    typeof imageMetadata.version === 'string' && imageMetadata.version.length > 0,
    'VM image version is missing',
  );
  invariant(
    typeof imageMetadata.diskFile === 'string' &&
      imageMetadata.diskFile.endsWith('.ext2') &&
      !imageMetadata.diskFile.includes('/') &&
      !imageMetadata.diskFile.includes('\\'),
    'VM image diskFile must be a local .ext2 filename',
  );
  invariant(
    Number.isFinite(imageMetadata.imageSizeMiB) && imageMetadata.imageSizeMiB > 0,
    'VM image imageSizeMiB must be positive',
  );
}

function parseChecksum(checksumText, imageMetadata) {
  for (const line of checksumText.split('\n')) {
    const checksumMatch = line.match(/^([a-f0-9]{64})[ \t]+\*?(.+)$/);
    if (checksumMatch && checksumMatch[2].trim() === imageMetadata.diskFile) {
      return checksumMatch[1];
    }
  }
  throw new Error('Release checksum does not match vm-image/image.json');
}

function validatePublishedManifest(
  publishedManifest,
  imageMetadata,
  expectedSha256,
) {
  invariant(isRecord(publishedManifest), 'Release manifest must contain an object');
  invariant(
    publishedManifest.schemaVersion === imageMetadata.schemaVersion,
    'Release manifest schema does not match vm-image/image.json',
  );
  invariant(
    publishedManifest.profileId === imageMetadata.profileId,
    'Release manifest profile ID does not match vm-image/image.json',
  );
  invariant(
    publishedManifest.version === imageMetadata.version,
    'Release manifest version does not match vm-image/image.json',
  );
  invariant(
    publishedManifest.diskFile === imageMetadata.diskFile,
    'Release manifest filename does not match vm-image/image.json',
  );
  invariant(
    publishedManifest.imageSizeMiB === imageMetadata.imageSizeMiB,
    'Release manifest image size does not match vm-image/image.json',
  );
  invariant(
    publishedManifest.diskSha256 === expectedSha256,
    'Release manifest SHA-256 does not match disk.sha256',
  );
  invariant(
    typeof publishedManifest.sourceCommit === 'string' &&
      /^[a-f0-9]{40}$/.test(publishedManifest.sourceCommit),
    'Release manifest source commit is missing or invalid',
  );
  invariant(
    publishedManifest.toolchain?.smokePassed === true,
    'Release manifest does not prove the container toolchain smoke passed',
  );
  invariant(
    publishedManifest.toolchain?.nodeCompatibility?.conformancePassed === true,
    'Release manifest does not prove Node compatibility conformance passed',
  );
}

function validateBuiltReleaseManifest(releaseManifest, imageMetadata) {
  invariant(isRecord(releaseManifest), 'dist/release.json must contain an object');
  invariant(
    releaseManifest.schemaVersion === 1,
    'dist/release.json has an unsupported schema',
  );
  invariant(
    releaseManifest.state === 'built' || releaseManifest.state === 'staged',
    'dist/release.json was not generated by the production build',
  );
  invariant(
    Array.isArray(releaseManifest.app?.assets) &&
      releaseManifest.app.assets.length > 0,
    'dist/release.json has no app asset inventory; run npm run build first',
  );
  invariant(
    releaseManifest.image?.profileId === imageMetadata.profileId &&
      releaseManifest.image?.version === imageMetadata.version &&
      releaseManifest.image?.diskFile === imageMetadata.diskFile &&
      releaseManifest.image?.sizeBytes === imageMetadata.imageSizeMiB * 1024 * 1024,
    'dist/release.json image metadata does not match vm-image/image.json; rebuild first',
  );
}

async function writeJsonAtomic(path, value) {
  const temporaryPath = `${path}.staging-${process.pid}`;
  await fs.rm(temporaryPath, { force: true });
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await fs.rename(temporaryPath, path);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function downloadTextWithRetries({
  label,
  url,
  attemptTimeoutMs,
  retryDelay,
  fetchImplementation,
}) {
  return withEightRetries(
    label,
    async (_retry, signal) => {
      const response = await fetchChecked(url, signal, fetchImplementation);
      return response.text();
    },
    { attemptTimeoutMs, retryDelay },
  );
}

export async function stageVmImage(options = {}) {
  const projectRoot = resolve(
    options.projectRoot ?? dirname(fileURLToPath(import.meta.url)),
    options.projectRoot ? '.' : '..',
  );
  const imageMetadataPath = resolve(
    options.imageMetadataPath ?? join(projectRoot, 'vm-image/image.json'),
  );
  const imageMetadata = JSON.parse(
    await fs.readFile(imageMetadataPath, 'utf8'),
  );
  validateImageMetadata(imageMetadata);
  const releaseTag = `vm-image-${imageMetadata.version}`;
  const releaseRoot =
    options.releaseRoot ??
    `${CANONICAL_RELEASE_ROOT}/${releaseTag}`;
  const destinationRoot = resolve(
    options.destinationRoot ??
      process.env.SPARKRUN_VM_IMAGE_DIR ??
      join(projectRoot, 'dist/vm-images'),
  );
  const cacheRoot = resolve(
    options.cacheRoot ??
      process.env.SPARKRUN_VM_IMAGE_CACHE_DIR ??
      join(projectRoot, '.cache/sparkrun-vm-images'),
  );
  const releaseManifestPath = resolve(
    options.releaseManifestPath ??
      process.env.SPARKRUN_RELEASE_MANIFEST_PATH ??
      join(projectRoot, 'dist/release.json'),
  );
  const configuredTimeoutMs = Number(
    options.attemptTimeoutMs ??
      process.env.SPARKRUN_VM_DOWNLOAD_TIMEOUT_MS ??
      DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    throw new Error('SPARKRUN_VM_DOWNLOAD_TIMEOUT_MS must be a positive number');
  }
  const retryDelay = options.retryDelay;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;

  const destinationPath = join(destinationRoot, imageMetadata.diskFile);
  const cachePath = join(cacheRoot, imageMetadata.diskFile);
  const partialPath = `${cachePath}.partial-${process.pid}`;
  const builtReleaseManifest = await readJson(
    releaseManifestPath,
    'production build release manifest',
  );
  validateBuiltReleaseManifest(builtReleaseManifest, imageMetadata);

  const checksumText = await downloadTextWithRetries({
    label: 'checksum download',
    url: `${releaseRoot}/disk.sha256`,
    attemptTimeoutMs: configuredTimeoutMs,
    retryDelay,
    fetchImplementation,
  });
  const expectedSha256 = parseChecksum(checksumText, imageMetadata);
  const publishedManifestText = await downloadTextWithRetries({
    label: 'release manifest download',
    url: `${releaseRoot}/manifest.json`,
    attemptTimeoutMs: configuredTimeoutMs,
    retryDelay,
    fetchImplementation,
  });
  let publishedManifest;
  try {
    publishedManifest = JSON.parse(publishedManifestText);
  } catch (error) {
    throw new Error('Release manifest is not valid JSON', { cause: error });
  }
  validatePublishedManifest(publishedManifest, imageMetadata, expectedSha256);
  const expectedBytes = imageMetadata.imageSizeMiB * 1024 * 1024;

  await fs.mkdir(cacheRoot, { recursive: true });
  const currentStat = await fs.stat(cachePath).catch(() => null);
  if (currentStat?.size === expectedBytes) {
    const currentSha256 = await sha256(cachePath);
    if (currentSha256 === expectedSha256) {
      console.log(`VM image cache verified: ${cachePath}`);
    } else {
      await fs.rm(cachePath, { force: true });
    }
  } else if (currentStat) {
    await fs.rm(cachePath, { force: true });
  }

  if (!(await fs.stat(cachePath).catch(() => null))) {
    await downloadToPartialWithRetries({
      url: `${releaseRoot}/${imageMetadata.diskFile}`,
      partialPath,
      attemptTimeoutMs: configuredTimeoutMs,
      retryDelay,
      fetchImplementation,
    });

    const downloadedStat = await fs.stat(partialPath);
    if (downloadedStat.size !== expectedBytes) {
      await fs.rm(partialPath, { force: true });
      throw new Error(
        `VM image size mismatch: expected ${expectedBytes}, received ${downloadedStat.size}`,
      );
    }
    const downloadedSha256 = await sha256(partialPath);
    if (downloadedSha256 !== expectedSha256) {
      await fs.rm(partialPath, { force: true });
      throw new Error('VM image SHA-256 mismatch');
    }
    await fs.rename(partialPath, cachePath);
  }

  await fs.mkdir(destinationRoot, { recursive: true });
  const destinationTempPath = `${destinationPath}.staging-${process.pid}`;
  await fs.rm(destinationTempPath, { force: true });
  try {
    // A real copy (clone-on-write when the filesystem supports it), never a
    // hard link: the cache file stays mutable, and a link would let later
    // cache writes silently rewrite the verified dist bytes.
    try {
      await fs.copyFile(
        cachePath,
        destinationTempPath,
        fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL,
      );
    } catch {
      await fs.copyFile(cachePath, destinationTempPath);
    }
    await fs.rename(destinationTempPath, destinationPath);
  } catch (error) {
    await fs.rm(destinationTempPath, { force: true });
    throw error;
  }
  const manifestDirectory = dirname(releaseManifestPath);
  const stagedPath = relative(manifestDirectory, destinationPath)
    .split(sep)
    .join('/');
  invariant(
    stagedPath === `vm-images/${imageMetadata.diskFile}`,
    'VM image destination must be dist/vm-images beside dist/release.json',
  );
  const finalizedReleaseManifest = {
    ...builtReleaseManifest,
    state: 'staged',
    image: {
      ...builtReleaseManifest.image,
      sha256: expectedSha256,
      sourceCommit: publishedManifest.sourceCommit,
      releaseTag,
      releaseUrl: releaseRoot,
      releaseManifestSha256: sha256Text(publishedManifestText),
      stagedPath,
    },
  };
  await writeJsonAtomic(releaseManifestPath, finalizedReleaseManifest);
  console.log(`Staged verified VM image: ${destinationPath}`);
  return {
    cachePath,
    destinationPath,
    expectedBytes,
    expectedSha256,
    publishedManifest,
    releaseManifest: finalizedReleaseManifest,
  };
}

export async function main() {
  await stageVmImage();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
