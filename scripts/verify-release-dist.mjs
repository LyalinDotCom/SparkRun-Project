import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const CANONICAL_RELEASE_ROOT =
  'https://github.com/LyalinDotCom/SparkRun-Project/releases/download';
const CHEERPX_RUNTIME_HOST = 'cxrtnc.leaningtech.com';
const CHEERPX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateDiagnosticsCheerpxPin(source, installedVersion) {
  invariant(
    typeof source === 'string',
    'public/diag.html must contain text',
  );
  invariant(
    typeof installedVersion === 'string' &&
      CHEERPX_VERSION_PATTERN.test(installedVersion),
    'Installed CheerpX package version is invalid',
  );

  const hostOccurrences = Array.from(
    source.matchAll(/cxrtnc\.leaningtech\.com/g),
  );
  invariant(
    hostOccurrences.length > 0,
    'public/diag.html contains no CheerpX runtime URL',
  );

  const runtimeUrls = Array.from(
    source.matchAll(
      /https:\/\/cxrtnc\.leaningtech\.com\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\//g,
    ),
  );
  invariant(
    runtimeUrls.length === hostOccurrences.length,
    `public/diag.html contains a malformed ${CHEERPX_RUNTIME_HOST}/<version>/ runtime URL`,
  );
  for (const [, runtimeVersion] of runtimeUrls) {
    invariant(
      runtimeVersion === installedVersion,
      `public/diag.html CheerpX runtime version ${runtimeVersion} does not match installed package ${installedVersion}`,
    );
  }

  const markupWithoutCode = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  const versionDeclarations = Array.from(
    markupWithoutCode.matchAll(
      /<(title|h[1-6]|label)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    ),
    (match) =>
      match[2]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' '),
  );
  for (const declaration of versionDeclarations) {
    const declaredVersions = Array.from(
      declaration.matchAll(
        /\bCheerpX\b\s*(?:runtime\s*)?(?:v(?:ersion)?\s*)?(\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?)\b/gi,
      ),
      (match) => match[1],
    );
    for (const declaredVersion of declaredVersions) {
      invariant(
        declaredVersion === installedVersion,
        `public/diag.html visible CheerpX version ${declaredVersion} does not match installed package ${installedVersion}`,
      );
    }
  }

  return {
    runtimeUrlCount: runtimeUrls.length,
    version: installedVersion,
  };
}

async function verifyDiagnosticsCheerpxPin(projectRoot, installedVersion) {
  const diagnosticsPath = join(projectRoot, 'public/diag.html');
  let source;
  try {
    source = await fs.readFile(diagnosticsPath, 'utf8');
  } catch (error) {
    throw new Error(`Diagnostics page is missing: ${diagnosticsPath}`, {
      cause: error,
    });
  }
  return validateDiagnosticsCheerpxPin(source, installedVersion);
}

function headerMapForUniqueRule(firebaseConfig, source) {
  const matchingRules = (firebaseConfig.hosting?.headers ?? []).filter(
    (rule) => rule?.source === source,
  );
  invariant(
    matchingRules.length === 1,
    `Firebase Hosting must define exactly one header rule for ${source}`,
  );
  return new Map(
    (matchingRules[0].headers ?? []).map((header) => [
      String(header?.key ?? '').toLowerCase(),
      String(header?.value ?? ''),
    ]),
  );
}

function assertExactHeader(headers, key, expectedValue, message) {
  invariant(
    (headers.get(key.toLowerCase()) ?? '').toLowerCase() ===
      expectedValue.toLowerCase(),
    message,
  );
}

function assertCacheTokens(headers, source, expectedTokens) {
  const tokens = (headers.get('cache-control') ?? '')
    .toLowerCase()
    .split(/\s*,\s*/)
    .filter(Boolean);
  invariant(
    tokens.length === expectedTokens.length &&
      expectedTokens.every((token) => tokens.includes(token)),
    `Firebase ${source} cache policy must be ${expectedTokens.join(', ')}`,
  );
}

function assertCommaSeparatedHeaderIncludes(
  headers,
  key,
  requiredValues,
  message,
) {
  const values = (headers.get(key.toLowerCase()) ?? '')
    .toLowerCase()
    .split(/\s*,\s*/)
    .filter(Boolean);
  invariant(
    requiredValues.every((value) => values.includes(value.toLowerCase())),
    message,
  );
}

