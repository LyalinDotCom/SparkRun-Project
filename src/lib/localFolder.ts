export interface SourceFile {
  path: string;
  content: string;
}

const DATABASE_NAME = 'sparkrun-local-folder';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'source-directory';

export function isLocalFolderSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = action(store);

    transaction.oncomplete = () => {
      database.close();
      resolve(request ? request.result : undefined);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
  });
}

export async function loadSavedDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await withStore<FileSystemDirectoryHandle>('readonly', (store) =>
    store.get(HANDLE_KEY),
  );
  return handle ?? null;
}

export async function saveDirectoryHandle(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  await withStore('readwrite', (store) => {
    store.put(handle, HANDLE_KEY);
  });
}

export async function clearDirectoryHandle(): Promise<void> {
  await withStore('readwrite', (store) => {
    store.delete(HANDLE_KEY);
  });
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
  const requested = await handle.requestPermission?.(descriptor);
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

  for (const file of files) {
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
    await writable.write(file.content);
    await writable.close();
  }

  return files.length;
}
