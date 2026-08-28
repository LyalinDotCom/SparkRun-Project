export interface SourceFile {
  path: string;
  content: string | Uint8Array;
}

export function isLocalFolderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export async function pickSourceDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support local folder access.');
  }
  return window.showDirectoryPicker({
    id: 'sparkrun-source',
    mode: 'readwrite',
  });
}

export async function ensureDirectoryWritePermission(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const descriptor = { mode: 'readwrite' as const };
  const current = await handle.queryPermission?.(descriptor);
  if (current === 'granted') {
    return;
  }
  // requestPermission() requires transient user activation. Called outside a
  // user gesture (e.g. during the post-build sync on a handle restored from
  // IndexedDB) it rejects with a SecurityError. Surface an actionable message
  // instead of an opaque DOM error so the caller can prompt a re-attach.
  let requested: PermissionState | undefined;
  try {
    requested = await handle.requestPermission?.(descriptor);
  } catch (error) {
    throw new Error(
      `Local folder write permission needs to be re-granted (${
        error instanceof Error ? error.message : String(error)
      }). Re-attach the source folder, then build again.`,
      { cause: error },
    );
  }
  if (requested !== 'granted') {
    throw new Error('Local folder write permission was not granted.');
  }
}

export function normalizeSourcePath(path: string): string[] {
  const parts = path.replace(/\\/g, '/').split('/');
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..' || part.includes('\0')) {
      throw new Error(`Unsafe source file path: ${path}`);
    }
    clean.push(part);
  }
  if (clean.length === 0) {
    throw new Error('Source file path cannot be empty.');
  }
  return clean;
}

export async function writeSourceFiles(
  root: FileSystemDirectoryHandle,
  files: SourceFile[],
): Promise<number> {
  await ensureDirectoryWritePermission(root);

  const failures: string[] = [];
  let written = 0;
  for (const file of files) {
    try {
      const segments = normalizeSourcePath(file.path);
      const fileName = segments.at(-1);
      if (!fileName) {
        throw new Error('Source file path cannot be empty.');
      }

      let directory = root;
      for (const segment of segments.slice(0, -1)) {
        directory = await directory.getDirectoryHandle(segment, { create: true });
      }
      const fileHandle = await directory.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        const content =
          typeof file.content === 'string'
            ? file.content
            : Uint8Array.from(file.content);
        await writable.write(content);
        await writable.close();
      } catch (error) {
        // Release the open writable so it doesn't leave a locked .crswap temp
        // file / hold a lock on the target on Chrome.
        await writable.abort?.().catch(() => undefined);
        throw error;
      }
      written += 1;
    } catch (error) {
      failures.push(
        `${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to sync ${failures.length} of ${files.length} file${
        files.length === 1 ? '' : 's'
      } to the local folder: ${failures.join('; ')}`,
    );
  }

  return written;
}