export function validateFirebaseHostingConfig(firebaseConfig) {
  invariant(
    firebaseConfig.hosting?.public === 'dist',
    'Firebase Hosting must deploy dist',
  );
  invariant(
    Array.isArray(firebaseConfig.hosting?.predeploy) &&
      firebaseConfig.hosting.predeploy.includes('npm run release:verify'),
    'Firebase Hosting must run the fail-closed release verifier before deploy',
  );
  invariant(
    !Array.isArray(firebaseConfig.hosting?.rewrites) ||
      firebaseConfig.hosting.rewrites.length === 0,
    'Firebase Hosting rewrites are disabled so missing VM images return 404',
  );

  const globalHeaders = headerMapForUniqueRule(firebaseConfig, '**');
  assertExactHeader(
    globalHeaders,
    'cross-origin-opener-policy',
    'same-origin',
    'Firebase Hosting must keep Cross-Origin-Opener-Policy: same-origin',
  );
  assertExactHeader(
    globalHeaders,
    'cross-origin-embedder-policy',
    'require-corp',
    'Firebase Hosting must keep Cross-Origin-Embedder-Policy: require-corp',
  );

  for (const source of ['/', '/index.html', '/diag.html', '/release.json']) {
    assertCacheTokens(
      headerMapForUniqueRule(firebaseConfig, source),
      source,
      ['no-cache'],
    );
  }
  assertCacheTokens(
    headerMapForUniqueRule(firebaseConfig, '/assets/**'),
    '/assets/**',
    ['public', 'max-age=31536000', 'immutable'],
  );

  const vmImageHeaders = headerMapForUniqueRule(
    firebaseConfig,
    '/vm-images/**',
  );
  assertExactHeader(
    vmImageHeaders,
    'access-control-allow-origin',
    '*',
    'Firebase VM images must remain readable from browser diagnostics on another origin',
  );
  assertExactHeader(
    vmImageHeaders,
    'cross-origin-resource-policy',
    'cross-origin',
    'Firebase VM images must keep Cross-Origin-Resource-Policy: cross-origin',
  );
  assertCommaSeparatedHeaderIncludes(
    vmImageHeaders,
    'access-control-allow-headers',
    ['range', 'if-range'],
    'Firebase VM images must allow Range and If-Range CORS request headers',
  );
  assertCommaSeparatedHeaderIncludes(
    vmImageHeaders,
    'access-control-allow-methods',
    ['get', 'head', 'options'],
    'Firebase VM images must allow GET, HEAD, and OPTIONS for CORS',
  );
  assertCommaSeparatedHeaderIncludes(
    vmImageHeaders,
    'access-control-expose-headers',
    ['content-range'],
    'Firebase VM images must expose Content-Range for CheerpX HttpBytesDevice',
  );
  assertCacheTokens(
    vmImageHeaders,
    '/vm-images/**',
    ['public', 'max-age=31536000', 'immutable'],
  );
}

export async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    digest.update(chunk);
  }
  return digest.digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
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

function gitOutput(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
}

