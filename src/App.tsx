import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Loader2,
  Monitor,
  Plus,
  Play,
  RefreshCcw,
  Server,
  Trash2,
  TerminalSquare,
  WandSparkles,
} from 'lucide-react';
import { runWebsiteAgent, type AgentEvent } from './lib/agent';
import { MODEL_ID, SERVER_PORT, SITE_ROOT } from './lib/constants';
import {
  clearDirectoryHandle,
  isLocalFolderSupported,
  loadSavedDirectoryHandle,
  pickSourceDirectory,
  saveDirectoryHandle,
  writeSourceFiles,
  type SourceFile,
} from './lib/localFolder';
import {
  createProject,
  deleteProject,
  loadProjects,
  renameProject,
  upsertProject,
  type SavedProjectFile,
  type SavedProject,
} from './lib/projects';
import { WebVmBackend, type WebVmStatus } from './lib/webvm';
import type { DirectoryEntry, VmFileBackend } from './lib/tools';

type LogKind = 'model' | 'tool' | 'vm' | 'done' | 'warning' | 'error';

interface LogLine {
  id: number;
  kind: LogKind;
  text: string;
  time: string;
}

const DEFAULT_PROMPT =
  'make a hello world website with a simple left-to-right layout';
const KEY_STORAGE_ID = 'sparkrun.savedKeys.v1';

const INITIAL_STATUS: WebVmStatus = {
  lifecycle: 'idle',
  message: 'VM not started',
  tailnetIp: null,
  loginUrl: null,
  previewUrl: null,
};

