import { describe, expect, it } from 'vitest';
import { SITE_ROOT } from './constants';
import { normalizeSitePath, toVmPath } from './vmFileContract';

describe('VM file contract paths', () => {
  it('normalizes relative and managed absolute site paths', () => {
    expect(normalizeSitePath('src/main.ts')).toBe('src/main.ts');
    expect(normalizeSitePath('src\\components\\App.tsx')).toBe(
      'src/components/App.tsx',
    );
    expect(normalizeSitePath(`${SITE_ROOT}/index.html`)).toBe('index.html');
    expect(normalizeSitePath(SITE_ROOT)).toBe('');
    expect(normalizeSitePath('')).toBe('');
  });

  it('rejects workspace escapes and invalid path bytes', () => {
    expect(() => normalizeSitePath('../secret.txt')).toThrow('cannot escape');
    expect(() => normalizeSitePath('/workspace/other/file.txt')).toThrow(
      `outside ${SITE_ROOT}`,
    );
    expect(() => normalizeSitePath('bad\0path')).toThrow('null bytes');
  });

  it('resolves normalized paths under the managed VM site root', () => {
    expect(toVmPath('src/main.ts')).toBe(`${SITE_ROOT}/src/main.ts`);
    expect(toVmPath('')).toBe(SITE_ROOT);
  });
});
