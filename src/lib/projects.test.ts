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

  it('does not clobber a project another tab persisted since this tab loaded', () => {
    // This tab loaded an empty list.
    const myList = upsertProject([], createProject('tab A project'));

    // Another tab persists its own project directly to storage afterwards.
    const otherTabProject = {
      ...createProject('tab B project'),
      id: 'tab-b',
      name: 'Tab B',
    };
    window.localStorage.setItem(
      'sparkrun.projects.v1',
      JSON.stringify([otherTabProject, ...myList]),
    );

    // This tab saves again from its stale in-memory list.
    const saved = upsertProject(myList, {
      ...myList[0],
      name: 'Tab A renamed',
    });

    const ids = saved.map((project) => project.id);
    expect(ids).toContain('tab-b');
    expect(loadProjects().map((project) => project.id)).toContain('tab-b');
  });

  it('only removes the targeted project when merging with storage', () => {
    const a = upsertProject([], { ...createProject('a'), id: 'a' });
    const list = upsertProject(a, { ...createProject('b'), id: 'b' });

    const afterDelete = deleteProject(list, 'a');
    expect(afterDelete.map((project) => project.id)).toEqual(['b']);
    expect(loadProjects().map((project) => project.id)).toEqual(['b']);
  });
});