export function readGitState(projectRoot) {
  const commit = gitOutput(projectRoot, ['rev-parse', 'HEAD']);
  const status = gitOutput(projectRoot, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  return { commit, dirty: status.length > 0 };
}

function releaseDiskProfile(profile) {
  return {
    id: profile.id,
    label: profile.label,
    distribution: profile.distribution,
    kind: profile.kind,
    url: profile.url,
  };
}

function parseProfileLiteral(source, exportName) {
  const objectMatch = source.match(
    new RegExp(
      `export\\s+const\\s+${exportName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`,
    ),
  );
  invariant(objectMatch, `Could not read ${exportName} from src/lib/constants.ts`);
  const body = objectMatch[1];
  const profile = {};
  for (const key of ['id', 'label', 'distribution', 'kind', 'url']) {
    const valueMatch = body.match(
      new RegExp(`${key}:\\s*(['\"])(.*?)\\1`),
    );
    invariant(
      valueMatch,
      `Could not read ${exportName}.${key} from src/lib/constants.ts`,
    );
    profile[key] = valueMatch[2];
  }
  return profile;
}

function parseReleaseDiskProfiles(source) {
  const profileNames = [
    'WEBVM_OFFICIAL_DISK_PROFILE',
    'WEBVM_CODING_CANDIDATE_PROFILE',
    'WEBVM_VENDOR_ALPINE_PROFILE',
  ];
  const profiles = Object.fromEntries(
    profileNames.map((name) => [name, parseProfileLiteral(source, name)]),
  );
  const defaultMatch = source.match(
    /export\s+const\s+DEFAULT_WEBVM_DISK_PROFILE\s*=\s*([A-Z0-9_]+)\s*;/,
  );
  invariant(defaultMatch, 'Could not read DEFAULT_WEBVM_DISK_PROFILE');
  const defaultProfile = profiles[defaultMatch[1]];
  invariant(defaultProfile, 'DEFAULT_WEBVM_DISK_PROFILE names an unknown profile');
  return {
    default: releaseDiskProfile(defaultProfile),
    candidate: releaseDiskProfile(profiles.WEBVM_CODING_CANDIDATE_PROFILE),
  };
}

async function loadExpectedRelease(projectRoot) {
  const constantsSource = await fs.readFile(
    join(projectRoot, 'src/lib/constants.ts'),
    'utf8',
  );
  const disks = parseReleaseDiskProfiles(constantsSource);
  const cheerpxPackage = await readJson(
    join(projectRoot, 'node_modules/@leaningtech/cheerpx/package.json'),
    'installed CheerpX package metadata',
  );
  const imageMetadata = await readJson(
    join(projectRoot, 'vm-image/image.json'),
    'VM image metadata',
  );
  const firebaseConfig = await readJson(
    join(projectRoot, 'firebase.json'),
    'Firebase configuration',
  );
  validateFirebaseHostingConfig(firebaseConfig);
  const packageMetadata = await readJson(
    join(projectRoot, 'package.json'),
    'package metadata',
  );
  invariant(
    packageMetadata.scripts?.['release:prepare'] ===
      'npm run release:check-source && npm test && npm run build && npm run stage:vm-image && npm run release:verify',
    'package.json release:prepare must use the guarded test/build/stage/verify sequence',
  );
  const packageLock = await fs.readFile(join(projectRoot, 'package-lock.json'));
  return {
    cheerpxPinnedVersion: cheerpxPackage.version,
    packageLockSha256: sha256Bytes(packageLock),
    disks,
    imageMetadata,
    releaseUrl: `${CANONICAL_RELEASE_ROOT}/vm-image-${imageMetadata.version}`,
  };
}

async function listFiles(root, directory = root) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      throw new Error(`Release output directory is missing: ${root}`, {
        cause: error,
      });
    },
  );
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(root, path)));
    } else if (entry.isFile()) {
      result.push(relative(root, path).split(sep).join('/'));
    } else {
      throw new Error(`Release output contains an unsupported filesystem entry: ${path}`);
    }
  }
  return result.sort();
}

function assertDiskProfile(actual, expected, label) {
  invariant(isRecord(actual), `${label} disk profile is missing`);
  for (const key of ['id', 'label', 'distribution', 'kind', 'url']) {
    invariant(
      actual[key] === expected[key],
      `${label} disk ${key} does not match src/lib/constants.ts`,
    );
  }
}

