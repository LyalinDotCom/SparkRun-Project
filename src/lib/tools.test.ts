import { describe, expect, it } from 'vitest';
import { SERVER_COMMAND, SITE_ROOT } from './constants';
import {
  executeToolCall,
  MemoryVmFileBackend,
  normalizeSitePath,
  toVmPath,
} from './tools';

describe('browser VM tool executor', () => {
  it('confines paths to the generated site root', () => {
    expect(normalizeSitePath('index.html')).toBe('index.html');
    expect(normalizeSitePath(`${SITE_ROOT}/style.css`)).toBe('style.css');
    expect(toVmPath('script.js')).toBe(`${SITE_ROOT}/script.js`);

    expect(() => normalizeSitePath('/workspace/other/index.html')).toThrow(
      `Path is outside ${SITE_ROOT}`,
    );
    expect(() => normalizeSitePath('../secret.txt')).toThrow('cannot escape');
  });

  it('writes complete files and reads line ranges', async () => {
    const backend = new MemoryVmFileBackend();

    const write = await executeToolCall(backend, {
      name: 'write_file',
      args: {
        file_path: 'index.html',
        content: '<h1>Hello</h1>\n<p>World</p>\n<footer>VM</footer>',
      },
    });
    expect(write.error).toBeUndefined();
    expect(write.changedFiles).toEqual(['index.html']);

    const read = await executeToolCall(backend, {
      name: 'read_file',
      args: {
        file_path: `${SITE_ROOT}/index.html`,
        start_line: 2,
        end_line: 2,
      },
    });
    expect(read.error).toBeUndefined();
    expect(read.llmContent).toContain('<p>World</p>');
    expect(read.llmContent).not.toContain('<h1>Hello</h1>');
  });

  it('rejects omitted content placeholders', async () => {
    const backend = new MemoryVmFileBackend();

    const result = await executeToolCall(backend, {
      name: 'write_file',
      args: {
        file_path: 'index.html',
        content: '<main>...</main><!-- ... -->',
      },
    });

    expect(result.error).toContain('omission placeholder');
  });

  it('replaces exact matches and protects ambiguous edits', async () => {
    const backend = new MemoryVmFileBackend({
      'style.css': '.box { color: red; }\n.box { color: red; }',
    });

    const ambiguous = await executeToolCall(backend, {
      name: 'replace',
      args: {
        file_path: 'style.css',
        old_string: 'color: red',
        new_string: 'color: teal',
      },
    });
    expect(ambiguous.error).toContain('matched 2 times');

    const multiple = await executeToolCall(backend, {
      name: 'replace',
      args: {
        file_path: 'style.css',
        old_string: 'color: red',
        new_string: 'color: teal',
        allow_multiple: true,
      },
    });
    expect(multiple.error).toBeUndefined();
    expect(await backend.readText('style.css')).toBe(
      '.box { color: teal; }\n.box { color: teal; }',
    );
  });

  it('recovers replace calls with indentation-only differences like Gemini CLI edit', async () => {
    const backend = new MemoryVmFileBackend({
      'script.js': [
        'function draw() {',
        '  ctx.fillStyle = "black";',
        '  ctx.fillRect(0, 0, width, height);',
        '}',
      ].join('\n'),
    });

    const result = await executeToolCall(backend, {
      name: 'replace',
      args: {
        file_path: 'script.js',
        old_string: [
          'ctx.fillStyle = "black";',
          'ctx.fillRect(0, 0, width, height);',
        ].join('\n'),
        new_string: [
          'ctx.fillStyle = "rgba(0, 0, 0, 0.2)";',
          'ctx.fillRect(0, 0, width, height);',
        ].join('\n'),
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('flexible matching');
    expect(await backend.readText('script.js')).toBe(
      [
        'function draw() {',
        '  ctx.fillStyle = "rgba(0, 0, 0, 0.2)";',
        '  ctx.fillRect(0, 0, width, height);',
        '}',
      ].join('\n'),
    );
  });

  it('creates a missing file with replace only when old_string is empty', async () => {
    const backend = new MemoryVmFileBackend();

    const missing = await executeToolCall(backend, {
      name: 'replace',
      args: {
        file_path: 'script.js',
        old_string: 'console.log("old")',
        new_string: 'console.log("new")',
      },
    });
    expect(missing.error).toContain('File not found');

    const create = await executeToolCall(backend, {
      name: 'replace',
      args: {
        file_path: 'script.js',
        old_string: '',
        new_string: 'console.log("hello")',
      },
    });
    expect(create.error).toBeUndefined();
    expect(await backend.readText('script.js')).toBe('console.log("hello")');
  });

  it('lists only files under the requested directory', async () => {
    const backend = new MemoryVmFileBackend({
      'index.html': '',
      'assets/app.js': '',
      'assets/theme.css': '',
    });

    const root = await executeToolCall(backend, {
      name: 'list_directory',
      args: { dir_path: '' },
    });
    expect(root.llmContent).toContain('file index.html');
    expect(root.llmContent).toContain('dir assets');

    const assets = await executeToolCall(backend, {
      name: 'list_directory',
      args: { dir_path: 'assets' },
    });
    expect(assets.llmContent).toContain('file assets/app.js');
    expect(assets.llmContent).not.toContain('index.html');
  });

  it('allows only the static server and read-only shell commands', async () => {
    const backend = new MemoryVmFileBackend();

    const blocked = await executeToolCall(backend, {
      name: 'run_shell_command',
      args: { command: 'npm install anything' },
    });
    expect(blocked.error).toContain('not allowed');
    expect(backend.commands).toHaveLength(0);

    const server = await executeToolCall(backend, {
      name: 'run_shell_command',
      args: { command: SERVER_COMMAND },
    });
    expect(server.error).toBeUndefined();
    expect(backend.commands).toEqual([
      {
        command: SERVER_COMMAND,
        cwd: SITE_ROOT,
        background: true,
      },
    ]);
  });
});