function clock(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function eventKind(event: AgentEvent): LogKind {
  if (event.type === 'done') {
    return 'done';
  }
  if (event.type === 'error') {
    return 'error';
  }
  return event.type;
}

function lifecycleLabel(status: WebVmStatus): string {
  switch (status.lifecycle) {
    case 'idle':
      return 'Idle';
    case 'booting':
      return 'Booting';
    case 'ready':
      return 'Ready';
    case 'tailnet-login-ready':
      return 'Login ready';
    case 'tailnet-connected':
      return 'Tailnet connected';
    case 'server-running':
      return 'Server running';
    case 'error':
      return 'Error';
    default:
      return status.lifecycle;
  }
}

function mergeEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  const byPath = new Map<string, DirectoryEntry>();
  entries.forEach((entry) => byPath.set(entry.path, entry));
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function isSourceFile(entry: DirectoryEntry): boolean {
  if (entry.type !== 'file') {
    return false;
  }
  return !entry.path.split('/').some((part) => part.startsWith('.'));
}

function entriesFromProjectFiles(files: SavedProjectFile[]): DirectoryEntry[] {
  const entries = new Map<string, DirectoryEntry>();
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let prefix = '';
    for (const part of parts.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${part}` : part;
      entries.set(prefix, { path: prefix, type: 'directory' });
    }
    entries.set(file.path, { path: file.path, type: 'file' });
  }
  return mergeEntries(Array.from(entries.values()));
}

function readSavedKeys(): {
  enabled: boolean;
  apiKey: string;
  tailscaleAuthKey: string;
} {
  try {
    const raw = window.localStorage.getItem(KEY_STORAGE_ID);
    if (!raw) {
      return { enabled: false, apiKey: '', tailscaleAuthKey: '' };
    }
    const parsed = JSON.parse(raw) as {
      apiKey?: unknown;
      tailscaleAuthKey?: unknown;
    };
    return {
      enabled: true,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      tailscaleAuthKey:
        typeof parsed.tailscaleAuthKey === 'string'
          ? parsed.tailscaleAuthKey
          : '',
    };
  } catch {
    return { enabled: false, apiKey: '', tailscaleAuthKey: '' };
  }
}

function writeSavedKeys(apiKey: string, tailscaleAuthKey: string): void {
  try {
    window.localStorage.setItem(
      KEY_STORAGE_ID,
      JSON.stringify({ apiKey, tailscaleAuthKey }),
    );
  } catch {
    // Some browser privacy modes disable localStorage; the app still works in-memory.
  }
}

function clearSavedKeys(): void {
  try {
    window.localStorage.removeItem(KEY_STORAGE_ID);
  } catch {
    // Ignore localStorage failures and keep the runtime-only state.
  }
}

export default function App() {
  const savedKeys = useMemo(() => readSavedKeys(), []);
  const [apiKey, setApiKey] = useState(savedKeys.apiKey);
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState(
    savedKeys.tailscaleAuthKey,
  );
  const [rememberKeys, setRememberKeys] = useState(savedKeys.enabled);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [projects, setProjects] = useState<SavedProject[]>(() => loadProjects());
  const [activeProject, setActiveProject] = useState<SavedProject>(() =>
    createProject(DEFAULT_PROMPT),
  );
  const [backend, setBackend] = useState<WebVmBackend | null>(null);
  const [vmStatus, setVmStatus] = useState<WebVmStatus>(INITIAL_STATUS);
  const [files, setFiles] = useState<DirectoryEntry[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [terminal, setTerminal] = useState('');
  const [finalText, setFinalText] = useState('');
  const [isBooting, setIsBooting] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isSyncingSource, setIsSyncingSource] = useState(false);
  const [logsPinned, setLogsPinned] = useState(true);
  const [sourceDirectory, setSourceDirectory] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [sourceDirectoryName, setSourceDirectoryName] = useState('');
  const localFolderSupported = useMemo(() => isLocalFolderSupported(), []);
  const logListRef = useRef<HTMLDivElement | null>(null);
  const restoredProjectIdRef = useRef<string | null>(null);

  const previewUrl = useMemo(
    () => vmStatus.previewUrl ?? backend?.getPreviewUrl() ?? null,
    [backend, vmStatus],
  );

  const appendLog = (kind: LogKind, text: string) => {
    setLogs((current) =>
      [
        ...current,
        {
          id: Date.now() + Math.floor(Math.random() * 1000),
          kind,
          text,
          time: clock(),
        },
      ].slice(-140),
    );
  };

  useEffect(() => {
    const logList = logListRef.current;
    if (!logList || !logsPinned) {
      return;
    }
    logList.scrollTop = logList.scrollHeight;
  }, [logs, logsPinned]);

  const updateLogPin = () => {
    const logList = logListRef.current;
    if (!logList) {
      return;
    }
    const distanceFromBottom =
      logList.scrollHeight - logList.scrollTop - logList.clientHeight;
    setLogsPinned(distanceFromBottom < 48);
  };

  const appendTerminal = (text: string) => {
    setTerminal((current) => `${current}${text}`.slice(-50_000));
  };

  useEffect(() => {
    if (!localFolderSupported) {
      return;
    }

    let cancelled = false;
    void loadSavedDirectoryHandle()
      .then((handle) => {
        if (cancelled || !handle) {
          return;
        }
        setSourceDirectory(handle);
        setSourceDirectoryName(handle.name);
      })
      .catch(() => {
        if (!cancelled) {
          appendLog('warning', 'Could not restore saved source folder');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [localFolderSupported]);

  const saveKeysIfRemembered = (
    nextApiKey = apiKey,
    nextTailscaleAuthKey = tailscaleAuthKey,
  ) => {
    if (rememberKeys) {
      writeSavedKeys(nextApiKey, nextTailscaleAuthKey);
    }
  };

  const updateApiKey = (value: string) => {
    setApiKey(value);
    saveKeysIfRemembered(value, tailscaleAuthKey);
  };

  const updateTailscaleAuthKey = (value: string) => {
    setTailscaleAuthKey(value);
    saveKeysIfRemembered(apiKey, value);
  };

  const updateRememberKeys = (enabled: boolean) => {
    setRememberKeys(enabled);
    if (enabled) {
      writeSavedKeys(apiKey, tailscaleAuthKey);
      appendLog('warning', 'Keys saved in this browser only');
    } else {
      clearSavedKeys();
      appendLog('warning', 'Saved browser keys cleared');
    }
  };

  const saveActiveProject = (
    updates: Partial<
      Pick<SavedProject, 'name' | 'prompt' | 'previewUrl' | 'files'>
    > = {},
  ): SavedProject => {
    const savedName = renameProject(
      activeProject,
      updates.name ?? activeProject.name,
    ).name;
    const nextProject: SavedProject = {
      ...activeProject,
      prompt,
      ...updates,
      name: savedName,
      files: updates.files ?? activeProject.files,
    };
    setActiveProject(nextProject);
    setProjects((current) => upsertProject(current, nextProject));
    appendLog('done', `Project saved: ${nextProject.name}`);
    return nextProject;
  };

  const newProject = () => {
    const project = createProject(DEFAULT_PROMPT);
    setActiveProject(project);
    setPrompt(project.prompt);
    setFiles([]);
    setFinalText('');
    restoredProjectIdRef.current = null;
    appendLog('vm', 'Started a new browser-cached project');
  };

  const selectProject = async (project: SavedProject) => {
    setActiveProject(project);
    setPrompt(project.prompt);
    setFinalText('');
    setFiles(entriesFromProjectFiles(project.files));
    appendLog('vm', `Loaded project: ${project.name}`);
    if (backend && project.files.length > 0) {
      await restoreProjectFiles(backend, project);
    }
  };

  const updateProjectName = (name: string) => {
    setActiveProject((current) => ({
      ...current,
      name,
    }));
  };

  const removeProject = (projectId: string) => {
    setProjects((current) => deleteProject(current, projectId));
    if (activeProject.id === projectId) {
      const project = createProject(DEFAULT_PROMPT);
      setActiveProject(project);
      setPrompt(project.prompt);
      setFiles([]);
      restoredProjectIdRef.current = null;
    }
    appendLog('warning', 'Project removed from browser cache');
  };

  const loadFiles = async (vm: VmFileBackend | null = backend) => {
    if (!vm) {
      setFiles([]);
      return;
    }

    const collected: DirectoryEntry[] = [];
    const visit = async (dirPath: string, depth: number) => {
      const entries = await vm.listDirectory(dirPath);
      collected.push(...entries);
      if (depth >= 3) {
        return;
      }
      for (const entry of entries) {
        if (entry.type === 'directory') {
          await visit(entry.path, depth + 1);
        }
      }
    };

    await visit('', 0);
    setFiles(mergeEntries(collected));
  };

  const collectSourceFiles = async (vm: VmFileBackend): Promise<SourceFile[]> => {
    const collected: DirectoryEntry[] = [];
    const visit = async (dirPath: string, depth: number) => {
      const entries = await vm.listDirectory(dirPath);
      collected.push(...entries);
      if (depth >= 3) {
        return;
      }
      for (const entry of entries) {
        if (entry.type === 'directory' && !entry.path.startsWith('.')) {
          await visit(entry.path, depth + 1);
        }
      }
    };

    await visit('', 0);
    const unique = mergeEntries(collected).filter(isSourceFile);
    return Promise.all(
      unique.map(async (entry) => ({
        path: entry.path,
        content: await vm.readText(entry.path),
      })),
    );
  };

  const restoreProjectFiles = async (
    vm: VmFileBackend,
    project: SavedProject,
  ) => {
    if (project.files.length === 0) {
      restoredProjectIdRef.current = project.id;
      return;
    }

    for (const file of project.files) {
      await vm.writeText(file.path, file.content);
    }
    restoredProjectIdRef.current = project.id;
    await loadFiles(vm);
    appendLog('done', `Restored ${project.files.length} files from ${project.name}`);
  };

  const attachSourceFolder = async () => {
    if (!localFolderSupported) {
      appendLog('warning', 'Local folder access is not supported by this browser');
      return;
    }

    try {
      const handle = await pickSourceDirectory();
      await saveDirectoryHandle(handle);
      setSourceDirectory(handle);
      setSourceDirectoryName(handle.name);
      appendLog('done', `Source folder attached: ${handle.name}`);
    } catch (error) {
      appendLog('error', error instanceof Error ? error.message : String(error));
    }
  };

  const forgetSourceFolder = async () => {
    await clearDirectoryHandle();
    setSourceDirectory(null);
    setSourceDirectoryName('');
    appendLog('warning', 'Local source folder detached');
  };

  const syncSourceToFolder = async (
    vm = backend,
    directory = sourceDirectory,
  ) => {
    if (!vm) {
      appendLog('warning', 'Boot the VM before syncing source files');
      return;
    }
    if (!directory) {
      appendLog('warning', 'Attach a local source folder before syncing');
      return;
    }

    setIsSyncingSource(true);
    try {
      const sourceFiles = await collectSourceFiles(vm);
      if (sourceFiles.length === 0) {
        appendLog('warning', 'No generated source files to sync yet');
        return;
      }
      const count = await writeSourceFiles(directory, sourceFiles);
      appendLog('done', `Synced ${count} source files to ${directory.name}`);
    } catch (error) {
      appendLog('error', error instanceof Error ? error.message : String(error));
    } finally {
      setIsSyncingSource(false);
    }
  };

  const bootVm = async (): Promise<WebVmBackend> => {
    if (backend) {
      return backend;
    }

    setIsBooting(true);
    setTerminal('');
    setVmStatus({
      lifecycle: 'booting',
      message: 'Starting WebVM',
      tailnetIp: null,
      loginUrl: null,
      previewUrl: null,
    });
    appendLog('vm', 'Booting WebVM and mounting persistent workspace');

    try {
      const vm = await WebVmBackend.create({
        tailscaleAuthKey: tailscaleAuthKey.trim() || undefined,
        onConsole: appendTerminal,
        onStatus: (status) => {
          setVmStatus(status);
          if (status.loginUrl) {
            appendLog('vm', `Tailscale login URL ready: ${status.loginUrl}`);
          }
        },
      });
      setBackend(vm);
      await loadFiles(vm);
      appendLog('vm', `${SITE_ROOT} ready`);
      return vm;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVmStatus({
        lifecycle: 'error',
        message,
        tailnetIp: null,
        loginUrl: null,
        previewUrl: null,
      });
      appendLog('error', message);
      throw error;
    } finally {
      setIsBooting(false);
    }
  };

  const connectTailnet = async () => {
    setIsConnecting(true);
    try {
      const vm = await bootVm();
      const loginUrl = await vm.connectTailnet();
      if (loginUrl) {
        window.open(loginUrl, '_blank', 'noopener,noreferrer');
        appendLog('vm', 'Opened Tailscale login');
      } else if (vm.getPreviewUrl()) {
        appendLog('vm', `Tailnet IP ready: ${vm.getPreviewUrl()}`);
      } else {
        appendLog('warning', 'Tailnet started, but no VM IP is available yet');
      }
    } catch (error) {
      appendLog('error', error instanceof Error ? error.message : String(error));
    } finally {
      setIsConnecting(false);
    }
  };

  const buildWebsite = async () => {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      appendLog('error', 'Google AI key is required before building');
      return;
    }

    setIsBuilding(true);
    setFinalText('');
    try {
      const vm = await bootVm();
      if (
        activeProject.files.length > 0 &&
        restoredProjectIdRef.current !== activeProject.id
      ) {
        await restoreProjectFiles(vm, activeProject);
      }
      const tailnetPromise = vm.getPreviewUrl()
        ? Promise.resolve()
        : vm
            .connectTailnet({ timeoutMs: 20_000 })
            .then((loginUrl) => {
              if (loginUrl) {
                window.open(loginUrl, '_blank', 'noopener,noreferrer');
                appendLog('vm', 'Opened Tailscale login');
              } else if (vm.getPreviewUrl()) {
                appendLog('vm', `Tailnet IP ready: ${vm.getPreviewUrl()}`);
              } else {
                appendLog('warning', 'Tailnet has not reported a VM IP yet');
              }
            })
            .catch((error: unknown) => {
              appendLog(
                'error',
                error instanceof Error ? error.message : String(error),
              );
            });
      appendLog('vm', 'Starting Tailnet connection');
      appendLog('model', `Using ${MODEL_ID}`);
      const result = await runWebsiteAgent({
        apiKey: trimmedApiKey,
        prompt,
        backend: vm,
        onEvent: (event) => appendLog(eventKind(event), event.message),
      });
      setFinalText(result.finalText);
      await vm.startServer();
      await tailnetPromise;
      await loadFiles(vm);
      const sourceFiles = await collectSourceFiles(vm);
      if (sourceDirectory) {
        await syncSourceToFolder(vm, sourceDirectory);
      }

      const url = vm.getPreviewUrl();
      if (!url) {
        appendLog(
          'warning',
          'Files are built and the VM server started, but no Tailnet IP is available for the iframe yet',
        );
      } else {
        appendLog('done', `Preview served from ${url}`);
      }
      saveActiveProject({
        prompt,
        previewUrl: url,
        files: sourceFiles,
      });
    } catch (error) {
      appendLog('error', error instanceof Error ? error.message : String(error));
    } finally {
      setIsBuilding(false);
    }
  };

  const resetWorkspace = async () => {
    if (!backend) {
      return;
    }
    appendLog('vm', 'Resetting persistent workspace');
    await backend.resetWorkspace();
    await loadFiles(backend);
    restoredProjectIdRef.current = null;
    setFinalText('');
  };

  const isBusy = isBooting || isConnecting || isBuilding;
  const primaryDisabled = isBuilding || !prompt.trim();
  const previewReady = Boolean(previewUrl);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Browser-built website prototype</p>
          <h1>SparkRun</h1>
        </div>
        <div className="model-badge" aria-label="Gemini model">
          <WandSparkles size={16} aria-hidden="true" />
          {MODEL_ID}
        </div>
      </header>

      <main className="workflow" aria-label="Website builder workflow">
        <section className="pane input-pane" aria-labelledby="input-title">
          <div className="pane-heading">
            <div>
              <p className="step-label">01</p>
              <h2 id="input-title">Prompt</h2>
            </div>
            {isBusy ? (
              <Loader2 className="spin" size={20} aria-label="Working" />
            ) : (
              <CheckCircle2 size={20} aria-hidden="true" />
            )}
          </div>

          <div className="warning-strip">
            <AlertTriangle size={18} aria-hidden="true" />
            <span>
              Dev prototype: keys stay in browser memory unless browser saving
              is enabled below. Use a server-side key flow before production.
            </span>
          </div>

          <div className="project-panel">
            <div className="panel-topline">
              <span>
                <FileCode2 size={16} aria-hidden="true" />
                Projects
              </span>
              <button
                className="icon-button"
                onClick={newProject}
                title="New project"
                type="button"
              >
                <Plus size={18} />
              </button>
            </div>

            <label className="field compact-field">
              <span>Project name</span>
              <input
                onBlur={() => saveActiveProject({ name: activeProject.name, prompt })}
                onChange={(event) => updateProjectName(event.target.value)}
                value={activeProject.name}
              />
            </label>

            <div className="project-list" aria-label="Saved projects">
              {projects.length === 0 ? (
                <p className="empty-state">No saved projects yet.</p>
              ) : (
                projects.map((project) => (
                  <button
                    className={`project-row ${
                      project.id === activeProject.id ? 'active' : ''
                    }`}
                    key={project.id}
                    onClick={() => void selectProject(project)}
                    type="button"
                  >
                    <span>{project.name}</span>
                    <small>
                      {project.files.length} files ·{' '}
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </small>
                  </button>
                ))
              )}
            </div>

            <div className="project-actions">
              <button
                className="secondary-button"
                onClick={() => saveActiveProject({ prompt })}
                type="button"
              >
                <FileCode2 size={18} />
                Save Project
              </button>
              <button
                className="icon-button"
                onClick={() => removeProject(activeProject.id)}
                title="Delete project"
                type="button"
              >
                <Trash2 size={18} />
              </button>
            </div>
          </div>

          <label className="field">
            <span>
              <KeyRound size={16} aria-hidden="true" />
              Google AI key
            </span>
            <input
              autoComplete="off"
              name="google-ai-key"
              onChange={(event) => updateApiKey(event.target.value)}
              placeholder="AIza..."
              type="password"
              value={apiKey}
            />
          </label>

          <label className="field">
            <span>
              <Cable size={16} aria-hidden="true" />
              Tailscale auth key
            </span>
            <input
              autoComplete="off"
              name="tailscale-auth-key"
              onChange={(event) => updateTailscaleAuthKey(event.target.value)}
              placeholder="tskey-auth-..."
              type="password"
              value={tailscaleAuthKey}
            />
          </label>

          <label className="toggle-field">
            <input
              checked={rememberKeys}
              onChange={(event) => updateRememberKeys(event.target.checked)}
              type="checkbox"
            />
            <span>Remember keys on this browser</span>
          </label>

          <div className="source-sync-panel">
            <div className={`source-status ${sourceDirectory ? 'ready' : ''}`}>
              <HardDrive size={16} aria-hidden="true" />
              <span>
                {sourceDirectory
                  ? `Source folder: ${sourceDirectoryName}`
                  : localFolderSupported
                    ? 'Source folder: browser cache only'
                    : 'Source folder: browser cache only'}
              </span>
            </div>
            <div className="button-row compact">
              <button
                className="secondary-button"
                disabled={!localFolderSupported}
                onClick={() => void attachSourceFolder()}
                type="button"
              >
                <FolderOpen size={18} />
                Attach Folder
              </button>
              <button
                className="secondary-button"
                disabled={!sourceDirectory || !backend || isSyncingSource}
                onClick={() => void syncSourceToFolder()}
                type="button"
              >
                {isSyncingSource ? (
                  <Loader2 className="spin" size={18} />
                ) : (
                  <FileCode2 size={18} />
                )}
                Sync Source
              </button>
            </div>
            {sourceDirectory ? (
              <button
                className="link-button"
                onClick={() => void forgetSourceFolder()}
                type="button"
              >
                Detach local folder
              </button>
            ) : null}
          </div>

          <label className="field prompt-field">
            <span>
              <Monitor size={16} aria-hidden="true" />
              Website brief
            </span>
            <textarea
              onChange={(event) => {
                setPrompt(event.target.value);
                setActiveProject((current) => ({
                  ...current,
                  prompt: event.target.value,
                }));
              }}
              value={prompt}
            />
          </label>

          <div className="button-row">
            <button
              className="secondary-button"
              disabled={isBooting}
              onClick={() => void bootVm()}
              type="button"
            >
              {isBooting ? <Loader2 className="spin" size={18} /> : <Server size={18} />}
              Boot VM
            </button>
            <button
              className="secondary-button"
              disabled={isConnecting}
              onClick={() => void connectTailnet()}
              type="button"
            >
              {isConnecting ? <Loader2 className="spin" size={18} /> : <Cable size={18} />}
              Tailnet
            </button>
          </div>

          <button
            className="primary-button"
            disabled={primaryDisabled}
            onClick={() => void buildWebsite()}
            type="button"
          >
            {isBuilding ? <Loader2 className="spin" size={20} /> : <Play size={20} />}
            Build and Serve
          </button>
        </section>

        <section className="pane build-pane" aria-labelledby="build-title">
          <div className="pane-heading">
            <div>
              <p className="step-label">02</p>
              <h2 id="build-title">VM Build</h2>
            </div>
            <button
              className="icon-button"
              disabled={!backend}
              onClick={() => void resetWorkspace()}
              title="Reset workspace"
              type="button"
            >
              <RefreshCcw size={18} />
            </button>
          </div>

          <div className="status-grid">
            <div className={`status-chip status-${vmStatus.lifecycle}`}>
              <Server size={15} aria-hidden="true" />
              {lifecycleLabel(vmStatus)}
            </div>
            <div className="status-chip">
              <Globe2 size={15} aria-hidden="true" />
              {vmStatus.tailnetIp ?? 'No Tailnet IP'}
            </div>
            <div className="status-chip">
              <Monitor size={15} aria-hidden="true" />
              Port {SERVER_PORT}
            </div>
          </div>

          <p className="status-message">{vmStatus.message}</p>

          <div className="split-content">
            <div className="file-list" aria-label="Generated files">
              <div className="subhead">
                <FileCode2 size={16} aria-hidden="true" />
                Files
              </div>
              {files.length === 0 ? (
                <p className="empty-state">No generated files yet.</p>
              ) : (
                files.map((file) => (
                  <div className="file-row" key={`${file.type}:${file.path}`}>
                    <span className={`file-dot ${file.type}`} />
                    <span>{file.path}</span>
                  </div>
                ))
              )}
            </div>

            <div
              className="log-list"
              aria-label="Build transcript"
              onScroll={updateLogPin}
              ref={logListRef}
            >
              <div className="subhead">
                <TerminalSquare size={16} aria-hidden="true" />
                Transcript
              </div>
              {logs.length === 0 ? (
                <p className="empty-state">Build transcript will appear here.</p>
              ) : (
                logs.map((line) => (
                  <div className={`log-row log-${line.kind}`} key={line.id}>
                    <time>{line.time}</time>
                    <span>{line.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {finalText ? <p className="final-text">{finalText}</p> : null}
        </section>

        <section className="pane preview-pane" aria-labelledby="preview-title">
          <div className="pane-heading">
            <div>
              <p className="step-label">03</p>
              <h2 id="preview-title">Preview</h2>
            </div>
            <div className="preview-actions">
              <span className={`ready-pill ${previewReady ? 'ready' : ''}`}>
                <CheckCircle2 size={15} aria-hidden="true" />
                {previewReady ? 'Ready' : 'Waiting'}
              </span>
              <button
                className="icon-button"
                disabled={!previewUrl}
                onClick={() =>
                  previewUrl && window.open(previewUrl, '_blank', 'noopener,noreferrer')
                }
                title="Open preview"
                type="button"
              >
                <ExternalLink size={18} />
              </button>
            </div>
          </div>

          {previewUrl ? (
            <div className="preview-ready-strip">
              <CheckCircle2 size={17} aria-hidden="true" />
              <span>VM page is hosted at {previewUrl}</span>
              <button
                className="link-button"
                onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')}
                type="button"
              >
                Open
              </button>
            </div>
          ) : null}

          <div className="preview-frame">
            <div className={`preview-launch ${previewReady ? 'ready' : ''}`}>
              <Monitor size={28} aria-hidden="true" />
              <strong>
                {previewReady ? 'Hosted page ready' : 'Waiting for VM address'}
              </strong>
              <span>
                {previewUrl ??
                  'The generated site will open in a separate browser tab.'}
              </span>
              <button
                className="primary-button"
                disabled={!previewUrl}
                onClick={() =>
                  previewUrl && window.open(previewUrl, '_blank', 'noopener,noreferrer')
                }
                type="button"
              >
                <ExternalLink size={18} />
                Open Site
              </button>
            </div>
          </div>

          <div className="terminal-output" aria-label="VM terminal output">
            <div className="subhead">
              <TerminalSquare size={16} aria-hidden="true" />
              Terminal
            </div>
            <pre>{terminal || '$ VM output will stream here'}</pre>
          </div>
        </section>
      </main>
    </div>
  );
}