function validateManifestShape(manifest, expected) {
  invariant(isRecord(manifest), 'dist/release.json must contain an object');
  invariant(manifest.schemaVersion === 1, 'Unsupported release manifest schema');
  invariant(isRecord(manifest.app), 'Release manifest app metadata is missing');
  invariant(
    COMMIT_PATTERN.test(manifest.app.commit),
    'Release manifest must contain the full 40-character app commit',
  );
  invariant(
    typeof manifest.app.dirty === 'boolean',
    'Release manifest app dirty state is missing',
  );
  invariant(
    typeof manifest.app.buildTime === 'string' &&
      Number.isFinite(Date.parse(manifest.app.buildTime)),
    'Release manifest build time is invalid',
  );
  invariant(
    manifest.app.cheerpxPinnedVersion === expected.cheerpxPinnedVersion,
    'Release manifest CheerpX pin does not match the installed package',
  );
  invariant(
    manifest.app.packageLockSha256 === expected.packageLockSha256,
    'Release manifest package-lock hash does not match the source tree',
  );
  invariant(Array.isArray(manifest.app.assets), 'Release app asset inventory is missing');
  invariant(manifest.app.assets.length > 0, 'Release app asset inventory is empty');

  const seenAssets = new Set();
  for (const asset of manifest.app.assets) {
    invariant(isRecord(asset), 'Release app asset entry is invalid');
    invariant(
      typeof asset.path === 'string' &&
        asset.path.length > 0 &&
        !asset.path.startsWith('/') &&
        !asset.path.split('/').includes('..') &&
        !asset.path.includes('\\'),
      'Release app asset path is unsafe',
    );
    invariant(!seenAssets.has(asset.path), `Duplicate release asset: ${asset.path}`);
    seenAssets.add(asset.path);
    invariant(
      Number.isSafeInteger(asset.sizeBytes) && asset.sizeBytes >= 0,
      `Release asset size is invalid: ${asset.path}`,
    );
    invariant(
      SHA256_PATTERN.test(asset.sha256),
      `Release asset SHA-256 is invalid: ${asset.path}`,
    );
  }
  invariant(seenAssets.has('index.html'), 'Release asset inventory omits index.html');

  invariant(isRecord(manifest.disks), 'Release disk metadata is missing');
  assertDiskProfile(manifest.disks.default, expected.disks.default, 'default');
  assertDiskProfile(manifest.disks.candidate, expected.disks.candidate, 'candidate');

  const metadata = expected.imageMetadata;
  invariant(isRecord(manifest.image), 'Release VM image metadata is missing');
  invariant(
    manifest.image.profileId === metadata.profileId,
    'Release image profile ID does not match vm-image/image.json',
  );
  invariant(
    manifest.image.version === metadata.version,
    'Release image version does not match vm-image/image.json',
  );
  invariant(
    manifest.image.diskFile === metadata.diskFile,
    'Release image filename does not match vm-image/image.json',
  );
  invariant(
    manifest.image.sizeBytes === metadata.imageSizeMiB * 1024 * 1024,
    'Release image size does not match vm-image/image.json',
  );
  invariant(
    manifest.image.releaseTag === `vm-image-${metadata.version}`,
    'Release image tag does not match vm-image/image.json',
  );
  invariant(
    manifest.disks.candidate.url === `/vm-images/${metadata.diskFile}`,
    'Candidate disk URL must use the same-origin immutable image path',
  );
}

