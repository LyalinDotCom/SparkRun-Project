import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowRight,
  Cable,
  CheckCircle2,
  ChevronDown,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  FileCode2,
  Files,
  FolderOpen,
  Globe2,
  HardDrive,
  KeyRound,
  Monitor,
  Send,
  Server,
  Settings,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { runWebsiteAgent, type AgentEvent } from './lib/agent';
import { MODEL_ID, SITE_ROOT } from './lib/constants';
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
  type SavedProject,
  type SavedProjectFile,
} from './lib/projects';
import {
  CHEERPX_PINNED_VERSION,
  detectCheerpxRuntimeVersion,
  hardResetSparkrunCaches,
  SPARKRUN_BUILD_SHA,
  SPARKRUN_BUILD_TIME,
  validateGoogleApiKey,
  validateTailscaleAuthKey,
  WebVmBackend,
  type WebVmDebugEntry,
  type WebVmStatus,
} from './lib/webvm';
import type { DirectoryEntry, VmFileBackend } from './lib/tools';

type Screen = 'setup' | 'chat';

type EventKind =
  | 'chat'
  | 'thought'
  | 'status'
  | 'cmd'
  | 'stream'
  | 'ready'
  | 'error';

type ToolCategory = 'edit' | 'shell' | 'inspect';
type EventTone = 'normal' | 'error';

interface LogEvent {
  id: number;
  kind: EventKind;
  label?: string;
  text?: string;
  cmd?: string;
  lines?: string[];
  toolCategory?: ToolCategory;
  tone?: EventTone;
  time: string;
}

interface ToolLogGroup {
  type: 'tool-group';
  id: number;
  category: ToolCategory;
  events: LogEvent[];
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
  serverPort: null,
};

const MODELS = [
  { id: MODEL_ID, label: 'Flash preview', sub: 'Only model enabled' },
];

function formatBuildTimeLocal(iso: string): string {
  if (!iso || iso === 'dev' || iso === 'unknown') return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const local = date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const tz =
    Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  return tz ? `${local} ${tz}` : local;
}

