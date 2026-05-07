import { describe, expect, it, vi } from 'vitest';
import { normalizeSourcePath, writeSourceFiles } from './localFolder';

interface MockDirectory {
  kind: 'directory';
  name: string;
  files: Map<string, string>;
  directories: Map<string, MockDirectory>;
  queryPermission: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  getDirectoryHandle: ReturnType<typeof vi.fn>;
  getFileHandle: ReturnType<typeof vi.fn>;
}

function makeDirectory(name = 'root'): MockDirectory {
  const files = new Map<string, string>();
  const directories = new Map<string, MockDirectory>();

  const directory: MockDirectory = {
    kind: 'directory' as const,
    name,
    files,
    directories,
    queryPermission: vi.fn(async () => 'granted' as PermissionState),
    requestPermission: vi.fn(async () => 'granted' as PermissionState),
    getDirectoryHandle: vi.fn(async (childName: string) => {
      let child = directories.get(childName);
      if (!child) {
        child = makeDirectory(childName);
        directories.set(childName, child);
      }
      return child as unknown as FileSystemDirectoryHandle;
    }),
    getFileHandle: vi.fn(async (fileName: string) => ({
      kind: 'file' as const,
      name: fileName,
      createWritable: async () => ({
        write: async (content: string) => {
          files.set(fileName, content);
        },
        close: async () => undefined,
      }),
    })),
  };

  return directory;
}

describe('local source folder writer', () => {
  it('normalizes safe paths and rejects escapes', () => {
    expect(normalizeSourcePath('assets/site.css')).toEqual(['assets', 'site.css']);
    expect(() => normalizeSourcePath('../secret.txt')).toThrow('Unsafe');
    expect(() => normalizeSourcePath('')).toThrow('cannot be empty');
  });

  it('writes generated files into nested local folders', async () => {
    const root = makeDirectory();

    const count = await writeSourceFiles(root as unknown as FileSystemDirectoryHandle, [
      { path: 'index.html', content: '<h1>Hello</h1>' },
      { path: 'assets/site.css', content: 'body { color: teal; }' },
    ]);

    const assets = root.directories.get('assets');
    expect(count).toBe(2);
    expect(root.files.get('index.html')).toBe('<h1>Hello</h1>');
    expect(assets?.files.get('site.css')).toBe('body { color: teal; }');
    expect(root.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });
});