async function verifyAppAssets(distRoot, manifest) {
  const actualFiles = await listFiles(distRoot);
  const appFiles = actualFiles.filter(
    (path) => path !== 'release.json' && !path.startsWith('vm-images/'),
  );
  const expectedFiles = manifest.app.assets.map((asset) => asset.path).sort();
  invariant(
    JSON.stringify(appFiles) === JSON.stringify(expectedFiles),
    `dist app files differ from the build inventory (actual=${appFiles.join(', ')})`,
  );
  for (const path of expectedFiles.filter((assetPath) => assetPath.startsWith('assets/'))) {
    invariant(
      /^assets\/(?:.*\/)?[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(path),
      `Immutable app asset does not have a content-hashed filename: ${path}`,
    );
  }

  for (const asset of manifest.app.assets) {
    const path = join(distRoot, asset.path);
    const stat = await fs.stat(path);
    invariant(stat.size === asset.sizeBytes, `Release asset size changed: ${asset.path}`);
    invariant(
      (await sha256File(path)) === asset.sha256,
      `Release asset content changed after build: ${asset.path}`,
    );
  }

  const indexHtml = await fs.readFile(join(distRoot, 'index.html'), 'utf8');
  const localReferences = Array.from(
    indexHtml.matchAll(/(?:src|href)="\/([^"?#]+)(?:[?#][^"]*)?"/g),
    (match) => match[1],
  ).filter((path) => path.startsWith('assets/'));
  invariant(localReferences.length > 0, 'Built index.html references no local app assets');
  for (const path of localReferences) {
    invariant(expectedFiles.includes(path), `index.html references an untracked asset: ${path}`);
  }
  return actualFiles;
}

function defaultIsAncestor(projectRoot, ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

export async function verifyReleaseDist({
  projectRoot,
  mode,
  expected,
  gitState,
  isAncestor = defaultIsAncestor,
} = {}) {
  const resolvedProjectRoot = resolve(
    projectRoot ?? dirname(fileURLToPath(import.meta.url)),
    projectRoot ? '.' : '..',
  );
  invariant(
    mode === 'source' || mode === 'built' || mode === 'deploy',
    'Release verification mode must be source, built, or deploy',
  );
  const currentGit = gitState ?? readGitState(resolvedProjectRoot);
  invariant(COMMIT_PATTERN.test(currentGit.commit), 'Current Git commit is not a full SHA');
  invariant(!currentGit.dirty, 'Release verification requires a clean Git worktree');

  const releaseExpected = expected ?? (await loadExpectedRelease(resolvedProjectRoot));
  await verifyDiagnosticsCheerpxPin(
    resolvedProjectRoot,
    releaseExpected.cheerpxPinnedVersion,
  );
  if (mode === 'source') {
    return { mode, commit: currentGit.commit };
  }

  const distRoot = join(resolvedProjectRoot, 'dist');
  const manifestPath = join(distRoot, 'release.json');
  const manifest = await readJson(manifestPath, 'release manifest');
  validateManifestShape(manifest, releaseExpected);
  invariant(!manifest.app.dirty, 'Release manifest was built from a dirty worktree');
  invariant(
    manifest.app.commit === currentGit.commit,
    'Release manifest commit does not match the current Git commit',
  );
  const actualFiles = await verifyAppAssets(distRoot, manifest);

  if (mode === 'built') {
    invariant(manifest.state === 'built', 'CI build manifest must be in built state');
    invariant(manifest.image.sha256 === null, 'Unstaged build unexpectedly pins image bytes');
    invariant(manifest.image.sourceCommit === null, 'Unstaged build has an image source commit');
    invariant(manifest.image.releaseUrl === null, 'Unstaged build has a release URL');
    invariant(
      manifest.image.releaseManifestSha256 === null,
      'Unstaged build has a release-manifest hash',
    );
    invariant(manifest.image.stagedPath === null, 'Unstaged build has an image path');
    invariant(
      !actualFiles.some((path) => path.startsWith('vm-images/')),
      'Unstaged CI build unexpectedly contains a VM image',
    );
    return { mode, manifest };
  }

  invariant(manifest.state === 'staged', 'Deploy manifest is not in staged state');
  invariant(
    SHA256_PATTERN.test(manifest.image.sha256),
    'Deploy manifest image SHA-256 is missing or invalid',
  );
  invariant(
    COMMIT_PATTERN.test(manifest.image.sourceCommit),
    'Deploy manifest image source commit is missing or invalid',
  );
  invariant(
    SHA256_PATTERN.test(manifest.image.releaseManifestSha256),
    'Deploy manifest release-manifest SHA-256 is missing or invalid',
  );
  invariant(
    manifest.image.releaseUrl === releaseExpected.releaseUrl,
    'Deploy manifest release URL is not the canonical pinned GitHub Release',
  );
  const expectedImagePath = `vm-images/${manifest.image.diskFile}`;
  invariant(
    manifest.image.stagedPath === expectedImagePath,
    'Deploy manifest staged image path is incorrect',
  );
  const imageFiles = actualFiles.filter((path) => path.startsWith('vm-images/'));
  invariant(
    imageFiles.length === 1 && imageFiles[0] === expectedImagePath,
    `dist must contain exactly the pinned VM image (found=${imageFiles.join(', ')})`,
  );
  const imagePath = join(distRoot, expectedImagePath);
  const imageStat = await fs.stat(imagePath);
  invariant(
    imageStat.size === manifest.image.sizeBytes,
    'Staged VM image has the wrong byte size',
  );
  invariant(
    (await sha256File(imagePath)) === manifest.image.sha256,
    'Staged VM image SHA-256 does not match dist/release.json',
  );
  invariant(
    isAncestor(
      resolvedProjectRoot,
      manifest.image.sourceCommit,
      currentGit.commit,
    ),
    'VM image source commit is not an ancestor of the app release commit',
  );
  return { mode, manifest };
}

function parseMode(argv) {
  const index = argv.indexOf('--mode');
  return index === -1 ? null : argv[index + 1] ?? null;
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const result = await verifyReleaseDist({ mode });
  console.log(
    mode === 'source'
      ? `Release source verified at ${result.commit}.`
      : `Release ${mode} output verified for ${result.manifest.app.commit}.`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
