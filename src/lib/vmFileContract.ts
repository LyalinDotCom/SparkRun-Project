import { SITE_ROOT } from './constants';

/** A file-browser entry relative to the VM's managed site directory. */
export interface DirectoryEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
}

export interface VmCommandResult {
  status: number;
  output: string;
  background?: boolean;
}

/**
 * Minimal file and command contract shared by the workbench and VM runtime.
 * The coding harness uses its separate, runtime-neutral CodingRuntime contract.
 */
export interface VmFileBackend {
  readText(relativePath: string): Promise<string>;
  readBytes?(relativePath: string): Promise<Uint8Array>;
  writeText(relativePath: string, content: string): Promise<void>;
  listDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  runCommand(
    command: string,
    options: {
      cwd: string;
      background?: boolean;
      stream?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<VmCommandResult>;
}

export function normalizeSitePath(rawPath: string | undefined): string {
  const raw = (rawPath ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';

  let path = raw;
  if (path === SITE_ROOT) {
    return '';
  }
  if (path.startsWith(`${SITE_ROOT}/`)) {
    path = path.slice(SITE_ROOT.length + 1);
  } else if (path.startsWith('/workspace/')) {
    throw new Error(`Path is outside ${SITE_ROOT}: ${rawPath}`);
  } else {
    path = path.replace(/^\/+/, '');
  }

  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new Error(`Path cannot escape ${SITE_ROOT}: ${rawPath}`);
    }
    if (part.includes('\0')) {
      throw new Error('Path cannot contain null bytes.');
    }
    segments.push(part);
  }
  return segments.join('/');
}

export function toVmPath(relativePath: string): string {
  return relativePath ? `${SITE_ROOT}/${relativePath}` : SITE_ROOT;
}
