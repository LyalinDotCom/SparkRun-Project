export interface SavedProject {
  id: string;
  name: string;
  prompt: string;
  previewUrl: string | null;
  updatedAt: string;
  files: SavedProjectFile[];
}

export interface SavedProjectFile {
  path: string;
  content: string;
}

export const PROJECTS_STORAGE_KEY = 'sparkrun.projects.v1';

function parseProjects(raw: string | null): SavedProject[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is SavedProject => {
        return (
          item &&
          typeof item === 'object' &&
          typeof item.id === 'string' &&
          typeof item.name === 'string' &&
          typeof item.prompt === 'string' &&
          typeof item.updatedAt === 'string'
        );
      })
      .map((item) => ({
        ...item,
        previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : null,
        files: Array.isArray((item as { files?: unknown }).files)
          ? ((item as { files: unknown[] }).files
              .filter(
                (file): file is SavedProjectFile =>
                  file !== null &&
                  typeof file === 'object' &&
                  typeof (file as { path?: unknown }).path === 'string' &&
                  typeof (file as { content?: unknown }).content === 'string',
              )
              .map((file) => ({
                path: file.path,
                content: file.content,
              })))
          : [],
      }));
  } catch {
    return [];
  }
}

function persistProjects(projects: SavedProject[]): void {
  window.localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(projects));
}

export function loadProjects(): SavedProject[] {
  return parseProjects(window.localStorage.getItem(PROJECTS_STORAGE_KEY));
}

export function createProject(prompt: string): SavedProject {
  const now = new Date().toISOString();
  return {
    id: `project-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Untitled site',
    prompt,
    previewUrl: null,
    updatedAt: now,
    files: [],
  };
}

// Merge the in-memory list with whatever is currently persisted. The list lives
// under a single localStorage key, so a tab that wrote only its own in-memory
// array would silently clobber projects that another tab created or updated
// since this tab loaded. Merging by id (in-memory wins) preserves both.
function mergeWithPersisted(projects: SavedProject[]): SavedProject[] {
  const merged: SavedProject[] = [];
  const seen = new Set<string>();
  for (const project of [...projects, ...loadProjects()]) {
    if (seen.has(project.id)) {
      continue;
    }
    seen.add(project.id);
    merged.push(project);
  }
  return merged;
}

export function upsertProject(
  projects: SavedProject[],
  project: SavedProject,
): SavedProject[] {
  const updated = {
    ...project,
    updatedAt: new Date().toISOString(),
  };
  const others = mergeWithPersisted(projects).filter(
    (item) => item.id !== project.id,
  );
  const next = [updated, ...others];
  persistProjects(next);
  return next;
}

export function deleteProject(
  projects: SavedProject[],
  projectId: string,
): SavedProject[] {
  const next = mergeWithPersisted(projects).filter(
    (project) => project.id !== projectId,
  );
  persistProjects(next);
  return next;
}

export function renameProject(project: SavedProject, name: string): SavedProject {
  const cleanName = name.trim();
  return {
    ...project,
    name: cleanName || 'Untitled site',
  };
}

export function withProjectFiles(
  project: SavedProject,
  files: SavedProjectFile[],
): SavedProject {
  return {
    ...project,
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  };
}