function clock(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function lifecycleLabel(status: WebVmStatus): string {
  switch (status.lifecycle) {
    case 'idle':
      return 'Idle';
    case 'booting':
      return 'Booting';
    case 'ready':
      return 'VM ready';
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
    entries.set(file.path, {
      path: file.path,
      type: 'file',
      sizeBytes: byteLength(file.content),
    });
  }
  return mergeEntries(Array.from(entries.values()));
}

function byteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return 'unknown';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function makeId(): number {
  return Date.now() + Math.floor(Math.random() * 1000);
}

function isRetryPrompt(text: string): boolean {
  return /^(try again|retry|again|rerun|rebuild)$/i.test(text.trim());
}

function resolveBuildPrompt(
  draft: string,
  events: LogEvent[],
  fallbackPrompt: string,
): string {
  if (!isRetryPrompt(draft)) {
    return draft;
  }
  const previous = [...events]
    .reverse()
    .find((event) => event.kind === 'chat' && event.text && !isRetryPrompt(event.text));
  return previous?.text?.trim() || fallbackPrompt.trim() || DEFAULT_PROMPT;
}

const BENIGN_TERMINAL_LINES = new Set([
  'mesg: ttyname failed: Success',
  'sg: ttyname failed: Success',
]);

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const LOCAL_PREVIEW_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?/gi;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function cleanTerminalLine(line: string): string {
  return line
    .replace(ANSI_PATTERN, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

function filterTerminalOutput(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const filtered = lines.filter(
    (line) => !BENIGN_TERMINAL_LINES.has(cleanTerminalLine(line)),
  );
  return filtered.join('\n');
}

function formatFinalSummary(text: string, previewUrl: string | null): string {
  const replacement = previewUrl ?? 'the Tailnet preview URL';
  const cleaned = text.trim().replace(LOCAL_PREVIEW_URL_PATTERN, replacement);
  if (!previewUrl || cleaned.includes(previewUrl)) {
    return cleaned;
  }
  return `${cleaned}\n\n**Preview:** ${previewUrl}`;
}

function portFromPreviewUrl(url: string | null): number | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function hostFromPreviewUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function cleanStatusOutput(text: string): string {
  return filterTerminalOutput(text)
    .split('\n')
    .map((line) => cleanTerminalLine(line))
    .filter(Boolean)
    .join('\n');
}

function stripSiteRoot(text: string): string {
  return text
    .replaceAll(`${SITE_ROOT}/`, '')
    .replaceAll(SITE_ROOT, '.')
    .trim();
}

function toolCategoryForMessage(message: string): ToolCategory | null {
  const text = message.trim();
  if (/^(write_file|replace|Wrote|Edited|Created)\b/i.test(text)) {
    return 'edit';
  }
  if (/^(read_file|list_directory|Read|Listed)\b/i.test(text)) {
    return 'inspect';
  }
  if (/^(run_shell_command|Started|Ran)\b/i.test(text)) {
    return 'shell';
  }
  if (/^(write_file|replace)\s+failed:/i.test(text)) {
    return 'edit';
  }
  if (/^(read_file|list_directory)\s+failed:/i.test(text)) {
    return 'inspect';
  }
  if (/^run_shell_command\s+failed:/i.test(text)) {
    return 'shell';
  }
  return null;
}

function toolCategoryLabel(category: ToolCategory): string {
  if (category === 'edit') return 'Edit';
  if (category === 'inspect') return 'Inspect';
  return 'Shell';
}

function formatToolDetail(message: string): string {
  const text = stripSiteRoot(cleanStatusOutput(message) || message.trim());
  return text
    .replace(/^write_file\s+/i, 'write ')
    .replace(/^replace\s+/i, 'replace ')
    .replace(/^read_file\s+/i, 'read ')
    .replace(/^list_directory\s+/i, 'list ')
    .replace(/^run_shell_command\s+/i, '$ ')
    .replace(/^Wrote\s+/i, 'wrote ')
    .replace(/^Edited\s+/i, 'edited ')
    .replace(/^Created\s+/i, 'created ')
    .replace(/^Read\s+/i, 'read ')
    .replace(/^Listed\s+/i, 'listed ')
    .replace(/^Started\s+/i, 'started ')
    .replace(/^Ran\s+/i, '$ ')
    .replace(/^run_shell_command failed:\s*/i, 'failed: ')
    .replace(/^write_file failed:\s*/i, 'failed: ')
    .replace(/^replace failed:\s*/i, 'failed: ')
    .replace(/^read_file failed:\s*/i, 'failed: ')
    .replace(/^list_directory failed:\s*/i, 'failed: ');
}

function eventFromAgentEvent(
  event: AgentEvent,
): Omit<LogEvent, 'id' | 'time'> | null {
  if (event.type === 'model' || event.type === 'done') {
    return null;
  }

  const category = toolCategoryForMessage(event.message);
  if (event.type === 'tool' || category) {
    return {
      kind: 'cmd',
      text: formatToolDetail(event.message),
      toolCategory: category ?? 'shell',
      tone: event.type === 'error' ? 'error' : 'normal',
    };
  }

  return {
    kind: 'error',
    text: event.message,
    tone: 'error',
  };
}

function formatDebugEntry(entry: WebVmDebugEntry): string {
  const parts = [`[${clock()}] ${entry.phase}`];
  if (entry.cwd) {
    parts.push(`cwd=${entry.cwd}`);
  }
  if (entry.status !== undefined) {
    parts.push(`status=${entry.status}`);
  }
  if (entry.background) {
    parts.push('background=true');
  }
  const header = parts.join(' ');
  const command = entry.command ? `\n$ ${entry.command}` : '';
  const output = entry.output ? `\n${cleanStatusOutput(entry.output)}` : '';
  return `${header}${command}${output}`;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' &&
      error instanceof DOMException &&
      error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

async function waitForPreviewUrl(
  vm: VmFileBackend & { getPreviewUrl?: () => string | null },
  timeoutMs: number,
): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const url = vm.getPreviewUrl?.() ?? null;
    if (url) {
      return url;
    }
    await sleep(750);
  }
  return vm.getPreviewUrl?.() ?? null;
}

async function checkPreviewFromBrowser(url: string): Promise<{
  status: number;
  output: string;
}> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5_000);
  try {
    await fetch(url, {
      cache: 'no-store',
      mode: 'no-cors',
      signal: controller.signal,
    });
    return {
      status: 0,
      output: `browser: reachable at ${url}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 1,
      output: `browser: Tailnet fetch failed for ${url}: ${message}`,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildTimelineItems(events: LogEvent[]): Array<LogEvent | ToolLogGroup> {
  const items: Array<LogEvent | ToolLogGroup> = [];

  for (const event of events) {
    const category =
      event.kind === 'cmd'
        ? event.toolCategory ??
          toolCategoryForMessage(event.text ?? event.cmd ?? '')
        : null;

    if (!category) {
      items.push(event);
      continue;
    }

    const previous = items[items.length - 1];
    if (previous && isToolLogGroup(previous) && previous.category === category) {
      previous.events.push(event);
      previous.time = event.time;
      continue;
    }

    items.push({
      type: 'tool-group',
      id: event.id,
      category,
      events: [event],
      time: event.time,
    });
  }

  return items;
}

function isToolLogGroup(item: LogEvent | ToolLogGroup): item is ToolLogGroup {
  return 'type' in item && item.type === 'tool-group';
}

interface AppBarProps {
  title: string;
  subtitle?: string;
  subtitleTone?: 'live' | 'run' | 'idle';
  onBack?: () => void;
  right?: React.ReactNode;
}

function AppBar({ title, subtitle, subtitleTone, onBack, right }: AppBarProps) {
  return (
    <header className="appbar">
      <div className="appbar-inner">
        {onBack ? (
          <button
            aria-label="Back"
            className="icon-btn"
            onClick={onBack}
            type="button"
          >
            <ArrowLeft size={17} />
          </button>
        ) : (
          <div className="appbar-mark" aria-hidden="true">
            <Sparkles size={18} />
          </div>
        )}
        <div className="appbar-title">
          <h1>{title}</h1>
          {subtitle ? (
            <div className={`appbar-subtitle ${subtitleTone ?? 'idle'}`}>
              {subtitle}
            </div>
          ) : null}
        </div>
        <div className="appbar-actions">{right}</div>
      </div>
    </header>
  );
}

interface SetupScreenProps {
  cfg: {
    apiKey: string;
    tailKey: string;
    projectName: string;
    model: string;
    remember: boolean;
  };
  onApiKey: (value: string) => void;
  onTailKey: (value: string) => void;
  onProjectName: (value: string) => void;
  onProjectNameBlur: (value: string) => void;
  onModel: (value: string) => void;
  onRemember: (enabled: boolean) => void;
  hasOpenedBefore: boolean;
  onContinue: () => void;
  projects: SavedProject[];
  activeProject: SavedProject;
  onSelectProject: (project: SavedProject) => void;
  onDeleteProject: (id: string) => void;
  onNewProject: () => void;
  onSaveProject: () => void;
  sourceDirectoryName: string;
  hasSourceDirectory: boolean;
  localFolderSupported: boolean;
  onAttachFolder: () => void;
  onDetachFolder: () => void;
}

function KeyValidationStatus({
  value,
  validate,
}: {
  value: string;
  validate: (input: string) => string | null;
}) {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const error = validate(value);
  if (error) {
    return (
      <p className="field-status is-invalid">
        <TriangleAlert size={12} aria-hidden="true" /> {error}
      </p>
    );
  }
  return (
    <p className="field-status is-valid">
      <CheckCircle2 size={12} aria-hidden="true" /> Looks valid.
    </p>
  );
}

function SetupScreen(props: SetupScreenProps) {
  const [showKey1, setShowKey1] = useState(false);
  const [showKey2, setShowKey2] = useState(false);
  const [runtimeCheerpxVersion, setRuntimeCheerpxVersion] = useState<
    string | null
  >(() => detectCheerpxRuntimeVersion());
  const [verifying, setVerifying] = useState(false);
  const [resetting, setResetting] = useState(false);
  const verifyCheerpxVersion = async () => {
    setVerifying(true);
    try {
      await import('@leaningtech/cheerpx');
      for (let i = 0; i < 20; i += 1) {
        const detected = detectCheerpxRuntimeVersion();
        if (detected) {
          setRuntimeCheerpxVersion(detected);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      setVerifying(false);
    }
  };
  const resetWorkspace = async (includeDiskCache: boolean) => {
    const message = includeDiskCache
      ? 'Wipe BOTH the workspace and the cached Debian disk image, then reload? The disk will re-download (~30s slower next boot).'
      : 'Wipe the in-browser workspace IndexedDB and reload? Your generated files will be lost.';
    if (!window.confirm(message)) return;
    setResetting(true);
    try {
      await hardResetSparkrunCaches({ includeDiskCache });
      window.location.reload();
    } catch (error) {
      setResetting(false);
      window.alert(
        `Failed to reset caches: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const ready = props.cfg.projectName.trim().length > 0;

  return (
    <main className="screen">
      <div className="empty-hero" style={{ marginBottom: 24 }}>
        <p className="eyebrow">Setup</p>
        <h2 className="display">
          Connect your <span className="gemini-grad">keys</span>.
        </h2>
        <p className="lede">
          SparkRun runs a micro-VM in your browser, builds with Gemini, and
          exposes the result on a Tailscale endpoint. Keys live in browser
          memory only.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="field">
          <label className="field-label" htmlFor="setup-project-name">
            <FileCode2 size={13} aria-hidden="true" /> Project name
          </label>
          <input
            id="setup-project-name"
            className="text-input"
            onBlur={(event) => props.onProjectNameBlur(event.currentTarget.value)}
            onChange={(event) => props.onProjectName(event.target.value)}
            placeholder="Untitled site"
            value={props.cfg.projectName}
          />
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">
            <Cpu size={13} aria-hidden="true" /> Model
          </span>
          <div className="model-grid">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => props.onModel(m.id)}
                className={`model-option ${
                  props.cfg.model === m.id ? 'active' : ''
                }`}
              >
                <div className="model-option-label">
                  <span className="gemini-grad">✦</span>
                  {m.label}
                </div>
                <div className="model-option-sub">{m.sub}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="field">
          <label className="field-label" htmlFor="setup-google-key">
            <KeyRound size={13} aria-hidden="true" /> Google AI key
          </label>
          <div className="input-wrap">
            <input
              id="setup-google-key"
              className={`text-input has-suffix ${
                props.cfg.apiKey.trim().length === 0
                  ? ''
                  : validateGoogleApiKey(props.cfg.apiKey)
                    ? 'is-invalid'
                    : 'is-valid'
              }`}
              autoComplete="off"
              onChange={(event) => props.onApiKey(event.target.value)}
              placeholder="AIza..."
              type={showKey1 ? 'text' : 'password'}
              value={props.cfg.apiKey}
            />
            <button
              aria-label={showKey1 ? 'Hide key' : 'Show key'}
              className="input-suffix"
              onClick={() => setShowKey1(!showKey1)}
              type="button"
            >
              {showKey1 ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <KeyValidationStatus
            value={props.cfg.apiKey}
            validate={validateGoogleApiKey}
          />
          <p className="field-hint">
            Used to call Gemini for code generation.{' '}
            <a
              className="field-link"
              href="https://aistudio.google.com/api-keys"
              rel="noreferrer"
              target="_blank"
            >
              Create one in AI Studio
            </a>
            .
          </p>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="setup-tail-key">
            <Cable size={13} aria-hidden="true" /> Tailscale auth key
          </label>
          <div className="input-wrap">
            <input
              id="setup-tail-key"
              className={`text-input has-suffix ${
                props.cfg.tailKey.trim().length === 0
                  ? ''
                  : validateTailscaleAuthKey(props.cfg.tailKey)
                    ? 'is-invalid'
                    : 'is-valid'
              }`}
              autoComplete="off"
              onChange={(event) => props.onTailKey(event.target.value)}
              placeholder="tskey-auth-..."
              type={showKey2 ? 'text' : 'password'}
              value={props.cfg.tailKey}
            />
            <button
              aria-label={showKey2 ? 'Hide key' : 'Show key'}
              className="input-suffix"
              onClick={() => setShowKey2(!showKey2)}
              type="button"
            >
              {showKey2 ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          <KeyValidationStatus
            value={props.cfg.tailKey}
            validate={validateTailscaleAuthKey}
          />
          <p className="field-hint">
            Used so the in-browser VM can join your tailnet and serve a preview
            URL. Use a <strong>reusable</strong>, <strong>ephemeral</strong>,{' '}
            <strong>pre-approved</strong> key.
            <br />
            <a
              className="field-link"
              href="https://login.tailscale.com/admin/settings/keys"
              rel="noreferrer"
              target="_blank"
            >
              Create a key
            </a>{' '}
            ·{' '}
            <a
              className="field-link"
              href="https://tailscale.com/docs/features/access-control/auth-keys"
              rel="noreferrer"
              target="_blank"
            >
              How auth keys work
            </a>
          </p>
        </div>
      </div>

      <label className="toggle-row" htmlFor="setup-remember">
        <input
          checked={props.cfg.remember}
          id="setup-remember"
          onChange={(event) => props.onRemember(event.target.checked)}
          type="checkbox"
        />
        <span>Remember keys on this browser</span>
        <span className={`toggle-track ${props.cfg.remember ? 'on' : ''}`}>
          <span className="toggle-thumb" />
        </span>
      </label>

      <div className="card" style={{ marginBottom: 14 }}>
        <div
          className="field-label"
          style={{ justifyContent: 'space-between', marginBottom: 10 }}
        >
          <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
            <Files size={13} aria-hidden="true" /> Saved projects
          </span>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button
              className="link-btn"
              onClick={props.onSaveProject}
              type="button"
            >
              Save Project
            </button>
            <button
              className="link-btn"
              onClick={props.onNewProject}
              type="button"
            >
              New
            </button>
          </span>
        </div>
        <div className="project-list">
          {props.projects.length === 0 ? (
            <p className="project-empty">No saved projects yet.</p>
          ) : (
            props.projects.map((project) => (
              <div
                key={project.id}
                className={`project-row ${
                  project.id === props.activeProject.id ? 'active' : ''
                }`}
              >
                <button
                  type="button"
                  className="project-name"
                  style={{
                    background: 'transparent',
                    textAlign: 'left',
                    minWidth: 0,
                  }}
                  onClick={() => props.onSelectProject(project)}
                >
                  {project.name}
                </button>
                <span className="project-date">
                  {project.files.length} files ·{' '}
                  {new Date(project.updatedAt).toLocaleDateString()}
                </span>
                <button
                  aria-label={`Delete ${project.name}`}
                  className="delete-btn"
                  onClick={() => props.onDeleteProject(project.id)}
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <span className="field-label">
          <HardDrive size={13} aria-hidden="true" /> Source folder
        </span>
        <div className={`source-row ${props.hasSourceDirectory ? 'ready' : ''}`}>
          <FolderOpen size={14} aria-hidden="true" />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {props.hasSourceDirectory
              ? props.sourceDirectoryName
              : 'Browser cache only'}
          </span>
        </div>
        <div className="source-actions">
          <button
            className="ghost-btn"
            disabled={!props.localFolderSupported}
            onClick={props.onAttachFolder}
            type="button"
          >
            <FolderOpen size={15} /> Attach folder
          </button>
          <button
            className="ghost-btn"
            disabled={!props.hasSourceDirectory}
            onClick={props.onDetachFolder}
            type="button"
          >
            Detach
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="field-label" style={{ marginBottom: 10 }}>
          <Cpu size={13} aria-hidden="true" /> Diagnostics
        </div>
        <div className="diag-row">
          <span className="diag-label">SparkRun build</span>
          <span className="diag-value">
            {SPARKRUN_BUILD_SHA} · {formatBuildTimeLocal(SPARKRUN_BUILD_TIME)}
          </span>
        </div>
        <div className="diag-row">
          <span className="diag-label">CheerpX (pinned in package.json)</span>
          <span className="diag-value">{CHEERPX_PINNED_VERSION}</span>
        </div>
        <div className="diag-row">
          <span className="diag-label">CheerpX (loaded at runtime)</span>
          <span className="diag-value">
            {runtimeCheerpxVersion ?? 'not loaded yet'}
          </span>
        </div>
        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            className="ghost-btn"
            onClick={verifyCheerpxVersion}
            type="button"
            disabled={verifying || resetting}
          >
            {verifying ? 'Checking…' : 'Verify CheerpX version'}
          </button>
          <button
            className="ghost-btn"
            onClick={() => resetWorkspace(false)}
            type="button"
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : 'Reset workspace'}
          </button>
          <button
            className="ghost-btn"
            onClick={() => resetWorkspace(true)}
            type="button"
            disabled={resetting}
          >
            {resetting ? 'Resetting…' : 'Reset everything'}
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>
          Pinned is the version npm installed. Loaded is parsed from the actual{' '}
          <code>cxrtnc.leaningtech.com/&lt;version&gt;/</code> URL the browser
          fetched. Click Verify to fetch CheerpX and confirm — or boot the VM
          and they'll match in the Logs.
        </p>
        <p className="field-hint" style={{ marginTop: 6 }}>
          <strong>Reset workspace</strong> wipes the in-browser workspace
          IndexedDB and reloads — fixes a half-mounted "Read-only file system"
          state. <strong>Reset everything</strong> also wipes the cached Debian
          disk image (slower next boot, but a true clean slate).
        </p>
      </div>

      <div className="warn-strip">
        <TriangleAlert size={15} aria-hidden="true" />
        <div>
          Dev prototype — keys stay in browser memory unless saving is on. Ship
          a server-side flow before production.
        </div>
      </div>

      <div className="sticky-bottom">
        <div className="sticky-bottom-inner">
          <button
            className="primary-btn"
            disabled={!ready}
            onClick={props.onContinue}
            type="button"
          >
            {props.hasOpenedBefore ? 'Back to project' : 'Continue'}
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </main>
  );
}

interface ChatScreenProps {
  cfg: { model: string; projectName: string };
  events: LogEvent[];
  files: DirectoryEntry[];
  building: boolean;
  ready: boolean;
  tailnetIp: string | null;
  previewUrl: string | null;
  serverPort: number | null;
  vmStatus: WebVmStatus;
  hasStarted: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onOpenWebsite: () => void;
  onRetryTailnet: () => void;
  onFiles: () => void;
  onLogs: () => void;
  onTerminal: () => void;
  errorMessage: string | null;
}

function StreamLine({ line }: { line: string }) {
  let cls = 'stream-line';
  if (line.startsWith('[vm]')) cls = 'stream-line vm';
  else if (/error|fail/i.test(line)) cls = 'stream-line err';
  return <div className={cls}>{line}</div>;
}

function MarkdownMessage({ text }: { text?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: ({ children, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text ?? ''}
    </ReactMarkdown>
  );
}

function ChatScreen({
  cfg,
  events,
  files,
  building,
  ready,
  tailnetIp,
  previewUrl,
  serverPort,
  vmStatus,
  hasStarted,
  draft,
  onDraft,
  onSend,
  onCancel,
  onOpenWebsite,
  onRetryTailnet,
  onFiles,
  onLogs,
  onTerminal,
  errorMessage,
}: ChatScreenProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);
  const sourceFiles = useMemo(() => files.filter(isSourceFile), [files]);
  const totalBytes = sourceFiles.reduce(
    (total, file) => total + (file.sizeBytes ?? 0),
    0,
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: hasStarted ? 'smooth' : 'auto' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [events.length, hasStarted]);

  const canSend = draft.trim().length > 3 && !building;
  const statusText = ready
    ? 'Live'
    : building
      ? 'Building'
      : hasStarted
        ? lifecycleLabel(vmStatus)
        : 'Ready to build';
  const statusTone = ready ? 'ok' : building ? 'run' : 'idle';
  const portLabel = serverPort ? `:${serverPort}` : ':auto';
  const previewHost = hostFromPreviewUrl(previewUrl);
  const canRetryTailnet = hasStarted && !ready && !building && !tailnetIp;

  return (
    <div className="chat-frame">
      <div className="status-strip">
        <div className="status-strip-inner">
          <span className={`pill ${statusTone}`}>
            {ready ? (
              <CheckCircle2 size={12} aria-hidden="true" />
            ) : building ? (
              <Cpu size={12} aria-hidden="true" />
            ) : (
              <Server size={12} aria-hidden="true" />
            )}
            {statusText}
          </span>
          <span className={`pill ${tailnetIp ? 'ok' : ''}`}>
            <Globe2 size={12} aria-hidden="true" />
            {tailnetIp ?? 'No tailnet IP'}
          </span>
          <span className={`pill ${ready ? 'ok' : ''}`}>
            <Monitor size={12} aria-hidden="true" />
            {portLabel}
          </span>
          {sourceFiles.length > 0 ? (
            <button
              aria-label="Open generated files"
              className="terminal-toggle file-toggle"
              onClick={onFiles}
              type="button"
            >
              <Files size={12} aria-hidden="true" />
              {sourceFiles.length} file{sourceFiles.length === 1 ? '' : 's'}
              <span className="file-toggle-size">{formatBytes(totalBytes)}</span>
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          {canRetryTailnet ? (
            <button
              aria-label="Retry Tailnet"
              className="terminal-toggle warn"
              onClick={onRetryTailnet}
              type="button"
            >
              <Cable size={12} aria-hidden="true" />
              Retry Tailnet
            </button>
          ) : null}
          <button
            aria-label="Open terminal"
            className="terminal-toggle"
            onClick={onTerminal}
            type="button"
          >
            <TerminalIcon size={12} aria-hidden="true" />
            Terminal
          </button>
          <button
            aria-label="Open logs"
            className="terminal-toggle"
            onClick={onLogs}
            type="button"
          >
            <FileCode2 size={12} aria-hidden="true" />
            Logs
          </button>
        </div>
      </div>

      <div className="log-scroll" ref={scrollRef}>
        <div className="log-inner">
          {!hasStarted && events.length === 0 ? (
            <div className="empty-hero">
              <p className="eyebrow">New build</p>
              <h2 className="display sm">
                What do you want to <span className="gemini-grad">build</span>?
              </h2>
              <p className="lede sm">
                Describe the site or app. I&rsquo;ll plan files, write code,
                install deps, and serve it on your tailnet.
              </p>
            </div>
          ) : null}

          {timelineItems.map((item) => (
            isToolLogGroup(item) ? (
              <ToolGroupRow group={item} key={`tool-${item.id}`} />
            ) : (
              <LogRow key={item.id} event={item} />
            )
          ))}

          {building && events.length > 0 ? (
            <div className="gen-row fadeUp">
              <div className="icon-cell">
                <span className="spin tiny coral" />
              </div>
              generating…
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer">
        <div className="composer-inner">
          {ready ? (
            <button
              className="open-website-btn"
              onClick={onOpenWebsite}
              type="button"
            >
              <span className="left">
                <span className="dot pulse" />
                Open website
                <span className="url">
                  {previewHost ?? (tailnetIp && serverPort ? `${tailnetIp}:${serverPort}` : 'preview')}
                </span>
              </span>
              <ExternalLink size={15} />
            </button>
          ) : null}

          {errorMessage ? (
            <div className="error-strip" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <div>{errorMessage}</div>
            </div>
          ) : null}

          <div className={`composer-shell ${building ? 'busy' : ''}`}>
            <div className="composer-card">
              <label
                htmlFor="chat-prompt"
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  margin: -1,
                  border: 0,
                  padding: 0,
                  whiteSpace: 'nowrap',
                  clipPath: 'inset(50%)',
                  overflow: 'hidden',
                }}
              >
                Website brief
              </label>
              <textarea
                id="chat-prompt"
                aria-label="Website brief"
                onChange={(event) => onDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    if (canSend) onSend();
                  }
                }}
                placeholder={
                  hasStarted
                    ? 'Iterate — what should change?'
                    : 'Describe a website or app to build…'
                }
                rows={hasStarted ? 2 : 3}
                value={draft}
              />
              <div className="composer-foot">
                <span className="composer-model">
                  <span className="gemini-grad star">✦</span>
                  {cfg.model}
                </span>
                <div className="composer-actions">
                  {building ? (
                    <button
                      className="stop-btn"
                      onClick={onCancel}
                      type="button"
                    >
                      <Square size={11} fill="currentColor" /> Stop
                    </button>
                  ) : (
                    <button
                      className={`send-btn ${canSend ? 'active' : ''}`}
                      disabled={!canSend}
                      onClick={onSend}
                      type="button"
                    >
                      {hasStarted ? 'Update' : 'Build'}
                      <Send size={12} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
          <div className="composer-hint">⌘⏎ to send</div>
        </div>
      </div>
    </div>
  );
}

function LogRow({ event }: { event: LogEvent }) {
  const labelMap: Record<EventKind, string> = {
    chat: 'You',
    thought: 'gemini',
    status: event.label ?? 'Status',
    cmd: event.toolCategory ? toolCategoryLabel(event.toolCategory) : 'Shell',
    stream: 'Output',
    ready: 'Live',
    error: 'Error',
  };
  const label = event.label ?? labelMap[event.kind];

  let body: React.ReactNode = null;
  if (event.kind === 'chat') {
    body = <div className="chat-bubble">{event.text}</div>;
  } else if (event.kind === 'thought' || event.kind === 'status') {
    body = (
      <div className="thought-text markdown-message">
        <MarkdownMessage text={event.text} />
      </div>
    );
  } else if (event.kind === 'cmd') {
    body = (
      <div className={`cmd-text ${event.tone === 'error' ? 'err' : ''}`}>
        <span className="prompt">$</span>
        <span className="body">{event.cmd ?? event.text}</span>
      </div>
    );
  } else if (event.kind === 'stream') {
    body = (
      <div className="stream-block">
        {(event.lines ?? []).map((line, idx) => (
          <StreamLine key={idx} line={line} />
        ))}
      </div>
    );
  } else if (event.kind === 'ready') {
    body = (
      <div className="ready-banner">
        <Sparkles size={14} aria-hidden="true" />
        <div className="markdown-message">
          <MarkdownMessage text={event.text} />
        </div>
      </div>
    );
  } else if (event.kind === 'error') {
    body = (
      <div className="error-banner">
        <TriangleAlert size={14} aria-hidden="true" />
        <div className="markdown-message">
          <MarkdownMessage text={event.text} />
        </div>
      </div>
    );
  }

  return (
    <div className="log-row fadeUp">
      <div className="log-rail">
        <div className={`log-icon ${event.kind}`}>{iconForKind(event.kind)}</div>
        <div className="line" />
      </div>
      <div className="log-body">
        <div className="log-meta">
          <span className="log-label">{label}</span>
          <span className="log-time">{event.time}</span>
        </div>
        {body}
      </div>
    </div>
  );
}

function ToolGroupRow({ group }: { group: ToolLogGroup }) {
  const hasError = group.events.some((event) => event.tone === 'error');
  return (
    <div className="log-row fadeUp">
      <div className="log-rail">
        <div className={`log-icon cmd ${hasError ? 'err' : ''}`}>
          {iconForToolCategory(group.category)}
        </div>
        <div className="line" />
      </div>
      <div className="log-body">
        <div className="log-meta">
          <span className="log-label">{toolCategoryLabel(group.category)}</span>
          <span className="log-time">{group.time}</span>
        </div>
        <div className="tool-group">
          {group.events.map((event) => (
            <div
              className={`tool-detail ${
                event.tone === 'error' ? 'err' : ''
              }`}
              key={event.id}
            >
              <span className="tool-dot" aria-hidden="true" />
              <span>{event.text ?? event.cmd}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function iconForToolCategory(category: ToolCategory) {
  const size = 13;
  if (category === 'edit') {
    return <FileCode2 size={size} aria-hidden="true" />;
  }
  if (category === 'inspect') {
    return <Files size={size} aria-hidden="true" />;
  }
  return <TerminalIcon size={size} aria-hidden="true" />;
}

function iconForKind(kind: EventKind) {
  const size = 13;
  switch (kind) {
    case 'chat':
      return <Monitor size={size} aria-hidden="true" />;
    case 'thought':
      return <Sparkles size={size} aria-hidden="true" />;
    case 'cmd':
      return <TerminalIcon size={size} aria-hidden="true" />;
    case 'stream':
      return <TerminalIcon size={size} aria-hidden="true" />;
    case 'status':
      return <ChevronDown size={size} aria-hidden="true" />;
    case 'ready':
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case 'error':
      return <TriangleAlert size={size} aria-hidden="true" />;
  }
}

interface TerminalDrawerProps {
  open: boolean;
  onClose: () => void;
  text: string;
  input: string;
  disabled: boolean;
  onInput: (value: string) => void;
  onSendInput: (inputOverride?: string) => void;
}

interface FileDrawerProps {
  open: boolean;
  onClose: () => void;
  files: DirectoryEntry[];
}

interface LogDrawerProps {
  open: boolean;
  onClose: () => void;
  text: string;
}

function LogDrawer({ open, onClose, text }: LogDrawerProps) {
  const lines = text ? text.split('\n') : [];
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="term-overlay open"
        onClick={onClose}
      />
      <div className="term-drawer open">
        <div className="term-head">
          <div className="term-head-title">
            <FileCode2 size={14} aria-hidden="true" /> Diagnostics log
            <span className="term-head-meta">· {lines.length} lines</span>
          </div>
          <button
            aria-label="Close logs"
            className="term-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="term-body" ref={bodyRef}>
          {!text ? (
            <div className="empty">
              Detailed VM commands, health checks, and server logs will appear here.
            </div>
          ) : (
            lines.map((line, idx) => {
              let cls = 'out';
              if (line.startsWith('$')) cls = 'cmd';
              else if (line.startsWith('[')) cls = 'vm';
              else if (/error|fail|refused|exit/i.test(line)) cls = 'err';
              return (
                <div className={cls} key={idx}>
                  {line}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

function FileDrawer({ open, onClose, files }: FileDrawerProps) {
  const sourceFiles = useMemo(() => files.filter(isSourceFile), [files]);
  const totalBytes = sourceFiles.reduce(
    (total, file) => total + (file.sizeBytes ?? 0),
    0,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedPath((current) =>
      current && sourceFiles.some((file) => file.path === current)
        ? current
        : sourceFiles[0]?.path ?? null,
    );
  }, [open, sourceFiles]);

  if (!open) {
    return null;
  }

  const selectedFile =
    sourceFiles.find((file) => file.path === selectedPath) ??
    sourceFiles[0] ??
    null;

  return (
    <>
      <div className="side-overlay open" onClick={onClose} />
      <aside className="side-panel open" aria-label="Generated files panel">
        <div className="side-head">
          <div className="term-head-title">
            <Files size={14} aria-hidden="true" /> Generated files
            <span className="term-head-meta">
              · {sourceFiles.length} files · {formatBytes(totalBytes)}
            </span>
          </div>
          <button
            aria-label="Close files"
            className="term-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        {sourceFiles.length === 0 ? (
          <div className="file-panel-empty">No generated files yet.</div>
        ) : (
          <>
            <div
              aria-label="Generated files"
              className="file-panel-list"
              role="listbox"
            >
              {sourceFiles.map((file) => {
                const active = selectedFile?.path === file.path;
                return (
                  <button
                    aria-selected={active}
                    className={`file-panel-row ${active ? 'active' : ''}`}
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    role="option"
                    type="button"
                  >
                    <FileCode2 size={15} aria-hidden="true" />
                    <span className="file-panel-path">{file.path}</span>
                    <span className="file-panel-size">
                      {formatBytes(file.sizeBytes)}
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedFile ? (
              <div className="file-panel-detail">
                <span>Selected</span>
                <strong>{selectedFile.path}</strong>
                <code>{formatBytes(selectedFile.sizeBytes)}</code>
              </div>
            ) : null}
          </>
        )}
      </aside>
    </>
  );
}

function TerminalDrawer({
  open,
  onClose,
  text,
  input,
  disabled,
  onInput,
  onSendInput,
}: TerminalDrawerProps) {
  const lines = text ? text.split('\n') : [];
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const presets = [
    'pwd',
    'ls -la',
    'ps aux',
    'cat .server.log',
    "python3 - <<'PY'\nimport pathlib\nimport urllib.request\nport = pathlib.Path('.server.port').read_text().strip()\nurl = f'http://127.0.0.1:{port}/'\nwith urllib.request.urlopen(url, timeout=3) as response:\n    print(response.status, url)\nPY",
  ];

  useEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, open]);

  if (!open) {
    return null;
  }

  return (
    <>
      <div
        className="term-overlay open"
        onClick={onClose}
      />
      <div className="term-drawer open">
        <div className="term-head">
          <div className="term-head-title">
            <TerminalIcon size={14} aria-hidden="true" /> Interactive VM terminal
            <span className="term-head-meta">· {lines.length} lines</span>
          </div>
          <button
            aria-label="Close terminal"
            className="term-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        <div className="term-body" ref={bodyRef}>
          {!text ? (
            <div className="empty">
              Open after the VM boots. Commands are sent to a live shell in /workspace/site.
            </div>
          ) : (
            lines.map((line, idx) => {
              let cls = 'out';
              if (line.startsWith('$')) cls = 'cmd';
              else if (line.startsWith('[vm]')) cls = 'vm';
              else if (/error|fail/i.test(line)) cls = 'err';
              return (
                <div className={cls} key={idx}>
                  {line}
                </div>
              );
            })
          )}
        </div>
        <div className="term-presets" aria-label="VM diagnostics">
          {presets.map((preset) => (
            <button
              disabled={disabled}
              key={preset}
              onClick={() => onSendInput(preset)}
              type="button"
            >
              {preset.split('\n')[0].replace("python3 - <<'PY'", 'health')}
            </button>
          ))}
        </div>
        <form
          className="term-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!disabled && input.trim()) {
              onSendInput();
            }
          }}
        >
          <span className="term-prompt">$</span>
          <input
            aria-label="VM command"
            autoCapitalize="off"
            autoCorrect="off"
            disabled={disabled}
            onChange={(event) => onInput(event.target.value)}
            placeholder={disabled ? 'Boot the VM first' : 'pwd, ls -la, cat .server.log'}
            spellCheck={false}
            value={input}
          />
          <button
            disabled={disabled || !input.trim()}
            type="submit"
          >
            Send
          </button>
        </form>
      </div>
    </>
  );
}

export default function App() {
  const savedKeys = useMemo(() => readSavedKeys(), []);
  const [apiKey, setApiKey] = useState(savedKeys.apiKey);
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState(
    savedKeys.tailscaleAuthKey,
  );
  const [rememberKeys, setRememberKeys] = useState(savedKeys.enabled);
  const [model, setModel] = useState<string>(MODEL_ID);
  const [screen, setScreen] = useState<Screen>('setup');
  const [hasOpenedBefore, setHasOpenedBefore] = useState(false);
  const [draft, setDraft] = useState(DEFAULT_PROMPT);
  const [hasStarted, setHasStarted] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  const [projects, setProjects] = useState<SavedProject[]>(() => loadProjects());
  const [activeProject, setActiveProject] = useState<SavedProject>(() =>
    createProject(DEFAULT_PROMPT),
  );

  const [backend, setBackend] = useState<WebVmBackend | null>(null);
  const [vmStatus, setVmStatus] = useState<WebVmStatus>(INITIAL_STATUS);
  const [files, setFiles] = useState<DirectoryEntry[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [terminal, setTerminal] = useState('');
  const [debugLog, setDebugLog] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [building, setBuilding] = useState(false);
  const [ready, setReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [sourceDirectory, setSourceDirectory] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [sourceDirectoryName, setSourceDirectoryName] = useState('');
  const localFolderSupported = useMemo(() => isLocalFolderSupported(), []);
  const restoredProjectIdRef = useRef<string | null>(null);
  const tailnetReadyLoggedRef = useRef<string | null>(null);
  const buildAbortControllerRef = useRef<AbortController | null>(null);

  const previewUrl = useMemo(
    () => vmStatus.previewUrl ?? backend?.getPreviewUrl() ?? null,
    [backend, vmStatus],
  );
  const activeServerPort =
    vmStatus.serverPort ?? portFromPreviewUrl(previewUrl) ?? null;

  const appendEvent = (event: Omit<LogEvent, 'id' | 'time'>) => {
    setEvents((current) =>
      [...current, { ...event, id: makeId(), time: clock() }].slice(-200),
    );
  };

  const appendTerminal = (text: string) => {
    setTerminal((current) => filterTerminalOutput(`${current}${text}`).slice(-50_000));
  };

  const appendDebug = (entry: WebVmDebugEntry) => {
    setDebugLog((current) => {
      const prefix = current ? `${current}\n` : '';
      return filterTerminalOutput(`${prefix}${formatDebugEntry(entry)}`).slice(-80_000);
    });
  };

  useEffect(() => {
    if (!localFolderSupported) {
      return;
    }
    let cancelled = false;
    void loadSavedDirectoryHandle()
      .then((handle) => {
        if (cancelled || !handle) return;
        setSourceDirectory(handle);
        setSourceDirectoryName(handle.name);
      })
      .catch(() => {
        if (!cancelled) {
          appendEvent({
            kind: 'error',
            text: 'Could not restore saved source folder',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [localFolderSupported]);

  useEffect(() => {
    return () => {
      if (backend) {
        void backend.stopServer();
      }
    };
  }, [backend]);

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
    setErrorMessage(null);
  };

  const updateTailscaleAuthKey = (value: string) => {
    const changed = value.trim() !== tailscaleAuthKey.trim();
    setTailscaleAuthKey(value);
    saveKeysIfRemembered(apiKey, value);
    if (changed && backend && !building) {
      setBackend(null);
      setVmStatus(INITIAL_STATUS);
      tailnetReadyLoggedRef.current = null;
      appendEvent({
        kind: 'status',
        label: 'Tailnet key changed',
        text: 'The next build will boot a fresh VM with the updated Tailscale auth key.',
      });
    }
  };

  const updateRememberKeys = (enabled: boolean) => {
    setRememberKeys(enabled);
    if (enabled) {
      writeSavedKeys(apiKey, tailscaleAuthKey);
    } else {
      clearSavedKeys();
    }
  };

  const updateProjectName = (name: string) => {
    setActiveProject((current) => ({ ...current, name }));
  };

  const finalizeProjectName = (name: string) => {
    const cleaned = renameProject(activeProject, name);
    setActiveProject((current) => ({ ...current, name: cleaned.name }));
  };

  const saveActiveProject = (
    updates: Partial<
      Pick<SavedProject, 'name' | 'prompt' | 'previewUrl' | 'files'>
    > = {},
  ): SavedProject => {
    const cleanName = renameProject(
      activeProject,
      updates.name ?? activeProject.name,
    ).name;
    const nextProject: SavedProject = {
      ...activeProject,
      prompt: updates.prompt ?? draft ?? activeProject.prompt,
      ...updates,
      name: cleanName,
      files: updates.files ?? activeProject.files,
    };
    setActiveProject(nextProject);
    setProjects((current) => upsertProject(current, nextProject));
    return nextProject;
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
      if (depth >= 3) return;
      for (const entry of entries) {
        if (entry.type === 'directory' && !entry.path.startsWith('.')) {
          await visit(entry.path, depth + 1);
        }
      }
    };
    await visit('', 0);
    const merged = mergeEntries(collected);
    const withSizes = await Promise.all(
      merged.map(async (entry) => {
        if (entry.type !== 'file') {
          return entry;
        }
        try {
          return {
            ...entry,
            sizeBytes: byteLength(await vm.readText(entry.path)),
          };
        } catch {
          return entry;
        }
      }),
    );
    setFiles(withSizes);
  };

  const collectSourceFiles = async (vm: VmFileBackend): Promise<SourceFile[]> => {
    const collected: DirectoryEntry[] = [];
    const visit = async (dirPath: string, depth: number) => {
      const entries = await vm.listDirectory(dirPath);
      collected.push(...entries);
      if (depth >= 3) return;
      for (const entry of entries) {
        if (entry.type === 'directory' && !entry.path.startsWith('.')) {
          await visit(entry.path, depth + 1);
        }
      }
    };
    await visit('', 0);
    const unique = mergeEntries(collected).filter(isSourceFile);
    const sourceFiles: SourceFile[] = [];
    for (const entry of unique) {
      try {
        sourceFiles.push({
          path: entry.path,
          content: await vm.readText(entry.path),
        });
      } catch (error) {
        appendEvent({
          kind: 'status',
          label: 'Skipped snapshot',
          text: `Could not snapshot ${entry.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    return sourceFiles;
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
    appendEvent({
      kind: 'status',
      label: 'Restored project',
      text: `Restored ${project.files.length} files from ${project.name}`,
    });
  };

  const newProject = () => {
    const project = createProject(DEFAULT_PROMPT);
    setActiveProject(project);
    setDraft(project.prompt);
    setFiles([]);
    setEvents([]);
    setHasStarted(false);
    setReady(false);
    setBuilding(false);
    restoredProjectIdRef.current = null;
    tailnetReadyLoggedRef.current = null;
  };

  const selectProject = async (project: SavedProject) => {
    setActiveProject(project);
    setDraft(project.prompt);
    setFiles(entriesFromProjectFiles(project.files));
    setEvents([]);
    setHasStarted(false);
    setReady(false);
    setBuilding(false);
    if (backend && project.files.length > 0) {
      await restoreProjectFiles(backend, project);
    }
  };

  const removeProject = (projectId: string) => {
    setProjects((current) => deleteProject(current, projectId));
    if (activeProject.id === projectId) {
      const project = createProject(DEFAULT_PROMPT);
      setActiveProject(project);
      setDraft(project.prompt);
      setFiles([]);
      restoredProjectIdRef.current = null;
    }
  };

  const attachSourceFolder = async () => {
    if (!localFolderSupported) {
      return;
    }
    try {
      const handle = await pickSourceDirectory();
      await saveDirectoryHandle(handle);
      setSourceDirectory(handle);
      setSourceDirectoryName(handle.name);
    } catch (error) {
      appendEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const detachSourceFolder = async () => {
    await clearDirectoryHandle();
    setSourceDirectory(null);
    setSourceDirectoryName('');
  };

  const syncSourceToFolder = async (
    vm: VmFileBackend,
    directory: FileSystemDirectoryHandle,
  ) => {
    try {
      const sourceFiles = await collectSourceFiles(vm);
      if (sourceFiles.length === 0) return;
      await writeSourceFiles(directory, sourceFiles);
    } catch (error) {
      appendEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const bootVm = async (): Promise<WebVmBackend> => {
    if (backend) {
      appendEvent({
        kind: 'status',
        label: 'Fresh VM',
        text: 'Starting a clean VM for this run.',
      });
      await backend.stopServer();
      setBackend(null);
    }
    setVmStatus({
      lifecycle: 'booting',
      message: 'Starting WebVM',
      tailnetIp: null,
      loginUrl: null,
      previewUrl: null,
      serverPort: null,
    });
    appendEvent({
      kind: 'status',
      label: 'Booting micro-VM',
      text: 'Starting WebVM and mounting persistent workspace',
    });

    try {
      const vm = await WebVmBackend.create({
        tailscaleAuthKey: tailscaleAuthKey.trim() || undefined,
        onConsole: appendTerminal,
        onDebug: appendDebug,
        onStatus: (status) => {
          setVmStatus(status);
          if (status.loginUrl) {
            appendEvent({
              kind: 'thought',
              text: `Tailscale login URL ready: ${status.loginUrl}`,
            });
          }
          if (
            status.previewUrl &&
            tailnetReadyLoggedRef.current !== status.previewUrl
          ) {
            tailnetReadyLoggedRef.current = status.previewUrl;
            appendEvent({
              kind: 'status',
              label: 'Tailnet ready',
              text: `Tailnet IP ready: ${
                status.tailnetIp ?? status.previewUrl
              }. Waiting for server health before opening.`,
            });
          }
        },
      });
      await vm.resetWorkspace();
      setBackend(vm);
      await loadFiles(vm);
      return vm;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setVmStatus({
        lifecycle: 'error',
        message,
        tailnetIp: null,
        loginUrl: null,
        previewUrl: null,
        serverPort: null,
      });
      appendEvent({ kind: 'error', text: message });
      throw error;
    }
  };

  const send = async () => {
    const trimmedDraft = draft.trim();
    if (!trimmedDraft) return;
    const buildPrompt = resolveBuildPrompt(
      trimmedDraft,
      events,
      activeProject.prompt,
    );

    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      setErrorMessage('Google AI key is required before building.');
      return;
    }
    setErrorMessage(null);

    setHasStarted(true);
    setBuilding(true);
    setReady(false);
    setTerminal('');
    setDebugLog('');
    tailnetReadyLoggedRef.current = null;
    buildAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    buildAbortControllerRef.current = abortController;
    appendEvent({ kind: 'chat', text: buildPrompt });
    if (buildPrompt !== trimmedDraft) {
      appendEvent({
        kind: 'status',
        label: 'Retry',
        text: `Retrying previous brief instead of treating "${trimmedDraft}" as a new website.`,
      });
    }
    setDraft('');

    try {
      const vm = await bootVm();
      if (
        activeProject.files.length > 0 &&
        restoredProjectIdRef.current !== activeProject.id
      ) {
        await restoreProjectFiles(vm, activeProject);
      }

      // Tailnet activation is deferred until after agent writes complete.
      // On some machines, activating CheerpX's userspace Tailscale flips the
      // workspace IDB mount to read-only, which would break every cp from
      // the agent. We let writes finish on a clean (no-Tailnet) workspace,
      // then startServer() activates Tailnet right before launching python.

      appendEvent({
        kind: 'status',
        label: 'Gemini',
        text: `Building with ${model}`,
      });

      let agentFinalText = '';
      const result = await runWebsiteAgent({
        apiKey: trimmedApiKey,
        prompt: buildPrompt,
        backend: vm,
        abortSignal: abortController.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'model') {
            return;
          }
          if (event.type === 'done') {
            agentFinalText = event.message;
            return;
          }
          const logEvent = eventFromAgentEvent(event);
          if (logEvent) {
            appendEvent(logEvent);
          }
        },
      });

      const startResult = await vm.startServer();
      if (startResult.status !== 0) {
        await loadFiles(vm);
        const sourceFiles = await collectSourceFiles(vm);
        saveActiveProject({
          prompt: buildPrompt,
          previewUrl: null,
          files: sourceFiles,
        });
        appendEvent({
          kind: 'error',
          label: 'Server start failed',
          text:
            cleanStatusOutput(startResult.output) ||
            `Server command exited with ${startResult.status}`,
        });
        return;
      }
      const health = await vm.checkServer();
      const serverHealthy = health.status === 0;
      appendEvent({
        kind: serverHealthy ? 'status' : 'error',
        label: serverHealthy ? 'Server health' : 'Server failed',
        text:
          cleanStatusOutput(health.output) ||
          `Health check exited with ${health.status}`,
      });

      let url = vm.getPreviewUrl();
      if (!url) {
        appendEvent({
          kind: 'status',
          label: 'Tailnet',
          text: 'Waiting for the VM Tailnet IP before marking the site live.',
        });
        url = await waitForPreviewUrl(vm, 45_000);
      }
      if (url && serverHealthy) {
        const previewHealth = await checkPreviewFromBrowser(url);
        const previewReachable = previewHealth.status === 0;
        appendEvent({
          kind: 'status',
          label: previewReachable ? 'Tailnet health' : 'Tailnet check',
          text:
            cleanStatusOutput(previewHealth.output) ||
            `Browser preview check exited with ${previewHealth.status}`,
        });
      }
      await loadFiles(vm);
      const sourceFiles = await collectSourceFiles(vm);
      if (sourceDirectory) {
        await syncSourceToFolder(vm, sourceDirectory);
      }

      const finalText = formatFinalSummary(
        result.finalText || agentFinalText || 'Website generation finished.',
        url,
      );
      if (url && serverHealthy) {
        appendEvent({
          kind: 'ready',
          text: `**Site is live:** ${url}\n\n${finalText}`,
        });
        setReady(true);
      } else {
        appendEvent({
          kind: 'error',
          label: !serverHealthy ? 'Server unavailable' : 'Tailnet unavailable',
          text: !serverHealthy
            ? `Files were generated, but the VM web server did not start.\n\n${finalText}`
            : `Files are built but no Tailnet preview URL is available yet.\n\n${finalText}`,
        });
      }

      saveActiveProject({
        prompt: buildPrompt,
        previewUrl: url,
        files: sourceFiles,
      });

      if (result.reachedTurnBudget) {
        appendEvent({
          kind: 'status',
          label: 'Turn budget reached',
          text: 'Agent hit the turn budget. Send a new prompt to keep iterating.',
        });
      }

    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        return;
      }
      appendEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (buildAbortControllerRef.current === abortController) {
        buildAbortControllerRef.current = null;
      }
      setBuilding(false);
    }
  };

  const cancelBuild = () => {
    buildAbortControllerRef.current?.abort();
    buildAbortControllerRef.current = null;
    setBuilding(false);
    appendEvent({
      kind: 'status',
      label: 'Stopped',
      text: 'Stopped. Send another prompt to resume.',
    });
  };

  const retryTailnet = async () => {
    if (!backend) {
      appendEvent({
        kind: 'error',
        label: 'Retry Tailnet',
        text: 'No VM is running yet. Start a build first.',
      });
      return;
    }

    setBuilding(true);
    setReady(false);
    setErrorMessage(null);
    try {
      appendEvent({
        kind: 'status',
        label: 'Retry Tailnet',
        text: 'Restarting the browser-side Tailnet login and waiting for a VM address.',
      });
      const loginUrl = await backend.connectTailnet({
        timeoutMs: 60_000,
        forceLogin: true,
      });
      if (loginUrl) {
        window.open(loginUrl, '_blank', 'noopener,noreferrer');
        appendEvent({
          kind: 'status',
          label: 'Retry Tailnet',
          text: 'Opened Tailscale login. Waiting for the VM Tailnet address.',
        });
        await backend.connectTailnet({ timeoutMs: 60_000 });
      }

      if (!backend.getTailnetIp()) {
        appendEvent({
          kind: 'error',
          label: 'Tailnet unavailable',
          text: 'Tailnet still has not provided a VM IP. The generated files are still saved; try again once the Tailnet device appears.',
        });
        return;
      }

      appendEvent({
        kind: 'status',
        label: 'Tailnet ready',
        text: `Tailnet IP ready: ${backend.getTailnetIp()}. Starting the VM web server.`,
      });

      const startResult = await backend.startServer();
      if (startResult.status !== 0) {
        appendEvent({
          kind: 'error',
          label: 'Server start failed',
          text:
            cleanStatusOutput(startResult.output) ||
            `Server command exited with ${startResult.status}`,
        });
        return;
      }

      const health = await backend.checkServer();
      const serverHealthy = health.status === 0;
      appendEvent({
        kind: serverHealthy ? 'status' : 'error',
        label: serverHealthy ? 'Server health' : 'Server failed',
        text:
          cleanStatusOutput(health.output) ||
          `Health check exited with ${health.status}`,
      });
      if (!serverHealthy) {
        return;
      }

      const url = backend.getPreviewUrl() ?? (await waitForPreviewUrl(backend, 20_000));
      if (!url) {
        appendEvent({
          kind: 'error',
          label: 'Tailnet unavailable',
          text: 'The server is healthy internally, but no Tailnet preview URL is available yet.',
        });
        return;
      }

      const previewHealth = await checkPreviewFromBrowser(url);
      appendEvent({
        kind: 'status',
        label: previewHealth.status === 0 ? 'Tailnet health' : 'Tailnet check',
        text:
          cleanStatusOutput(previewHealth.output) ||
          `Browser preview check exited with ${previewHealth.status}`,
      });

      await loadFiles(backend);
      const sourceFiles = await collectSourceFiles(backend);
      saveActiveProject({
        previewUrl: url,
        files: sourceFiles,
      });
      appendEvent({
        kind: 'ready',
        text: `**Site is live:** ${url}`,
      });
      setReady(true);
    } catch (error) {
      appendEvent({
        kind: 'error',
        label: 'Retry Tailnet',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBuilding(false);
    }
  };

  const openTerminal = () => {
    setShowTerminal(true);
    if (!backend) {
      return;
    }
    const result = backend.startInteractiveShell();
    const output = cleanStatusOutput(result.output);
    if (result.status !== 0 && output) {
      appendTerminal(`${output}\n`);
    }
  };

  const sendTerminalInput = (commandOverride?: string) => {
    const command = (commandOverride ?? terminalCommand).trim();
    if (!command) return;
    setTerminalCommand('');
    setShowTerminal(true);

    if (!backend) {
      appendTerminal('No VM is running.\n');
      return;
    }

    const result = backend.writeTerminalInput(`${command}\n`);
    const output = cleanStatusOutput(result.output);
    if (output) {
      appendTerminal(`${output}\n`);
    }
    if (result.status !== 0) {
      appendTerminal(`[exit ${result.status}]\n`);
    }
  };

  const openWebsite = () => {
    if (!previewUrl) return;
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  };

  const continueToChat = () => {
    setHasOpenedBefore(true);
    setDraft((current) => current || activeProject.prompt || DEFAULT_PROMPT);
    setScreen('chat');
  };

  const goToSetup = () => {
    setScreen('setup');
  };

  const subtitleTone: 'live' | 'run' | 'idle' = ready
    ? 'live'
    : building
      ? 'run'
      : 'idle';

  const subtitle =
    screen === 'setup'
      ? 'browser-built website prototype'
      : ready
        ? `live · ${hostFromPreviewUrl(previewUrl) ?? `${vmStatus.tailnetIp ?? '—'}:${activeServerPort ?? 'auto'}`}`
        : building
          ? 'vm building…'
          : `ready · ${model}`;

  const title = screen === 'setup' ? 'SparkRun' : activeProject.name || 'Untitled';

  return (
    <>
      <AppBar
        title={title}
        subtitle={subtitle}
        subtitleTone={subtitleTone}
        onBack={
          screen === 'chat'
            ? undefined
            : hasOpenedBefore
              ? () => setScreen('chat')
              : undefined
        }
        right={
          screen === 'chat' ? (
            <button
              aria-label="Setup"
              className="icon-btn"
              onClick={goToSetup}
              type="button"
            >
              <Settings size={17} />
            </button>
          ) : null
        }
      />
      {screen === 'setup' ? (
        <SetupScreen
          cfg={{
            apiKey,
            tailKey: tailscaleAuthKey,
            projectName: activeProject.name,
            model,
            remember: rememberKeys,
          }}
          onApiKey={updateApiKey}
          onTailKey={updateTailscaleAuthKey}
          onProjectName={updateProjectName}
          onProjectNameBlur={finalizeProjectName}
          onModel={setModel}
          onRemember={updateRememberKeys}
          hasOpenedBefore={hasOpenedBefore}
          onContinue={continueToChat}
          projects={projects}
          activeProject={activeProject}
          onSelectProject={(project) => void selectProject(project)}
          onDeleteProject={removeProject}
          onNewProject={newProject}
          onSaveProject={() => saveActiveProject({ prompt: draft })}
          sourceDirectoryName={sourceDirectoryName}
          hasSourceDirectory={Boolean(sourceDirectory)}
          localFolderSupported={localFolderSupported}
          onAttachFolder={() => void attachSourceFolder()}
          onDetachFolder={() => void detachSourceFolder()}
        />
      ) : (
        <ChatScreen
          cfg={{ model, projectName: activeProject.name }}
          events={events}
          files={files}
          building={building}
          ready={ready}
          tailnetIp={vmStatus.tailnetIp ?? null}
          previewUrl={previewUrl}
          serverPort={activeServerPort}
          vmStatus={vmStatus}
          hasStarted={hasStarted}
          draft={draft}
          onDraft={setDraft}
          onSend={() => void send()}
          onCancel={cancelBuild}
          onOpenWebsite={openWebsite}
          onRetryTailnet={() => void retryTailnet()}
          onFiles={() => setShowFiles(true)}
          onLogs={() => setShowLogs(true)}
          onTerminal={openTerminal}
          errorMessage={errorMessage}
        />
      )}
      <FileDrawer
        open={showFiles}
        onClose={() => setShowFiles(false)}
        files={files}
      />
      <LogDrawer
        open={showLogs}
        onClose={() => setShowLogs(false)}
        text={debugLog}
      />
      <TerminalDrawer
        open={showTerminal}
        onClose={() => setShowTerminal(false)}
        text={terminal}
        input={terminalCommand}
        disabled={!backend}
        onInput={setTerminalCommand}
        onSendInput={sendTerminalInput}
      />
    </>
  );
}
