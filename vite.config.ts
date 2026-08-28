import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import {
  DEFAULT_WEBVM_DISK_PROFILE,
  WEBVM_CODING_CANDIDATE_PROFILE,
  type WebVmDiskProfile,
} from './src/lib/constants.js';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Production serves the immutable VM image from the app's own Firebase
// origin. Mirror that URL shape in development so CheerpX can read range
// metadata without a cross-origin header visibility dependency.
const vmImageDevProxy = {
  target: 'https://spark-run-poc.web.app',
  changeOrigin: true,
  secure: true,
};

const cheerpxPkg = JSON.parse(
  readFileSync('node_modules/@leaningtech/cheerpx/package.json', 'utf8'),
) as { version: string };
const imageMetadata = JSON.parse(
  readFileSync('vm-image/image.json', 'utf8'),
) as {
  schemaVersion: number;
  profileId: string;
  version: string;
  diskFile: string;
  imageSizeMiB: number;
};

let gitCommit = 'unknown';
let gitDirty = true;
try {
  gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  gitDirty =
    execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { encoding: 'utf8' },
    ).trim().length > 0;
} catch {
  // Outside a git repo or git not available — fall through.
}

const buildTimestamp = new Date().toISOString();
const buildLabel = `${gitCommit}${gitDirty ? '+dirty' : ''}`;

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function releaseDiskProfile(profile: WebVmDiskProfile) {
  return {
    id: profile.id,
    label: profile.label,
    distribution: profile.distribution,
    kind: profile.kind,
    url: profile.url,
  };
}

function listBuildFiles(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'vm-images' ? [] : listBuildFiles(root, path);
    }
    const relativePath = relative(root, path).split(sep).join('/');
    return relativePath === 'release.json' ? [] : [relativePath];
  });
}

function releaseManifestPlugin() {
  let outputDirectory = resolve('dist');
  return {
    name: 'sparkrun-release-manifest',
    apply: 'build' as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outputDirectory = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const assets = listBuildFiles(outputDirectory)
        .sort()
        .map((path) => {
          const bytes = readFileSync(join(outputDirectory, path));
          return {
            path,
            sizeBytes: statSync(join(outputDirectory, path)).size,
            sha256: sha256Bytes(bytes),
          };
        });
      const packageLock = readFileSync('package-lock.json');
      const manifest = {
        schemaVersion: 1,
        state: 'built',
        app: {
          commit: gitCommit,
          dirty: gitDirty,
          buildTime: buildTimestamp,
          cheerpxPinnedVersion: cheerpxPkg.version,
          packageLockSha256: sha256Bytes(packageLock),
          assets,
        },
        disks: {
          default: releaseDiskProfile(DEFAULT_WEBVM_DISK_PROFILE),
          candidate: releaseDiskProfile(WEBVM_CODING_CANDIDATE_PROFILE),
        },
        image: {
          profileId: imageMetadata.profileId,
          version: imageMetadata.version,
          diskFile: imageMetadata.diskFile,
          sizeBytes: imageMetadata.imageSizeMiB * 1024 * 1024,
          sha256: null,
          sourceCommit: null,
          releaseTag: `vm-image-${imageMetadata.version}`,
          releaseUrl: null,
          releaseManifestSha256: null,
          stagedPath: null,
        },
      };
      writeFileSync(
        join(outputDirectory, 'release.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), releaseManifestPlugin()],
  optimizeDeps: {
    exclude: ['@leaningtech/cheerpx'],
  },
  define: {
    __CHEERPX_PINNED_VERSION__: JSON.stringify(cheerpxPkg.version),
    __SPARKRUN_BUILD_SHA__: JSON.stringify(buildLabel),
    __SPARKRUN_BUILD_TIME__: JSON.stringify(buildTimestamp),
  },
  server: {
    headers: isolationHeaders,
    proxy: {
      '/vm-images': vmImageDevProxy,
    },
  },
  preview: {
    headers: isolationHeaders,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
