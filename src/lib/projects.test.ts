import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  deleteProject,
  loadProjects,
  renameProject,
  upsertProject,
} from './projects';

describe('browser-cached projects', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  it('creates, saves, reloads, renames, and deletes projects', () => {
    const project = createProject('make a dashboard');
    expect(project).toMatchObject({
      name: 'Untitled site',
      prompt: 'make a dashboard',
      previewUrl: null,
      files: [],
    });

    const saved = upsertProject([], {
      ...project,
      previewUrl: 'http://100.64.0.25:8080/',
      files: [{ path: 'index.html', content: '<h1>Hi</h1>' }],
    });
    expect(loadProjects()).toEqual(saved);
    expect(loadProjects()[0].files).toEqual([
      { path: 'index.html', content: '<h1>Hi</h1>' },
    ]);

    const renamed = renameProject(saved[0], 'Launch page');
    const afterRename = upsertProject(saved, renamed);
    expect(afterRename[0].name).toBe('Launch page');
    expect(loadProjects()[0].name).toBe('Launch page');

    const afterDelete = deleteProject(afterRename, project.id);
    expect(afterDelete).toEqual([]);
    expect(loadProjects()).toEqual([]);
  });

  it('ignores corrupted project cache', () => {
    window.localStorage.setItem('sparkrun.projects.v1', 'not-json');
    expect(loadProjects()).toEqual([]);
  });
});
