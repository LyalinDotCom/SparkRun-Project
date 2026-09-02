import { useEffect, useMemo, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Activity,
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
  History,
  KeyRound,
  LayoutDashboard,
  Maximize2,
  Minimize2,
  MessageSquarePlus,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RotateCcw,
  Save,
  Send,
  Server,
  Settings,
  Sparkles,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type {
  CodingHarnessEvent,
  CodingHarnessSession,
} from './lib/codingHarness';
import {
  CODING_LIST_DIRECTORY_TOOL,
  CODING_READ_FILE_TOOL,
  redactCodingSecrets,
} from './lib/codingHarnessTools';
import {
  ACTIVE_PROJECT_SETTING_KEY,
  createVaultProjectDraft,
  getBrowserVault,
  projectSourceDirectorySettingKey,
  requestDurableBrowserStorage,
  type StorageDurability,
  type VaultCheckpoint,
  type VaultConversation,
  type VaultConversationEvent,
  type VaultProject,
} from './lib/browserVault';
import {
  DEFAULT_WEBVM_DISK_PROFILE,
  ENABLED_MODELS,
  MODEL_ID,
  SITE_ROOT,
} from './lib/constants';
import {
  ensureDirectoryWritePermission,
  isLocalFolderSupported,
  pickSourceDirectory,
  writeSourceFiles,
  type SourceFile,
} from './lib/localFolder';
import {
  CHEERPX_PINNED_VERSION,
  detectCheerpxRuntimeVersion,
  getFatalTailnetRuntimeFailure,
  hardResetSparkrunCaches,
  SPARKRUN_BUILD_SHA,
  SPARKRUN_BUILD_TIME,
  validateGoogleApiKey,
  validateTailscaleAuthKey,
  WebVmBackend,
  type WebVmDebugEntry,
  type WebVmStatus,
} from './lib/webvm';
import type { DirectoryEntry, VmFileBackend } from './lib/vmFileContract';
import type { WorkspaceRuntime } from './lib/workspaceRuntime';
import {
  acquireWorkspaceLease,
  type WorkspaceLease,
} from './lib/workspaceLease';
import '@xterm/xterm/css/xterm.css';

type Screen = 'setup' | 'chat';
type WorkspaceSurface = 'preview' | 'files' | 'activity';
type ActiveOperation = 'coding' | 'tailnet';

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

const VAULT_HEAD_MARKER = '.sparkrun-vault-head';
const ONBOARDING_COMPLETE_SETTING_KEY = 'onboarding-complete-v1';

// Keep full-page recovery behind a tiny testable boundary. CheerpX's network
// runtime is page-global, so a fatal tcp_input/tcp_bind failure cannot be
// repaired by constructing another VM inside the same document.
export const browserPageLifecycle = {
  reload: () => window.location.reload(),
};

function rootCacheDatabaseName(environmentId: string): string {
  return `sparkrun-env-v2-${environmentId}-cheerpx-${CHEERPX_PINNED_VERSION}-${DEFAULT_WEBVM_DISK_PROFILE.id}`;
}

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

const INITIAL_STORAGE_DURABILITY: StorageDurability = {
  persisted: false,
  usageBytes: null,
  quotaBytes: null,
};

function conversationRoleForEvent(
  event: Omit<LogEvent, 'id' | 'time'>,
): VaultConversationEvent['role'] {
  if (event.kind === 'chat') return 'user';
  if (event.kind === 'cmd' || event.kind === 'stream') return 'tool';
  if (event.kind === 'thought' || event.kind === 'ready') return 'assistant';
  return 'system';
}

function logEventFromVault(event: VaultConversationEvent): LogEvent | null {
  if (!event.payload || typeof event.payload !== 'object') return null;
  const payload = event.payload as Partial<LogEvent>;
  if (
    typeof payload.kind !== 'string' ||
    !['chat', 'thought', 'status', 'cmd', 'stream', 'ready', 'error'].includes(
      payload.kind,
    )
  ) {
    return null;
  }
  return {
    id: typeof payload.id === 'number' ? payload.id : makeId(),
    kind: payload.kind as EventKind,
    label: typeof payload.label === 'string' ? payload.label : undefined,
    text: typeof payload.text === 'string' ? payload.text : undefined,
    cmd: typeof payload.cmd === 'string' ? payload.cmd : undefined,
    lines: Array.isArray(payload.lines)
      ? payload.lines.filter((line): line is string => typeof line === 'string')
      : undefined,
    toolCategory:
      payload.toolCategory === 'edit' ||
      payload.toolCategory === 'shell' ||
      payload.toolCategory === 'inspect'
        ? payload.toolCategory
        : undefined,
    tone:
      payload.tone === 'normal' || payload.tone === 'error'
        ? payload.tone
        : undefined,
    time:
      typeof payload.time === 'string'
        ? payload.time
        : new Date(event.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          }),
  };
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

function normalizeProjectName(name: string): string {
  return name.trim() || 'Untitled site';
}

const INITIAL_STATUS: WebVmStatus = {
  lifecycle: 'idle',
  message: 'VM not started',
  tailnetIp: null,
  loginUrl: null,
  previewUrl: null,
  serverPort: null,
};

const MODELS = ENABLED_MODELS;

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

const HIDDEN_WORKSPACE_TREES = new Set([
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'cache',
  'out',
  'coverage',
  'target',
  'vendor',
  '__pycache__',
  'venv',
]);
const MAX_WORKSPACE_SCAN_DEPTH = 64;
const MAX_WORKSPACE_SCAN_ENTRIES = 20_000;

function isVisibleWorkspacePath(path: string): boolean {
  return !path
    .split('/')
    .some((part) => part.startsWith('.') || HIDDEN_WORKSPACE_TREES.has(part));
}

function isSourceFile(entry: DirectoryEntry): boolean {
  if (entry.type !== 'file') {
    return false;
  }
  return isVisibleWorkspacePath(entry.path);
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

let lastEventId = 0;

function makeId(): number {
  // Strictly monotonic so event ids never collide, even for tool events that
  // arrive within the same millisecond. Date.now() + random could repeat and
  // produce duplicate React keys, which drops/misrenders timeline rows.
  lastEventId = Math.max(lastEventId + 1, Date.now());
  return lastEventId;
}

const BENIGN_TERMINAL_LINES = new Set([
  'mesg: ttyname failed: Success',
  'sg: ttyname failed: Success',
]);

const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const LOCAL_PREVIEW_URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?/gi;

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error('Operation was stopped.');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  if (/^(run_shell_command|run_command|start_preview|Started|Ran|Preview)\b/i.test(text)) {
    return 'shell';
  }
  if (/^(write_file|replace)\s+failed:/i.test(text)) {
    return 'edit';
  }
  if (/^(read_file|list_directory)\s+failed:/i.test(text)) {
    return 'inspect';
  }
  if (/^(?:run_shell_command|run_command|start_preview)\s+failed:/i.test(text)) {
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
    .replace(/^run_command\s+/i, '$ ')
    .replace(/^start_preview\s+/i, 'preview ')
    .replace(/^Wrote\s+/i, 'wrote ')
    .replace(/^Edited\s+/i, 'edited ')
    .replace(/^Created\s+/i, 'created ')
    .replace(/^Read\s+/i, 'read ')
    .replace(/^Listed\s+/i, 'listed ')
    .replace(/^Started\s+/i, 'started ')
    .replace(/^Ran\s+/i, '$ ')
    .replace(/^run_shell_command failed:\s*/i, 'failed: ')
    .replace(/^run_command failed:\s*/i, 'failed: ')
    .replace(/^start_preview failed:\s*/i, 'preview failed: ')
    .replace(/^write_file failed:\s*/i, 'failed: ')
    .replace(/^replace failed:\s*/i, 'failed: ')
    .replace(/^read_file failed:\s*/i, 'failed: ')
    .replace(/^list_directory failed:\s*/i, 'failed: ');
}

function eventFromAgentEvent(
  event: CodingHarnessEvent,
): Omit<LogEvent, 'id' | 'time'> | null {
  if (event.type === 'model' || event.type === 'done') {
    return null;
  }

  if (event.type === 'status') {
    return {
      kind: 'status',
      label: /\bretry(?:ing)?\b/i.test(event.message)
        ? 'Gemini retry'
        : 'Gemini',
      text: event.message,
    };
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
  // This formatter preserves structure only. appendDebug() applies the
  // mandatory secret-redaction boundary to the complete accumulated string
  // before it can reach React state or the Diagnostics panel.
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
  signal?: AbortSignal,
): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    const url = vm.getPreviewUrl?.() ?? null;
    if (url) {
      return url;
    }
    await sleep(750, signal);
  }
  if (signal?.aborted) {
    throw abortReason(signal);
  }
  return vm.getPreviewUrl?.() ?? null;
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
  inert?: boolean;
}

function AppBar({
  title,
  subtitle,
  subtitleTone,
  onBack,
  right,
  inert,
}: AppBarProps) {
  return (
    <header className="appbar" inert={inert ? true : undefined}>
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
        <div className="appbar-product" aria-label="SparkRun">
          <strong>SparkRun</strong>
          <span>Browser coding lab</span>
        </div>
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
  projects: VaultProject[];
  activeProject: VaultProject;
  onSelectProject: (project: VaultProject) => void;
  onDeleteProject: (id: string) => void;
  onNewProject: () => void;
  onSaveProject: () => void;
  sourceDirectoryName: string;
  hasSourceDirectory: boolean;
  localFolderSupported: boolean;
  onAttachFolder: () => void;
  onDetachFolder: () => void;
  onResetWorkspace: (includeDiskCache: boolean) => Promise<void>;
}

function KeyValidationStatus({
  id,
  value,
  validate,
}: {
  id: string;
  value: string;
  validate: (input: string) => string | null;
}) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    // Both key inputs reference this id with aria-describedby. Keep a useful
    // (visually hidden) description mounted even before the user types so the
    // accessibility relationship never points at a missing node.
    return <span className="sr-only" id={id}>No key entered.</span>;
  }
  const error = validate(value);
  if (error) {
    return (
      <p className="field-status is-invalid" id={id}>
        <TriangleAlert size={12} aria-hidden="true" /> {error}
      </p>
    );
  }
  return (
    <p className="field-status is-valid" id={id}>
      <CheckCircle2 size={12} aria-hidden="true" /> Format accepted — not connected yet.
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
      ? 'Reset this project’s VM workspace and the shared cached Linux environment, then reload? Ad-hoc installed tools will be lost, the configured image will reload, and the latest vault checkpoint remains available.'
      : 'Reset this project’s VM workspace and reload? SparkRun will recover the latest committed vault checkpoint.';
    if (!window.confirm(message)) return;
    setResetting(true);
    try {
      await props.onResetWorkspace(includeDiskCache);
    } catch (error) {
      window.alert(
        `Failed to reset caches: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      setResetting(false);
    }
  };

  const googleKeyError = validateGoogleApiKey(props.cfg.apiKey);
  const ready =
    props.hasOpenedBefore ||
    (props.cfg.projectName.trim().length > 0 && googleKeyError === null);

  return (
    <main className="screen setup-screen">
      {!props.hasOpenedBefore ? (
      <section className="setup-hero" aria-labelledby="setup-title">
        <div className="setup-hero-copy">
          <h2 className="display" id="setup-title">
            A Linux workspace,{' '}
            <span className="gemini-grad">in your browser.</span>
          </h2>
          <p className="lede">
            Gemini codes in a private Linux VM and previews the result on your
            tailnet. Name the project, paste a key, go.
          </p>
        </div>
      </section>
      ) : (
        <section className="setup-returning" aria-labelledby="setup-title">
          <h2 id="setup-title">Workspace settings</h2>
          <p>
            Projects, conversations, and checkpoints stay in the Browser
            Vault.
          </p>
        </section>
      )}

      <div className="setup-core-grid">
      <section className="setup-core-column" aria-label="Workspace identity">
      <div className="setup-section-heading">
        <span>Workspace identity</span>
        <small>Stored in this browser</small>
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
          <span className="field-label" id="setup-model-label">
            <Cpu size={13} aria-hidden="true" /> Model
          </span>
          <div className="model-grid">
            {MODELS.map((m) => (
              <button
                aria-pressed={props.cfg.model === m.id}
                aria-describedby="setup-model-label"
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
      </section>

      <section className="setup-core-column" aria-label="Connections">
      <div className="setup-section-heading">
        <span>Connections</span>
        <small>Sent only to the services they authenticate</small>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="field">
          <label className="field-label" htmlFor="setup-google-key">
            <KeyRound size={13} aria-hidden="true" /> Google AI key
            <small className="field-requirement required">Required</small>
          </label>
          <div className="input-wrap">
            <input
              id="setup-google-key"
              aria-describedby="setup-google-key-status setup-google-key-hint"
              aria-invalid={Boolean(
                props.cfg.apiKey.trim() && googleKeyError,
              )}
              className={`text-input has-suffix ${
                props.cfg.apiKey.trim().length === 0
                  ? ''
                  : validateGoogleApiKey(props.cfg.apiKey)
                    ? 'is-invalid'
                    : 'is-valid'
              }`}
              autoComplete="off"
              onChange={(event) => props.onApiKey(event.target.value)}
              placeholder="Paste Google AI key"
              required
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
            id="setup-google-key-status"
            value={props.cfg.apiKey}
            validate={validateGoogleApiKey}
          />
          <p className="field-hint" id="setup-google-key-hint">
            <a
              className="field-link"
              href="https://aistudio.google.com/api-keys"
              rel="noreferrer"
              target="_blank"
            >
              Create one in AI Studio
            </a>
          </p>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="setup-tail-key">
            <Cable size={13} aria-hidden="true" /> Tailscale auth key
            <small className="field-requirement">Optional for private preview</small>
          </label>
          <div className="input-wrap">
            <input
              id="setup-tail-key"
              aria-describedby="setup-tail-key-status setup-tail-key-hint"
              aria-invalid={Boolean(
                props.cfg.tailKey.trim() &&
                  validateTailscaleAuthKey(props.cfg.tailKey),
              )}
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
            id="setup-tail-key-status"
            value={props.cfg.tailKey}
            validate={validateTailscaleAuthKey}
          />
          <p className="field-hint" id="setup-tail-key-hint">
            A reusable, ephemeral, pre-approved <strong>device auth key</strong> —
            not an API access token.{' '}
            <a
              className="field-link"
              href="https://login.tailscale.com/admin/settings/keys"
              rel="noreferrer"
              target="_blank"
            >
              Create a key
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
      </section>
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
        {!ready && !props.hasOpenedBefore ? (
          <p className="setup-continue-hint">
            Enter a project name and a format-valid Google AI key to continue.
          </p>
        ) : null}
      </div>

      <details className="setup-advanced">
        <summary>
          <span>
            <Settings size={14} aria-hidden="true" /> Advanced &amp; recovery
          </span>
          <small>Projects, source folder, diagnostics, and reset controls</small>
        </summary>
        <div className="setup-advanced-body">

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
                  Browser vault · {new Date(project.updatedAt).toLocaleDateString()}
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
            {resetting ? 'Resetting…' : 'Reset VM caches'}
          </button>
        </div>
        <p className="field-hint" style={{ marginTop: 10 }}>
          Pinned is the version npm installed. Loaded is parsed from the actual{' '}
          <code>cxrtnc.leaningtech.com/&lt;version&gt;/</code> URL the browser
          fetched. Click Verify to fetch CheerpX and confirm — or boot the VM
          and they'll match in the Logs.
        </p>
        <p className="field-hint" style={{ marginTop: 6 }}>
          <strong>Reset workspace</strong> wipes this project’s live VM cache
          and reloads from its latest browser-vault checkpoint.{' '}
          <strong>Reset VM caches</strong> also wipes this project’s cached
          Linux environment image, so the next boot is slower.
        </p>
      </div>

      <div className="warn-strip setup-privacy-note">
        <TriangleAlert size={15} aria-hidden="true" />
        <div>
          Keys stay in browser memory unless you explicitly enable saving;
          saved keys use this origin&rsquo;s local
          browser storage. Never use credentials you would not trust to this
          device profile.
        </div>
      </div>
        </div>
      </details>
    </main>
  );
}

interface ChatScreenProps {
  cfg: { model: string; projectName: string };
  onModel: (model: string) => void;
  events: LogEvent[];
  files: DirectoryEntry[];
  building: boolean;
  networkRetrying: boolean;
  stopping: boolean;
  stoppingOperation: ActiveOperation | null;
  ready: boolean;
  fatalNetworkFailure: string | null;
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
  onCloseTerminal: () => void;
  onStartVm: () => void;
  terminalOpen: boolean;
  terminalDockHeight: number;
  onTerminalDockHeight: (height: number) => void;
  terminalText: string;
  terminalInput: string;
  terminalAvailable: boolean;
  terminalDisabled: boolean;
  onTerminalInput: (value: string) => void;
  onSendTerminalInput: (inputOverride?: string) => void;
  onRawTerminalInput: (value: string) => void;
  onReadFile: (path: string) => Promise<string>;
  debugLog: string;
  errorMessage: string | null;
}

interface WorkbenchShellProps {
  activeProject: VaultProject;
  projects: VaultProject[];
  conversations: VaultConversation[];
  activeConversationId: string | null;
  storage: StorageDurability;
  checkpointState: 'idle' | 'saving' | 'saved' | 'error';
  vmStatus: WebVmStatus;
  building: boolean;
  fatalNetworkFailure: string | null;
  onNewProject: () => void;
  onSelectProject: (project: VaultProject) => void;
  onNewConversation: () => void;
  onSelectConversation: (conversation: VaultConversation) => void;
  onSnapshot: () => void;
  onRestartVm: () => void;
  onRailModalChange: (open: boolean) => void;
  children: React.ReactNode;
}

function WorkbenchShell({
  activeProject,
  projects,
  conversations,
  activeConversationId,
  storage,
  checkpointState,
  vmStatus,
  building,
  fatalNetworkFailure,
  onNewProject,
  onSelectProject,
  onNewConversation,
  onSelectConversation,
  onSnapshot,
  onRestartVm,
  onRailModalChange,
  children,
}: WorkbenchShellProps) {
  const [railOpen, setRailOpen] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 900px)').matches
      : true,
  );
  const [railIsModal, setRailIsModal] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 760px)').matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 760px)');
    const reconcile = (event: MediaQueryListEvent) =>
      setRailIsModal(event.matches);
    media.addEventListener?.('change', reconcile);
    return () => media.removeEventListener?.('change', reconcile);
  }, []);
  const railModalOpen = railOpen && railIsModal;
  useEffect(() => {
    onRailModalChange(railModalOpen);
    return () => onRailModalChange(false);
  }, [onRailModalChange, railModalOpen]);
  const railDialogRef = useDrawerDialog<HTMLElement>(
    railModalOpen,
    () => setRailOpen(false),
  );
  const usageLabel =
    storage.usageBytes !== null && storage.quotaBytes
      ? `${formatBytes(storage.usageBytes)} / ${formatBytes(storage.quotaBytes)}`
      : 'measuring storage';
  const visibleProjects = projects.some(
    (project) => project.id === activeProject.id,
  )
    ? projects
    : [activeProject, ...projects];
  return (
    <div className={`workbench-shell ${railOpen ? '' : 'rail-collapsed'}`}>
      <div className="workbench-sidebar">
        <button
          aria-controls="workbench-navigation"
          aria-expanded={railOpen}
          aria-label={railOpen ? 'Collapse project rail' : 'Expand project rail'}
          className="workbench-rail-toggle"
          inert={railModalOpen ? true : undefined}
          onClick={() => setRailOpen((current) => !current)}
          type="button"
        >
          {railOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <aside
          aria-label="Workspace navigation"
          aria-modal={railModalOpen ? true : undefined}
          className="workbench-rail"
          hidden={!railOpen}
          id="workbench-navigation"
          ref={railIsModal ? railDialogRef : undefined}
          role={railIsModal ? 'dialog' : undefined}
          tabIndex={railIsModal ? -1 : undefined}
        >
        <button
          aria-label="Close project rail"
          className="rail-mobile-close"
          data-dialog-initial-focus=""
          onClick={() => setRailOpen(false)}
          type="button"
        >
          <PanelLeftClose size={15} />
        </button>
        <div className="rail-project">
          <span className="rail-project-icon" aria-hidden="true">
            <LayoutDashboard size={15} />
          </span>
          <div>
            <span>Active workspace</span>
            <strong>{activeProject.name}</strong>
          </div>
        </div>

        <div className="rail-section-head">
          <span>Projects</span>
          <button
            aria-label="New project"
            className="rail-icon-button"
            onClick={onNewProject}
            type="button"
          >
            <MessageSquarePlus size={15} />
          </button>
        </div>
        <div className="rail-project-list">
          {visibleProjects.map((project) => (
              <button
                aria-current={project.id === activeProject.id ? 'page' : undefined}
                className={`rail-project-item ${
                  project.id === activeProject.id ? 'active' : ''
                }`}
                key={project.id}
                onClick={() => onSelectProject(project)}
                type="button"
              >
                <LayoutDashboard size={13} aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
        </div>

        <div className="rail-section-head">
          <span>Conversations</span>
          <button
            aria-label="New conversation"
            className="rail-icon-button"
            disabled={building}
            onClick={onNewConversation}
            type="button"
          >
            <MessageSquarePlus size={15} />
          </button>
        </div>
        <div className="conversation-list">
          {conversations.length === 0 ? (
            <button
              className="conversation-empty"
              disabled={building}
              onClick={onNewConversation}
              type="button"
            >
              <MessageSquarePlus size={14} /> Start a conversation
            </button>
          ) : (
            conversations.map((conversation) => (
              <button
                aria-current={
                  conversation.id === activeConversationId ? 'page' : undefined
                }
                className={`conversation-item ${
                  conversation.id === activeConversationId ? 'active' : ''
                }`}
                disabled={building}
                key={conversation.id}
                onClick={() => onSelectConversation(conversation)}
                type="button"
              >
                <History size={13} aria-hidden="true" />
                <span>
                  <strong>{conversation.title}</strong>
                  <small>
                    {new Date(conversation.updatedAt).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </small>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="rail-spacer" />
        <div className="rail-actions">
          <button
            disabled={building || checkpointState === 'saving'}
            onClick={onSnapshot}
            type="button"
          >
            <Save size={13} />
            {checkpointState === 'saving'
              ? 'Saving…'
              : checkpointState === 'saved'
                ? 'Snapshot saved'
                : checkpointState === 'error'
                  ? 'Snapshot failed'
                  : 'Snapshot now'}
          </button>
          <button
            disabled={building && !fatalNetworkFailure}
            onClick={onRestartVm}
            type="button"
          >
            <RotateCcw size={13} /> Restart VM
          </button>
        </div>
        <div className="rail-storage">
          <span className={storage.persisted ? 'ok' : ''}>
            <HardDrive size={12} />
            {storage.persisted ? 'Durable browser vault' : 'Browser vault'}
          </span>
          <small>{usageLabel}</small>
          <small>{lifecycleLabel(vmStatus)}</small>
        </div>
        </aside>
      </div>
      {railModalOpen ? (
        <button
          aria-hidden="true"
          aria-label="Close project rail"
          className="workspace-panel-scrim rail"
          onClick={() => setRailOpen(false)}
          tabIndex={-1}
          type="button"
        />
      ) : null}
      <section
        className="workbench-main"
        inert={railModalOpen ? true : undefined}
      >
        {children}
      </section>
    </div>
  );
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

interface WorkspaceStageProps {
  files: DirectoryEntry[];
  previewUrl: string | null;
  ready: boolean;
  building: boolean;
  networkRetrying: boolean;
  vmStatus: WebVmStatus;
  debugLog: string;
  onOpenPreview: () => void;
  onOpenFiles: () => void;
  onOpenActivity: () => void;
  onClose: () => void;
  onReadFile: (path: string) => Promise<string>;
}

function WorkspaceFilePreview({
  path,
  onReadFile,
  className,
  refreshToken,
}: {
  path: string | null;
  onReadFile: (path: string) => Promise<string>;
  className: string;
  refreshToken: unknown;
}) {
  const [content, setContent] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const onReadFileRef = useRef(onReadFile);
  onReadFileRef.current = onReadFile;

  useEffect(() => {
    if (!path) {
      setContent('');
      setState('idle');
      return;
    }
    let cancelled = false;
    setState('loading');
    setContent('');
    void onReadFileRef.current(path)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setState('ready');
      })
      .catch((error) => {
        if (cancelled) return;
        setContent(error instanceof Error ? error.message : String(error));
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshToken]);

  return (
    <div className={className} aria-live="polite">
      {state === 'loading' ? (
        <div className="file-preview-state">
          <span className="spin tiny" /> Reading {path}…
        </div>
      ) : state === 'error' ? (
        <div className="file-preview-state error">{content}</div>
      ) : state === 'ready' ? (
        <pre aria-label={`${path} contents`} tabIndex={0}>{content || 'Empty file'}</pre>
      ) : null}
    </div>
  );
}

function WorkspaceStage({
  files,
  previewUrl,
  ready,
  building,
  networkRetrying,
  vmStatus,
  debugLog,
  onOpenPreview,
  onOpenFiles,
  onOpenActivity,
  onClose,
  onReadFile,
}: WorkspaceStageProps) {
  const [surface, setSurface] = useState<WorkspaceSurface>('preview');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const sourceFiles = useMemo(() => files.filter(isSourceFile), [files]);
  const activityLines = useMemo(
    () => (debugLog ? debugLog.split('\n').slice(-220) : []),
    [debugLog],
  );
  const surfaceOrder: WorkspaceSurface[] = ['preview', 'files', 'activity'];
  const canEmbedPreview = useMemo(() => {
    if (!previewUrl) return false;
    try {
      const previewProtocol = new URL(previewUrl).protocol;
      return !(
        window.location.protocol === 'https:' && previewProtocol === 'http:'
      );
    } catch {
      return false;
    }
  }, [previewUrl]);

  useEffect(() => {
    setSelectedFile((current) =>
      current && sourceFiles.some((file) => file.path === current)
        ? current
        : sourceFiles[0]?.path ?? null,
    );
  }, [sourceFiles]);

  const selectSurface = (next: WorkspaceSurface) => {
    setSurface(next);
  };

  const moveSurfaceFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceSurface,
  ) => {
    const currentIndex = surfaceOrder.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % surfaceOrder.length;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + surfaceOrder.length) % surfaceOrder.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = surfaceOrder.length - 1;
    else return;

    event.preventDefault();
    const next = surfaceOrder[nextIndex];
    selectSurface(next);
    window.requestAnimationFrame(() => {
      document.getElementById(`workspace-${next}-tab`)?.focus();
    });
  };

  const maximize = () => {
    if (surface === 'preview') onOpenPreview();
    else if (surface === 'files') onOpenFiles();
    else onOpenActivity();
  };

  const maximizeLabel =
    surface === 'preview'
      ? 'Open preview in new tab'
      : surface === 'files'
        ? 'Expand files'
        : 'Expand diagnostics';

  return (
    <section className="workspace-stage" aria-label="Browser workspace">
      <header className="workspace-stage-head">
        <div className="workspace-stage-title">
          <span className="workspace-stage-mark" aria-hidden="true">
            <Monitor size={15} />
          </span>
          <div>
            <strong>Environment</strong>
            <small>
              Linux VM · {sourceFiles.length} source file
              {sourceFiles.length === 1 ? '' : 's'} · {lifecycleLabel(vmStatus)}
            </small>
          </div>
        </div>
        <div className="stage-head-actions">
          <button
            aria-label={maximizeLabel}
            className="stage-expand"
            disabled={surface === 'preview' && !previewUrl}
            onClick={maximize}
            type="button"
          >
            {surface === 'preview' ? <ExternalLink size={14} /> : <Maximize2 size={14} />}
            <span>{surface === 'preview' ? 'Open' : 'Expand'}</span>
          </button>
          <button
            aria-label="Close environment inspector"
            className="stage-close"
            data-dialog-initial-focus=""
            onClick={onClose}
            type="button"
          >
            <PanelRightClose size={14} />
          </button>
        </div>
      </header>

      <div className="workspace-tabs" role="tablist" aria-label="Workspace surfaces">
        {(
          [
            ['preview', 'Preview', <Monitor size={13} key="preview" />],
            ['files', 'Files', <Files size={13} key="files" />],
            ['activity', 'Activity', <Activity size={13} key="activity" />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            aria-controls={`workspace-${id}`}
            aria-selected={surface === id}
            className={surface === id ? 'active' : ''}
            id={`workspace-${id}-tab`}
            key={id}
            onClick={() => selectSurface(id)}
            onKeyDown={(event) => moveSurfaceFocus(event, id)}
            role="tab"
            tabIndex={surface === id ? 0 : -1}
            type="button"
          >
            {icon}
            {label}
            {id === 'files' && sourceFiles.length > 0 ? (
              <span className="tab-count">{sourceFiles.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div
        aria-labelledby="workspace-preview-tab"
        className="workspace-surface preview"
        hidden={surface !== 'preview'}
        id="workspace-preview"
        role="tabpanel"
      >
        {surface === 'preview' ? (
          previewUrl && ready && canEmbedPreview ? (
            <div className="preview-frame-wrap">
              <div className="preview-address">
                <span className="preview-security-dot" aria-hidden="true" />
                <code>{previewUrl}</code>
                <button onClick={onOpenPreview} type="button">
                  Open new tab <ExternalLink size={12} />
                </button>
              </div>
              <iframe
                referrerPolicy="no-referrer"
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                src={previewUrl}
                title="Running app preview"
              />
            </div>
          ) : previewUrl && ready ? (
            <div className="stage-empty compact external-preview">
              <span className="stage-empty-icon">
                <Globe2 size={24} />
              </span>
              <strong>Preview is ready</strong>
              <p>
                This private HTTP Tailnet address cannot be embedded inside
                SparkRun&rsquo;s secure page. Open it directly in Chrome instead.
              </p>
              <button className="stage-primary-action" onClick={onOpenPreview} type="button">
                Open private preview <ExternalLink size={13} />
              </button>
            </div>
          ) : (
            <div className="stage-empty">
              <span
                className={`stage-empty-icon ${
                  building || networkRetrying ? 'working' : ''
                }`}
              >
                {building || networkRetrying ? (
                  <span className="spin coral" />
                ) : (
                  <Monitor size={26} />
                )}
              </span>
              <strong>
                {networkRetrying
                  ? 'Reconnecting the Tailnet preview'
                  : building
                    ? 'Building inside the VM'
                    : 'Preview is waiting'}
              </strong>
              <p>
                {networkRetrying
                  ? 'SparkRun is reconnecting the VM to the private Tailnet and checking its preview server.'
                  : building
                  ? 'Gemini is editing and testing the real Linux workspace. The running app will appear here when its server is healthy.'
                  : 'Describe the app in the agent pane. SparkRun will boot Linux, create the files, and connect the healthy server through Tailscale.'}
              </p>
              <div className="stage-empty-facts" aria-label="Preview readiness">
                <span className={vmStatus.lifecycle !== 'idle' ? 'done' : ''}>
                  <Cpu size={12} /> VM
                </span>
                <span className={sourceFiles.length > 0 ? 'done' : ''}>
                  <Files size={12} /> Files
                </span>
                <span className={previewUrl ? 'done' : ''}>
                  <Globe2 size={12} /> Tailnet URL
                </span>
              </div>
            </div>
          )
        ) : null}
      </div>

      <div
        aria-labelledby="workspace-files-tab"
        className="workspace-surface files"
        hidden={surface !== 'files'}
        id="workspace-files"
        role="tabpanel"
      >
        {surface === 'files' ? (
          sourceFiles.length === 0 ? (
            <div className="stage-empty compact">
              <span className="stage-empty-icon"><Files size={24} /></span>
              <strong>No workspace files yet</strong>
              <p>Files written by you, Gemini, or the terminal will appear here after a workspace scan.</p>
            </div>
          ) : (
            <div className="stage-files">
              <div className="stage-file-list" aria-label="Workspace files">
                {sourceFiles.map((file) => (
                  <button
                    aria-pressed={selectedFile === file.path}
                    className={selectedFile === file.path ? 'active' : ''}
                    key={file.path}
                    onClick={() => setSelectedFile(file.path)}
                    type="button"
                  >
                    <FileCode2 size={14} aria-hidden="true" />
                    <span>{file.path}</span>
                    <small>{formatBytes(file.sizeBytes)}</small>
                  </button>
                ))}
              </div>
              <div className="stage-file-inspector">
                <div className="stage-file-inspector-head">
                  <span>
                    <FileCode2 size={13} aria-hidden="true" /> {selectedFile}
                  </span>
                  <button onClick={onOpenFiles} type="button">
                    Expand <Maximize2 size={12} />
                  </button>
                </div>
                <WorkspaceFilePreview
                  className="stage-file-preview"
                  onReadFile={onReadFile}
                  path={selectedFile}
                  refreshToken={files}
                />
              </div>
            </div>
          )
        ) : null}
      </div>

      <div
        aria-labelledby="workspace-activity-tab"
        className="workspace-surface activity"
        hidden={surface !== 'activity'}
        id="workspace-activity"
        role="tabpanel"
      >
        {surface === 'activity' ? (
          <div className="stage-activity">
            <div className="stage-activity-summary">
              <span><Activity size={13} /> VM diagnostics</span>
              <small>{activityLines.length} recent lines</small>
            </div>
            {activityLines.length === 0 ? (
              <div className="stage-empty compact">
                <span className="stage-empty-icon"><Activity size={24} /></span>
                <strong>No VM activity yet</strong>
                <p>Boot, filesystem, Tailnet, command, and health events will stream here.</p>
              </div>
            ) : (
              <pre aria-label="Scrolling VM diagnostics" tabIndex={0}>
                {activityLines.join('\n')}
              </pre>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ChatScreen({
  cfg,
  onModel,
  events,
  files,
  building,
  networkRetrying,
  stopping,
  stoppingOperation,
  ready,
  fatalNetworkFailure,
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
  onCloseTerminal,
  onStartVm,
  terminalOpen,
  terminalDockHeight,
  onTerminalDockHeight,
  terminalText,
  terminalInput,
  terminalAvailable,
  terminalDisabled,
  onTerminalInput,
  onSendTerminalInput,
  onRawTerminalInput,
  onReadFile,
  debugLog,
  errorMessage,
}: ChatScreenProps) {
  const [inspectorOpen, setInspectorOpen] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 961px)').matches
      : true,
  );
  const [inspectorIsModal, setInspectorIsModal] = useState(() =>
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 960px)').matches
      : false,
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followingActivityRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);
  const sourceFiles = useMemo(() => files.filter(isSourceFile), [files]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(max-width: 960px)');
    const reconcile = (event: MediaQueryListEvent) =>
      setInspectorIsModal(event.matches);
    media.addEventListener?.('change', reconcile);
    return () => media.removeEventListener?.('change', reconcile);
  }, []);
  const inspectorDialogRef = useDrawerDialog<HTMLElement>(
    inspectorOpen && inspectorIsModal,
    () => setInspectorOpen(false),
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !followingActivityRef.current) {
      setShowJumpToLatest(Boolean(el));
      return;
    }
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: hasStarted ? 'smooth' : 'auto' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    setShowJumpToLatest(false);
    // Depend on the events array identity, not its length: once the list is
    // capped at 200, length stays constant and a length-only dep would stop
    // firing, freezing auto-scroll for the rest of the session.
  }, [events, hasStarted]);

  const updateActivityFollowState = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const following = distanceFromBottom <= 80;
    followingActivityRef.current = following;
    setShowJumpToLatest(!following);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    followingActivityRef.current = true;
    setShowJumpToLatest(false);
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  };

  const canSend =
    draft.trim().length > 3 &&
    !building &&
    !networkRetrying &&
    !stopping;
  const previewReady =
    ready && Boolean(previewUrl) && !fatalNetworkFailure;
  const statusText = previewReady
    ? 'Server ready'
    : stopping
      ? 'Stopping'
      : networkRetrying
        ? 'Connecting Tailnet'
      : building
      ? 'Building'
      : hasStarted
        ? lifecycleLabel(vmStatus)
        : 'Ready to build';
  const previewHost = hostFromPreviewUrl(previewUrl);
  const canRetryTailnet =
    Boolean(fatalNetworkFailure) ||
    (!building &&
      !networkRetrying &&
      hasStarted &&
      !previewReady &&
      !tailnetIp);
  const liveEvent = [...events]
    .reverse()
    .find((event) => ['thought', 'error', 'ready'].includes(event.kind));
  const liveAnnouncement =
    liveEvent?.kind === 'error'
      ? 'The coding task reported an error.'
      : liveEvent?.kind === 'ready'
        ? previewReady
          ? 'The preview is ready.'
          : 'The coding task is complete.'
        : liveEvent?.kind === 'thought'
          ? 'A new Gemini response is available.'
          : '';

  return (
    <div className="chat-frame">
      <div className={`cockpit-body ${inspectorOpen ? 'inspector-open' : ''}`}>
        <section
          className="agent-pane"
          aria-label="Gemini coding agent"
          inert={inspectorOpen && inspectorIsModal ? true : undefined}
        >
          <header className="agent-pane-head">
            <div>
              <span className="agent-avatar" aria-hidden="true">
                <Sparkles size={14} />
              </span>
              <span>
                <strong>{cfg.projectName}</strong>
                <small>
                  {statusText} · {sourceFiles.length} file
                  {sourceFiles.length === 1 ? '' : 's'} · {tailnetIp ?? 'Tailnet offline'}
                </small>
              </span>
            </div>
            <div className="agent-pane-actions">
              {canRetryTailnet ? (
                <button
                  aria-label={
                    fatalNetworkFailure
                      ? 'Recover network runtime'
                      : building
                        ? 'Preview current checkpoint'
                        : 'Retry Tailnet'
                  }
                  className="thread-icon-button warn"
                  onClick={onRetryTailnet}
                  type="button"
                >
                  <Cable size={14} />
                </button>
              ) : null}
              {sourceFiles.length > 0 ? (
                <button
                  aria-label="Open workspace files"
                  className="thread-icon-button"
                  onClick={onFiles}
                  type="button"
                >
                  <Files size={14} />
                </button>
              ) : null}
              <button
                aria-label="Open terminal"
                className="thread-icon-button"
                onClick={onTerminal}
                type="button"
              >
                <TerminalIcon size={14} />
              </button>
              <button
                aria-label="Open logs"
                className="thread-icon-button"
                onClick={onLogs}
                type="button"
              >
                <Activity size={14} />
              </button>
              <button
                aria-controls="workspace-inspector"
                aria-expanded={inspectorOpen}
                aria-label={inspectorOpen ? 'Collapse inspector' : 'Expand inspector'}
                className="thread-icon-button inspector-toggle"
                onClick={() => setInspectorOpen((current) => !current)}
                type="button"
              >
                {inspectorOpen ? (
                  <PanelRightClose size={15} />
                ) : (
                  <PanelRightOpen size={15} />
                )}
              </button>
            </div>
          </header>

          <div className="log-scroll" onScroll={updateActivityFollowState} ref={scrollRef}>
            <div className="log-inner">
          {!hasStarted && events.length === 0 ? (
            <div className="thread-empty">
              <span className="thread-empty-mark" aria-hidden="true">
                <Sparkles size={18} />
              </span>
              <h2>Ready when you are.</h2>
              <p>
                Ask Gemini to build, inspect, test, or run anything in the
                browser Linux workspace. Work and conversation state are
                checkpointed as you go.
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

          {(building || networkRetrying || stopping) && events.length > 0 ? (
            <div className="gen-row live-progress fadeUp" role="status">
              <span className="spin tiny coral" />
              {stopping
                ? stoppingOperation === 'tailnet'
                  ? 'Stopping the Tailnet retry and securing the workspace…'
                  : 'Stopping the request and securing the workspace…'
                : networkRetrying
                  ? 'Reconnecting the private Tailnet preview…'
                  : 'Gemini is working in the browser VM…'}
            </div>
          ) : null}
            </div>
            {showJumpToLatest ? (
              <button className="jump-to-latest" onClick={jumpToLatest} type="button">
                Jump to latest
              </button>
            ) : null}
        </div>

          <div aria-atomic="true" aria-live="polite" className="sr-only">
            {stopping
              ? stoppingOperation === 'tailnet'
                ? 'Stopping the Tailnet retry and securing the workspace.'
                : 'Stopping the active request and securing the workspace.'
              : liveAnnouncement}
          </div>

          <div className="composer">
            <div className="composer-inner">
          {previewReady ? (
            <button
              className="open-website-btn"
              onClick={onOpenWebsite}
              type="button"
            >
              <span className="left">
                <span className="dot" />
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

          <div
            className={`composer-shell ${
              building || networkRetrying || stopping ? 'busy' : ''
            }`}
          >
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
                Coding request
              </label>
              <textarea
                id="chat-prompt"
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
                    : 'Describe what to build, debug, inspect, or run…'
                }
                rows={hasStarted ? 2 : 3}
                value={draft}
              />
              <div className="composer-foot">
                <label className="composer-model">
                  <span className="gemini-grad star">✦</span>
                  <select
                    aria-label="Coding model"
                    onChange={(event) => onModel(event.target.value)}
                    value={cfg.model}
                  >
                    {MODELS.map((modelOption) => (
                      <option key={modelOption.id} value={modelOption.id}>
                        Gemini {modelOption.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={11} aria-hidden="true" />
                </label>
                <div className="composer-actions">
                  {building || networkRetrying || stopping ? (
                    <button
                      className="stop-btn"
                      disabled={stopping}
                      onClick={onCancel}
                      type="button"
                    >
                      <Square size={11} fill="currentColor" /> {stopping ? 'Stopping…' : 'Stop'}
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
              <div className="composer-hint">
                ⌘/Ctrl + Enter to send · every successful turn is checkpointed
              </div>
            </div>
          </div>
        </section>

        {inspectorOpen && inspectorIsModal ? (
          <button
            aria-label="Close inspector"
            className="workspace-panel-scrim inspector"
            onClick={() => setInspectorOpen(false)}
            type="button"
          />
        ) : null}
        <aside
          aria-label="Environment inspector"
          aria-modal={inspectorOpen && inspectorIsModal ? true : undefined}
          className="inspector-shell"
          hidden={!inspectorOpen}
          id="workspace-inspector"
          ref={inspectorIsModal ? inspectorDialogRef : undefined}
          role={inspectorIsModal ? 'dialog' : undefined}
          tabIndex={inspectorIsModal ? -1 : undefined}
        >
          <WorkspaceStage
            building={building}
            debugLog={debugLog}
            files={files}
            onOpenActivity={() => {
              if (inspectorIsModal) setInspectorOpen(false);
              onLogs();
            }}
            onClose={() => setInspectorOpen(false)}
            onOpenFiles={() => {
              if (inspectorIsModal) setInspectorOpen(false);
              onFiles();
            }}
            onOpenPreview={() => {
              if (inspectorIsModal) setInspectorOpen(false);
              onOpenWebsite();
            }}
            onReadFile={onReadFile}
            previewUrl={previewUrl}
            ready={ready}
            networkRetrying={networkRetrying}
            vmStatus={vmStatus}
          />
        </aside>
      </div>
      <TerminalDock
        available={terminalAvailable}
        disabled={terminalDisabled}
        height={terminalDockHeight}
        input={terminalInput}
        onClose={onCloseTerminal}
        onHeightChange={onTerminalDockHeight}
        onInput={onTerminalInput}
        onRawInput={onRawTerminalInput}
        onSendInput={onSendTerminalInput}
        onStartVm={onStartVm}
        open={terminalOpen}
        pauseReason={networkRetrying ? 'tailnet' : building ? 'coding' : null}
        text={terminalText}
        vmStatus={vmStatus}
      />
    </div>
  );
}

function compactEventSummary(event: LogEvent): string {
  const raw =
    event.text ??
    event.cmd ??
    event.lines?.filter(Boolean).slice(-1)[0] ??
    'Open for details';
  const singleLine = raw.replace(/\s+/g, ' ').trim();
  return singleLine.length > 112
    ? `${singleLine.slice(0, 109)}…`
    : singleLine;
}

function LogRow({ event }: { event: LogEvent }) {
  const labelMap: Record<EventKind, string> = {
    chat: 'You',
    thought: 'gemini',
    status: event.label ?? 'Status',
    cmd: event.toolCategory ? toolCategoryLabel(event.toolCategory) : 'Shell',
    stream: 'Output',
    ready: 'Ready',
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

  const isCompactActivity =
    event.kind === 'status' ||
    event.kind === 'cmd' ||
    event.kind === 'stream';

  if (isCompactActivity) {
    return (
      <details
        className={`activity-event fadeUp ${
          event.tone === 'error' ? 'has-error' : ''
        }`}
        open={event.tone === 'error' ? true : undefined}
      >
        <summary>
          <span className={`activity-event-icon ${event.kind}`}>
            {iconForKind(event.kind)}
          </span>
          <span className="activity-event-label">{label}</span>
          <span className="activity-event-summary">
            {compactEventSummary(event)}
          </span>
          <time>{event.time}</time>
          <ChevronDown className="activity-event-chevron" size={13} />
        </summary>
        <div className="activity-event-detail">{body}</div>
      </details>
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
  const latest = group.events[group.events.length - 1];
  return (
    <details
      className={`activity-event tool-activity fadeUp ${
        hasError ? 'has-error' : ''
      }`}
      open={hasError ? true : undefined}
    >
      <summary>
        <span className={`activity-event-icon cmd ${hasError ? 'err' : ''}`}>
          {iconForToolCategory(group.category)}
        </span>
        <span className="activity-event-label">
          {toolCategoryLabel(group.category)}
        </span>
        <span className="activity-event-summary">
          {group.events.length > 1 ? `${group.events.length} updates · ` : ''}
          {compactEventSummary(latest)}
        </span>
        <time>{group.time}</time>
        <ChevronDown className="activity-event-chevron" size={13} />
      </summary>
      <div className="activity-event-detail">
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
    </details>
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
      return <Activity size={size} aria-hidden="true" />;
    case 'ready':
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case 'error':
      return <TriangleAlert size={size} aria-hidden="true" />;
  }
}

interface TerminalDockProps {
  open: boolean;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  onStartVm: () => void;
  text: string;
  input: string;
  available: boolean;
  disabled: boolean;
  pauseReason: ActiveOperation | null;
  vmStatus: WebVmStatus;
  onInput: (value: string) => void;
  onSendInput: (inputOverride?: string) => void;
  onRawInput: (value: string) => void;
}

const TERMINAL_DOCK_MIN_HEIGHT = 160;
const TERMINAL_DOCK_DEFAULT_HEIGHT = 300;
const TERMINAL_DOCK_STORAGE_KEY = 'sparkrun.terminalDock.v1';

function readTerminalDockHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(TERMINAL_DOCK_STORAGE_KEY));
    return Number.isFinite(stored) && stored >= TERMINAL_DOCK_MIN_HEIGHT
      ? stored
      : TERMINAL_DOCK_DEFAULT_HEIGHT;
  } catch {
    return TERMINAL_DOCK_DEFAULT_HEIGHT;
  }
}

interface FileDrawerProps {
  open: boolean;
  onClose: () => void;
  files: DirectoryEntry[];
  onReadFile: (path: string) => Promise<string>;
}

interface LogDrawerProps {
  open: boolean;
  onClose: () => void;
  text: string;
}

function useDrawerDialog<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
) {
  const dialogRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    const initialFocus =
      dialog?.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
      dialog;
    initialFocus?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (element) =>
          !element.hasAttribute('hidden') &&
          element.getAttribute('aria-hidden') !== 'true',
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  return dialogRef;
}

function LogDrawer({ open, onClose, text }: LogDrawerProps) {
  const lines = text ? text.split('\n') : [];
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useDrawerDialog<HTMLDivElement>(open, onClose);

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
        aria-hidden="true"
        className="term-overlay open"
        onClick={onClose}
      />
      <div
        aria-labelledby="diagnostics-log-dialog-title"
        aria-modal="true"
        className="term-drawer open"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="term-head">
          <div className="term-head-title" id="diagnostics-log-dialog-title">
            <FileCode2 size={14} aria-hidden="true" /> Diagnostics log
            <span className="term-head-meta">· {lines.length} lines</span>
          </div>
          <button
            aria-label="Close logs"
            className="term-close"
            data-dialog-initial-focus=""
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

function FileDrawer({ open, onClose, files, onReadFile }: FileDrawerProps) {
  const sourceFiles = useMemo(() => files.filter(isSourceFile), [files]);
  const totalBytes = sourceFiles.reduce(
    (total, file) => total + (file.sizeBytes ?? 0),
    0,
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const dialogRef = useDrawerDialog<HTMLElement>(open, onClose);

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
      <div aria-hidden="true" className="side-overlay open" onClick={onClose} />
      <aside
        aria-labelledby="workspace-files-dialog-title"
        aria-modal="true"
        className="side-panel open"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="side-head">
          <div className="term-head-title" id="workspace-files-dialog-title">
            <Files size={14} aria-hidden="true" /> Workspace files
            <span className="term-head-meta">
              · {sourceFiles.length} files · {formatBytes(totalBytes)}
            </span>
          </div>
          <button
            aria-label="Close files"
            className="term-close"
            data-dialog-initial-focus=""
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
        {sourceFiles.length === 0 ? (
          <div className="file-panel-empty">No workspace files yet.</div>
        ) : (
          <>
            <div
              aria-label="Workspace files"
              className="file-panel-list"
            >
              {sourceFiles.map((file) => {
                const active = selectedFile?.path === file.path;
                return (
                  <button
                    aria-pressed={active}
                    className={`file-panel-row ${active ? 'active' : ''}`}
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
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
                <div className="file-panel-detail-head">
                  <span>Selected</span>
                  <strong>{selectedFile.path}</strong>
                  <code>{formatBytes(selectedFile.sizeBytes)}</code>
                </div>
                <WorkspaceFilePreview
                  className="file-panel-preview"
                  onReadFile={onReadFile}
                  path={selectedFile.path}
                  refreshToken={files}
                />
              </div>
            ) : null}
          </>
        )}
      </aside>
    </>
  );
}

function XtermConsole({
  text,
  disabled,
  onData,
}: {
  text: string;
  disabled: boolean;
  onData: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const renderedTextRef = useRef('');
  const desiredTextRef = useRef(text);
  const writeInFlightRef = useRef(false);
  const renderEpochRef = useRef(0);
  const pumpWritesRef = useRef<() => void>(() => undefined);
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  desiredTextRef.current = text;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new XTerm({
      allowProposedApi: false,
      cursorBlink: !disabled,
      cursorStyle: 'bar',
      convertEol: true,
      disableStdin: disabled,
      fontFamily: 'JetBrains Mono, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 8_000,
      theme: {
        background: '#050608',
        foreground: '#c8e6ce',
        cursor: '#ff8a6e',
        cursorAccent: '#050608',
        selectionBackground: '#315b7a88',
        black: '#050608',
        brightBlack: '#66736a',
        red: '#ff7d7d',
        green: '#76dda6',
        yellow: '#f3c577',
        blue: '#79aaff',
        magenta: '#b79cff',
        cyan: '#72d8d1',
        white: '#e8ece9',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new SearchAddon());
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(host);
    terminalRef.current = terminal;
    const renderEpoch = renderEpochRef.current + 1;
    renderEpochRef.current = renderEpoch;
    const pumpWrites = () => {
      if (
        renderEpochRef.current !== renderEpoch ||
        terminalRef.current !== terminal ||
        writeInFlightRef.current
      ) {
        return;
      }
      const rendered = renderedTextRef.current;
      const desired = desiredTextRef.current;
      if (rendered === desired) return;

      const canAppend = desired.startsWith(rendered);
      if (!canAppend) {
        // Terminal state is capped with a left-side slice. If the cap moves
        // while xterm is still draining a prior write, resetting immediately
        // interleaves old queued bytes after the replacement and can make the
        // display drop data or appear frozen. The single-writer pump waits for
        // the prior callback, then performs one complete resynchronization.
        terminal.reset();
      }
      const target = desired;
      const chunk = canAppend ? target.slice(rendered.length) : target;
      if (!chunk) {
        renderedTextRef.current = target;
        return;
      }
      writeInFlightRef.current = true;
      terminal.write(chunk, () => {
        if (
          renderEpochRef.current !== renderEpoch ||
          terminalRef.current !== terminal
        ) {
          return;
        }
        renderedTextRef.current = target;
        writeInFlightRef.current = false;
        pumpWrites();
      });
    };
    pumpWritesRef.current = pumpWrites;
    const inputSubscription = terminal.onData((value) => onDataRef.current(value));
    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        // The dock can be mid-transition; the next resize will fit it.
      }
    };
    const pendingFitFrames = new Set<number>();
    const scheduleFit = () => {
      const frameId = requestAnimationFrame(() => {
        pendingFitFrames.delete(frameId);
        fitNow();
      });
      pendingFitFrames.add(frameId);
    };
    scheduleFit();
    pumpWrites();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleFit);
    observer?.observe(host);
    return () => {
      observer?.disconnect();
      for (const frameId of pendingFitFrames) {
        cancelAnimationFrame(frameId);
      }
      pendingFitFrames.clear();
      inputSubscription.dispose();
      renderEpochRef.current += 1;
      writeInFlightRef.current = false;
      pumpWritesRef.current = () => undefined;
      terminal.dispose();
      terminalRef.current = null;
      renderedTextRef.current = '';
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = disabled;
    terminal.options.cursorBlink = !disabled;
  }, [disabled]);

  useEffect(() => {
    desiredTextRef.current = text;
    pumpWritesRef.current();
  }, [text]);

  return <div className="xterm-host" ref={hostRef} />;
}

function TerminalDock({
  open,
  height,
  onHeightChange,
  onClose,
  onStartVm,
  text,
  input,
  available,
  disabled,
  pauseReason,
  vmStatus,
  onInput,
  onSendInput,
  onRawInput,
}: TerminalDockProps) {
  const [maximized, setMaximized] = useState(false);
  const dockRef = useRef<HTMLElement | null>(null);
  const lines = text ? text.split('\n').length : 0;
  const booting = vmStatus.lifecycle === 'booting';

  const clampHeight = (next: number) => {
    const parentHeight =
      dockRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
    // Layout may not have measured yet (or is not real, as in jsdom); only
    // clamp against a parent that actually has a height.
    const maxHeight =
      parentHeight > 0
        ? Math.max(TERMINAL_DOCK_MIN_HEIGHT, parentHeight - 96)
        : Number.POSITIVE_INFINITY;
    return Math.round(Math.min(maxHeight, Math.max(TERMINAL_DOCK_MIN_HEIGHT, next)));
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (maximized) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight =
      dockRef.current?.getBoundingClientRect().height || height;
    const onMove = (move: PointerEvent) => {
      onHeightChange(clampHeight(startHeight + (startY - move.clientY)));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const resizeByKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (maximized) setMaximized(false);
    onHeightChange(clampHeight(height + (event.key === 'ArrowUp' ? 40 : -40)));
  };

  if (!open) {
    return null;
  }

  const stateLabel = available
    ? disabled
      ? 'paused'
      : 'live root shell'
    : booting
      ? 'VM booting'
      : 'VM stopped';

  return (
    <section
      aria-label="Terminal"
      className={`terminal-dock ${maximized ? 'maximized' : ''}`}
      ref={dockRef}
      style={maximized ? undefined : { height }}
    >
      <div
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        aria-valuemin={TERMINAL_DOCK_MIN_HEIGHT}
        aria-valuenow={height}
        className="terminal-dock-resize"
        onKeyDown={resizeByKey}
        onPointerDown={startResize}
        role="separator"
        tabIndex={0}
      />
      <div className="terminal-dock-head">
        <div className="terminal-dock-title">
          <TerminalIcon size={14} aria-hidden="true" /> Terminal
          <span className="term-head-meta">
            · {stateLabel} · {SITE_ROOT} · {lines} lines
          </span>
        </div>
        <div className="terminal-dock-actions">
          {!available ? (
            <button
              className="terminal-dock-action primary"
              disabled={booting}
              onClick={onStartVm}
              type="button"
            >
              <Play size={12} aria-hidden="true" />
              {booting ? 'Starting VM…' : 'Start VM'}
            </button>
          ) : null}
          <button
            aria-label={maximized ? 'Restore terminal size' : 'Maximize terminal'}
            className="terminal-dock-action"
            onClick={() => setMaximized((current) => !current)}
            type="button"
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            aria-label="Close terminal"
            className="term-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>
      </div>
      <div className="terminal-dock-body">
        {!available ? (
          <div className="terminal-empty">
            <span>
              {booting
                ? 'Starting the Linux VM…'
                : `The VM is not running. Start it to open a live root shell in ${SITE_ROOT}.`}
            </span>
          </div>
        ) : (
          <>
            <XtermConsole text={text} disabled={disabled} onData={onRawInput} />
            {disabled ? (
              <div className="terminal-paused" role="status">
                {pauseReason === 'tailnet'
                  ? 'Terminal input is paused while SparkRun reconnects Tailnet.'
                  : 'Terminal input is paused while the coding agent owns the VM.'}
              </div>
            ) : null}
          </>
        )}
      </div>
      <form
        className="term-form terminal-dock-form"
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
          placeholder={
            !available
              ? 'Start the VM first'
              : disabled
                ? 'Terminal paused while the coding agent runs'
                : `Run a command in ${SITE_ROOT}`
          }
          spellCheck={false}
          value={input}
        />
        <button disabled={disabled || !input.trim()} type="submit">
          Run
        </button>
      </form>
    </section>
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
  /** Tailscale key the running VM was created with; a change forces a reboot. */
  const bootedTailscaleKeyRef = useRef<string>('');
  /** Boots currently queued or running; the auto-boot effect must not add one. */
  const vmBootInFlightRef = useRef(0);
  const [terminalDockHeight, setTerminalDockHeight] = useState(
    readTerminalDockHeight,
  );
  const updateTerminalDockHeight = (height: number) => {
    setTerminalDockHeight(height);
    try {
      window.localStorage.setItem(TERMINAL_DOCK_STORAGE_KEY, String(height));
    } catch {
      // Storage can be unavailable; the height still applies for this session.
    }
  };
  const [showLogs, setShowLogs] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [railModalOpen, setRailModalOpen] = useState(false);

  const [projects, setProjects] = useState<VaultProject[]>([]);
  const [activeProject, setActiveProject] = useState<VaultProject>(() =>
    createVaultProjectDraft({
      name: 'Untitled site',
      prompt: DEFAULT_PROMPT,
    }),
  );

  const [backend, setBackend] = useState<WorkspaceRuntime | null>(null);
  const [vmStatus, setVmStatus] = useState<WebVmStatus>(INITIAL_STATUS);
  const [files, setFiles] = useState<DirectoryEntry[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [conversations, setConversations] = useState<VaultConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(
    null,
  );
  const [storageDurability, setStorageDurability] = useState<StorageDurability>(
    INITIAL_STORAGE_DURABILITY,
  );
  const [checkpointState, setCheckpointState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [terminal, setTerminal] = useState('');
  const [debugLog, setDebugLog] = useState('');
  const [terminalCommand, setTerminalCommand] = useState('');
  const [building, setBuilding] = useState(false);
  const [networkRetrying, setNetworkRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stoppingOperation, setStoppingOperation] =
    useState<ActiveOperation | null>(null);
  const [ready, setReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [sourceDirectory, setSourceDirectory] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [sourceDirectoryName, setSourceDirectoryName] = useState('');

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [screen]);

  const localFolderSupported = useMemo(() => isLocalFolderSupported(), []);
  const tailnetReadyLoggedRef = useRef<string | null>(null);
  const buildAbortControllerRef = useRef<AbortController | null>(null);
  const networkRetryAbortControllerRef = useRef<AbortController | null>(null);
  const stoppingControllerRef = useRef<AbortController | null>(null);
  const stoppingBackendRef = useRef<WorkspaceRuntime | null>(null);
  const sendInFlightRef = useRef(false);
  const vmBootChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const backendResetChainRef = useRef<Promise<void>>(Promise.resolve());
  const backendResetScheduledForRef = useRef<WorkspaceRuntime | null>(null);
  const fatalNetworkReloadInFlightRef = useRef(false);
  const checkpointChainRef = useRef<Promise<void>>(Promise.resolve());
  const projectTransitionChainRef = useRef<Promise<void>>(Promise.resolve());
  const projectTransitionGenerationRef = useRef(0);
  const vaultRef = useRef(getBrowserVault());
  const vaultReadyRef = useRef<Promise<void> | null>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeProjectIdRef = useRef(activeProject.id);
  const terminalRef = useRef(terminal);
  const rawTerminalCheckpointTimerRef = useRef<number | null>(null);
  const terminalCheckpointTimersRef = useRef<Set<number>>(new Set());
  // Stop drains the checkpoint chain before disposing a runtime. Producers
  // that wake later (notably terminal idle timers) must not enqueue new work
  // behind that already-drained barrier.
  const quiescingBackendsRef = useRef<WeakSet<WorkspaceRuntime>>(new WeakSet());
  const checkpointStateTimerRef = useRef<number | null>(null);
  const invalidatedProjectIdsRef = useRef<Set<string>>(new Set());
  const startupHydrationInvalidatedRef = useRef(false);
  const componentActiveRef = useRef(true);
  const workspaceLeaseRef = useRef<{
    projectId: string;
    backend: WorkspaceRuntime;
    lease: WorkspaceLease;
  } | null>(null);
  const conversationEnsureRef = useRef<{
    projectId: string;
    promise: Promise<VaultConversation>;
  } | null>(null);
  activeProjectIdRef.current = activeProject.id;
  terminalRef.current = terminal;

  const releaseWorkspaceLeaseFor = async (
    vm: WorkspaceRuntime,
  ): Promise<void> => {
    const mounted = workspaceLeaseRef.current;
    if (!mounted || mounted.backend !== vm) return;
    workspaceLeaseRef.current = null;
    await mounted.lease.release();
  };

  const disposeWorkspaceRuntime = async (
    vm: WorkspaceRuntime,
  ): Promise<void> => {
    try {
      await vm.dispose();
    } finally {
      await releaseWorkspaceLeaseFor(vm);
    }
  };

  // The backend can acquire a preview URL while retaining the same object
  // identity. Re-read it on each render so the state update that marks a
  // healthy preview ready cannot leave this value trapped at an older null.
  const fatalNetworkFailure =
    backend?.getFatalNetworkFailure?.() ??
    getFatalTailnetRuntimeFailure();
  const previewUrl = fatalNetworkFailure
    ? null
    : vmStatus.previewUrl ?? backend?.getPreviewUrl() ?? null;
  const activeServerPort =
    vmStatus.serverPort ?? portFromPreviewUrl(previewUrl) ?? null;

  const ensureVaultReady = (): Promise<void> => {
    if (!vaultReadyRef.current) {
      vaultReadyRef.current = (async () => {
        const vault = vaultRef.current;
        await vault.open();
        await vault.recoverIncompleteWrites();
        try {
          setStorageDurability(await requestDurableBrowserStorage());
        } catch {
          // Persistence requests are best-effort. IndexedDB remains available
          // even if the browser declines durable-storage eviction protection.
        }
      })();
    }
    return vaultReadyRef.current;
  };

  const refreshConversations = async (
    projectId = activeProject.id,
  ): Promise<VaultConversation[]> => {
    await ensureVaultReady();
    if (invalidatedProjectIdsRef.current.has(projectId)) return [];
    const next = await vaultRef.current.listConversations(projectId);
    if (
      componentActiveRef.current &&
      activeProjectIdRef.current === projectId
    ) {
      setConversations(next);
    }
    return next;
  };

  const ensureActiveConversation = (
    titleSeed = activeProject.prompt || 'New conversation',
  ): Promise<VaultConversation> => {
    const targetProject = activeProject;
    if (invalidatedProjectIdsRef.current.has(targetProject.id)) {
      return Promise.reject(new Error(`Unknown project: ${targetProject.id}`));
    }
    const inFlight = conversationEnsureRef.current;
    if (inFlight?.projectId === targetProject.id) {
      return inFlight.promise;
    }

    const promise = (async () => {
      await ensureVaultReady();
      if (invalidatedProjectIdsRef.current.has(targetProject.id)) {
        throw new Error(`Unknown project: ${targetProject.id}`);
      }
      const vault = vaultRef.current;
      const project = await vault.createProject({
        id: targetProject.id,
        name: redactCodingSecrets(targetProject.name),
        prompt: redactCodingSecrets(targetProject.prompt),
      });

      const isCurrentProject = () =>
        componentActiveRef.current &&
        !invalidatedProjectIdsRef.current.has(targetProject.id) &&
        activeProjectIdRef.current === targetProject.id;
      const existingId =
        isCurrentProject()
          ? activeConversationIdRef.current ?? project.activeConversationId
          : project.activeConversationId;
      if (existingId) {
        const existing = await vault.db.conversations.get(existingId);
        if (existing) {
          if (isCurrentProject()) {
            activeConversationIdRef.current = existing.id;
            setActiveConversationId(existing.id);
          }
          return existing;
        }
      }

      const conversation = await vault.getOrCreateActiveConversation({
        projectId: targetProject.id,
        title:
          redactCodingSecrets(titleSeed).trim().slice(0, 72) ||
          'New conversation',
        model,
      });
      if (isCurrentProject()) {
        activeConversationIdRef.current = conversation.id;
        setActiveConversationId(conversation.id);
        await refreshConversations(targetProject.id);
      }
      return conversation;
    })();

    conversationEnsureRef.current = {
      projectId: targetProject.id,
      promise,
    };
    const clearInFlight = () => {
      if (conversationEnsureRef.current?.promise === promise) {
        conversationEnsureRef.current = null;
      }
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  };

  const appendEvent = (
    event: Omit<LogEvent, 'id' | 'time'>,
    // A long-running build's late callbacks (harness status, cancellation
    // reconciliation) must land in the conversation that produced them, not
    // whichever conversation the user has since selected. Callers with a
    // captured origin pass it here; UI rendering happens only while that
    // origin is still the visible conversation.
    target?: { projectId: string; conversationId: string | null },
  ) => {
    const sanitizedEvent: Omit<LogEvent, 'id' | 'time'> = {
      ...event,
      ...(event.label
        ? { label: redactCodingSecrets(event.label) }
        : {}),
      ...(event.text ? { text: redactCodingSecrets(event.text) } : {}),
      ...(event.cmd ? { cmd: redactCodingSecrets(event.cmd) } : {}),
      ...(event.lines
        ? { lines: event.lines.map((line) => redactCodingSecrets(line)) }
        : {}),
    };
    const completeEvent: LogEvent = {
      ...sanitizedEvent,
      id: makeId(),
      time: clock(),
    };
    const isCurrentView =
      !target ||
      (activeProjectIdRef.current === target.projectId &&
        activeConversationIdRef.current === target.conversationId);
    if (isCurrentView) {
      setEvents((current) => [...current, completeEvent].slice(-200));
    }
    const conversationId = target
      ? target.conversationId
      : activeConversationIdRef.current;
    const projectId = target ? target.projectId : activeProject.id;
    if (
      conversationId &&
      !invalidatedProjectIdsRef.current.has(projectId)
    ) {
      void ensureVaultReady()
        .then(() => {
          if (invalidatedProjectIdsRef.current.has(projectId)) return;
          return vaultRef.current.appendConversationEvent({
            conversationId,
            role: conversationRoleForEvent(sanitizedEvent),
            kind: sanitizedEvent.kind,
            payload: completeEvent,
          });
        })
        .then(() => refreshConversations(projectId))
        .catch((error) => {
          if (!invalidatedProjectIdsRef.current.has(projectId)) {
            console.error('[vault] could not persist conversation event', error);
          }
        });
    }
  };

  const appendTerminal = (text: string) => {
    setTerminal((current) => `${current}${text}`.slice(-200_000));
  };

  const appendDebug = (entry: WebVmDebugEntry) => {
    setDebugLog((current) => {
      const prefix = current ? `${current}\n` : '';
      return redactCodingSecrets(
        filterTerminalOutput(`${prefix}${formatDebugEntry(entry)}`),
      ).slice(-80_000);
    });
  };

  useEffect(() => {
    componentActiveRef.current = true;
    const startupDraftId = activeProjectIdRef.current;
    let cancelled = false;
    void ensureVaultReady()
      .then(async () => {
        if (cancelled) return;
        const storedProjects = await vaultRef.current.listProjects();
        if (cancelled) return;
        setProjects(storedProjects);
        const [activeProjectId, onboardingComplete] = await Promise.all([
          vaultRef.current.getSetting<string>(ACTIVE_PROJECT_SETTING_KEY),
          vaultRef.current.getSetting<boolean>(
            ONBOARDING_COMPLETE_SETTING_KEY,
          ),
        ]);
        if (cancelled || startupHydrationInvalidatedRef.current) return;
        setHasOpenedBefore(onboardingComplete === true);
        const project =
          storedProjects.find((candidate) => candidate.id === activeProjectId) ??
          storedProjects[0];
        if (
          !project ||
          cancelled ||
          startupHydrationInvalidatedRef.current ||
          activeProjectIdRef.current !== startupDraftId
        ) {
          return;
        }
        activeProjectIdRef.current = project.id;
        setActiveProject(project);
        setDraft(project.prompt);
        const next = await vaultRef.current.listConversations(project.id);
        if (cancelled || startupHydrationInvalidatedRef.current) return;
        setConversations(next);
        const selectedId = project.activeConversationId ?? next[0]?.id ?? null;
        activeConversationIdRef.current = selectedId;
        setActiveConversationId(selectedId);
        if (selectedId) {
          const storedEvents = await vaultRef.current.listConversationEvents(
            selectedId,
          );
          if (cancelled || startupHydrationInvalidatedRef.current) return;
          const restoredEvents = storedEvents
            .map(logEventFromVault)
            .filter((event): event is LogEvent => event !== null);
          setEvents(restoredEvents.slice(-200));
          setHasStarted(restoredEvents.length > 0);
        }
        if (
          onboardingComplete === true &&
          validateGoogleApiKey(savedKeys.apiKey) === null &&
          !cancelled
        ) {
          setScreen('chat');
        }
      })
      .catch((error) => {
        console.error('[vault] initialization failed', error);
      });
    return () => {
      cancelled = true;
      componentActiveRef.current = false;
      buildAbortControllerRef.current?.abort();
      networkRetryAbortControllerRef.current?.abort();
      conversationEnsureRef.current = null;
      if (rawTerminalCheckpointTimerRef.current !== null) {
        window.clearTimeout(rawTerminalCheckpointTimerRef.current);
        rawTerminalCheckpointTimerRef.current = null;
      }
      for (const timerId of terminalCheckpointTimersRef.current) {
        window.clearTimeout(timerId);
      }
      terminalCheckpointTimersRef.current.clear();
      if (checkpointStateTimerRef.current !== null) {
        window.clearTimeout(checkpointStateTimerRef.current);
        checkpointStateTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const projectId = activeProject.id;
    let cancelled = false;
    void ensureVaultReady()
      .then(async () => {
        const [terminalSessions, directoryHandle] = await Promise.all([
          vaultRef.current.listTerminalSessions(projectId),
          localFolderSupported
            ? vaultRef.current.getSetting<FileSystemDirectoryHandle>(
                projectSourceDirectorySettingKey(projectId),
              )
            : Promise.resolve(undefined),
        ]);
        if (cancelled || activeProjectIdRef.current !== projectId) return;
        setTerminal(
          redactCodingSecrets(terminalSessions[0]?.scrollback ?? ''),
        );
        setSourceDirectory(directoryHandle ?? null);
        setSourceDirectoryName(directoryHandle?.name ?? '');
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('[vault] could not restore project peripherals', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject.id, localFolderSupported]);

  useEffect(() => {
    return () => {
      if (backend && workspaceLeaseRef.current?.backend === backend) {
        void disposeWorkspaceRuntime(backend).catch((error) => {
          console.error('[workspace] VM cleanup failed', error);
        });
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
    if (
      changed &&
      backend &&
      !building &&
      // A background Tailnet retry (or an in-flight Stop) is actively driving
      // this VM; disposing it underneath that operation produced spurious
      // mid-flight failures and checkpoints of in-flux state.
      !networkRetrying &&
      !stopping &&
      backendResetScheduledForRef.current !== backend
    ) {
      const mountedBackend = backend;
      backendResetScheduledForRef.current = mountedBackend;
      const previousReset = backendResetChainRef.current.catch(() => undefined);
      const reset = previousReset.then(async () => {
        if (!mountedBackend.isDisposed()) {
          await saveVaultCheckpoint(mountedBackend, 'before-reset');
        }
        await disposeWorkspaceRuntime(mountedBackend);
        setBackend((current) =>
          current === mountedBackend ? null : current,
        );
        setVmStatus(INITIAL_STATUS);
        tailnetReadyLoggedRef.current = null;
        appendEvent({
          kind: 'status',
          label: 'Tailnet key changed',
          text: 'The live workspace was checkpointed. The next build will boot a fresh VM with the updated Tailscale auth key.',
        });
      });
      backendResetChainRef.current = reset
        .catch((error) => {
          appendEvent({
            kind: 'error',
            label: 'Tailnet key update paused',
            text: `The key was updated, but SparkRun kept the current VM because its final checkpoint failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        })
        .finally(() => {
          if (backendResetScheduledForRef.current === mountedBackend) {
            backendResetScheduledForRef.current = null;
          }
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

  const updateModel = (value: string) => {
    startupHydrationInvalidatedRef.current = true;
    setModel(value);
  };

  const updateProjectName = (name: string) => {
    startupHydrationInvalidatedRef.current = true;
    setActiveProject((current) => ({ ...current, name }));
  };

  const finalizeProjectName = (name: string) => {
    startupHydrationInvalidatedRef.current = true;
    setActiveProject((current) => ({
      ...current,
      name: normalizeProjectName(name),
    }));
  };

  const saveActiveProject = async (
    updates: Partial<Pick<VaultProject, 'name' | 'prompt'>> = {},
    options: { requireExisting?: boolean } = {},
  ): Promise<VaultProject> => {
    const targetProject = activeProject;
    if (invalidatedProjectIdsRef.current.has(targetProject.id)) {
      throw new Error(`Unknown project: ${targetProject.id}`);
    }
    const hasNameUpdate = Object.prototype.hasOwnProperty.call(updates, 'name');
    const hasPromptUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      'prompt',
    );
    await ensureVaultReady();
    // A build can run for minutes while the project is renamed or its vault
    // metadata advances. Merge its narrow update into the latest durable row,
    // rather than writing the build-start snapshot back over newer metadata.
    const latestProject = await vaultRef.current.getProject(targetProject.id);
    if (invalidatedProjectIdsRef.current.has(targetProject.id)) {
      throw new Error(`Unknown project: ${targetProject.id}`);
    }
    const baseProject = latestProject ?? targetProject;
    const nextProject: VaultProject = {
      ...baseProject,
      name: normalizeProjectName(
        redactCodingSecrets(
          hasNameUpdate ? updates.name ?? baseProject.name : baseProject.name,
        ),
      ),
      prompt: hasPromptUpdate
        ? redactCodingSecrets(updates.prompt ?? baseProject.prompt)
        : redactCodingSecrets(baseProject.prompt),
    };
    const stored = await vaultRef.current.saveProjectMetadata(
      nextProject,
      options,
    );
    if (activeProjectIdRef.current === targetProject.id) {
      setActiveProject(stored);
    }
    setProjects(await vaultRef.current.listProjects());
    return stored;
  };

  const loadFiles = async (
    vm: WorkspaceRuntime | null = backend,
    projectIdAtRequest = activeProjectIdRef.current,
  ) => {
    if (!vm) {
      if (
        componentActiveRef.current &&
        activeProjectIdRef.current === projectIdAtRequest
      ) {
        setFiles([]);
      }
      return;
    }
    const canPublish = () =>
      componentActiveRef.current &&
      activeProjectIdRef.current === projectIdAtRequest &&
      workspaceLeaseRef.current?.backend === vm &&
      !vm.isDisposed() &&
      !quiescingBackendsRef.current.has(vm);
    if (!canPublish()) return;
    const collected: DirectoryEntry[] = [];
    const visit = async (dirPath: string, depth: number) => {
      if (depth > MAX_WORKSPACE_SCAN_DEPTH) {
        throw new Error(
          `Workspace tree exceeds the supported depth of ${MAX_WORKSPACE_SCAN_DEPTH}.`,
        );
      }
      const entries = (await vm.listDirectory(dirPath)).filter((entry) =>
        isVisibleWorkspacePath(entry.path),
      );
      collected.push(...entries);
      if (collected.length > MAX_WORKSPACE_SCAN_ENTRIES) {
        throw new Error(
          `Workspace tree exceeds the ${MAX_WORKSPACE_SCAN_ENTRIES.toLocaleString()}-entry safety limit.`,
        );
      }
      for (const entry of entries) {
        if (
          entry.type === 'directory' &&
          isVisibleWorkspacePath(entry.path)
        ) {
          await visit(entry.path, depth + 1);
        }
      }
    };
    try {
      await visit('', 0);
    } catch (error) {
      if (canPublish()) throw error;
      return;
    }
    if (canPublish()) {
      setFiles(mergeEntries(collected));
    }
  };

  const readWorkspaceFile = async (path: string): Promise<string> => {
    const vm = backend;
    if (!vm || vm.isDisposed()) {
      throw new Error('Boot the workspace to read this file.');
    }
    const entry = files.find(
      (candidate) => candidate.type === 'file' && candidate.path === path,
    );
    if (entry?.sizeBytes && entry.sizeBytes > 512 * 1024) {
      throw new Error(
        `${path} is ${formatBytes(entry.sizeBytes)}; previews are limited to 512 KB.`,
      );
    }
    const text = await vm.readText(path);
    if (text.includes('\0')) {
      throw new Error(`${path} appears to be binary and cannot be previewed.`);
    }
    const maxPreviewCharacters = 200_000;
    if (text.length > maxPreviewCharacters) {
      return `${text.slice(0, maxPreviewCharacters)}\n\n… preview truncated …`;
    }
    return text;
  };

  const collectSourceFiles = async (vm: VmFileBackend): Promise<SourceFile[]> => {
    const collected: DirectoryEntry[] = [];
    const visit = async (dirPath: string, depth: number) => {
      if (depth > MAX_WORKSPACE_SCAN_DEPTH) {
        throw new Error(
          `Workspace tree exceeds the supported depth of ${MAX_WORKSPACE_SCAN_DEPTH}.`,
        );
      }
      const entries = (await vm.listDirectory(dirPath)).filter((entry) =>
        isVisibleWorkspacePath(entry.path),
      );
      collected.push(...entries);
      if (collected.length > MAX_WORKSPACE_SCAN_ENTRIES) {
        throw new Error(
          `Workspace tree exceeds the ${MAX_WORKSPACE_SCAN_ENTRIES.toLocaleString()}-entry safety limit.`,
        );
      }
      for (const entry of entries) {
        if (
          entry.type === 'directory' &&
          isVisibleWorkspacePath(entry.path)
        ) {
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
          content:
            typeof vm.readBytes === 'function'
              ? await vm.readBytes(entry.path)
              : await vm.readText(entry.path),
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

  // Stop any in-flight build so it can't keep mutating shared state (backend,
  // ready flag, saved project) after the user has navigated away from it.
  const abortActiveBuild = () => {
    buildAbortControllerRef.current?.abort();
    buildAbortControllerRef.current = null;
  };

  const abortActiveNetworkRetry = () => {
    networkRetryAbortControllerRef.current?.abort();
    networkRetryAbortControllerRef.current = null;
  };

  const abortActiveOperations = () => {
    abortActiveBuild();
    abortActiveNetworkRetry();
  };

  const clearProjectScopedRuntimeState = (): string => {
    const terminalScrollback = terminalRef.current.slice(-100_000);
    if (rawTerminalCheckpointTimerRef.current !== null) {
      window.clearTimeout(rawTerminalCheckpointTimerRef.current);
      rawTerminalCheckpointTimerRef.current = null;
    }
    for (const timerId of terminalCheckpointTimersRef.current) {
      window.clearTimeout(timerId);
    }
    terminalCheckpointTimersRef.current.clear();
    if (checkpointStateTimerRef.current !== null) {
      window.clearTimeout(checkpointStateTimerRef.current);
      checkpointStateTimerRef.current = null;
    }
    setTerminal('');
    terminalRef.current = '';
    setTerminalCommand('');
    setDebugLog('');
    setErrorMessage(null);
    setShowTerminal(false);
    setShowLogs(false);
    setShowFiles(false);
    setCheckpointState('idle');
    return terminalScrollback;
  };

  const persistTerminalScrollback = async (
    projectId: string,
    scrollback: string,
    options: { allowInvalidated?: boolean } = {},
  ): Promise<void> => {
    if (!scrollback) return;
    try {
      await ensureVaultReady();
      if (
        !options.allowInvalidated &&
        invalidatedProjectIdsRef.current.has(projectId)
      ) {
        return;
      }
      if (!(await vaultRef.current.getProject(projectId))) return;
      await vaultRef.current.patchTerminalSession({
        id: `terminal-${projectId}`,
        projectId,
        title: 'Main terminal',
        cwd: SITE_ROOT,
        scrollback: redactCodingSecrets(scrollback),
      });
    } catch (error) {
      if (!invalidatedProjectIdsRef.current.has(projectId)) {
        console.error('[vault] terminal transition save failed', error);
      }
    }
  };

  const transitionProject = (
    project: VaultProject,
    activatePersistedProject: boolean,
  ): Promise<void> => {
    startupHydrationInvalidatedRef.current = true;
    const previousProjectId = activeProject.id;
    const mountedCandidate = backend ?? workspaceLeaseRef.current?.backend ?? null;
    const mountedBackend =
      mountedCandidate && !mountedCandidate.isDisposed()
        ? mountedCandidate
        : null;
    const terminalScrollback = terminalRef.current.slice(-100_000);
    const generation = projectTransitionGenerationRef.current + 1;
    projectTransitionGenerationRef.current = generation;
    abortActiveOperations();
    const previous = projectTransitionChainRef.current.catch(() => undefined);
    const transition = previous.then(async () => {
      if (generation !== projectTransitionGenerationRef.current) return;
      await persistTerminalScrollback(previousProjectId, terminalScrollback);
      if (generation !== projectTransitionGenerationRef.current) return;
      if (mountedBackend && !mountedBackend.isDisposed()) {
        try {
          await saveVaultCheckpoint(mountedBackend, 'before-reset');
        } catch {
          // A required final checkpoint failed. Keep every visible surface on
          // the current project so the user can inspect and retry safely —
          // but restore interactivity: the build was already aborted above
          // and its own finally lost ownership of the controller, so nothing
          // else will ever clear these flags.
          setBuilding(false);
          setStopping(false);
          setStoppingOperation(null);
          setNetworkRetrying(false);
          return;
        }
      }
      if (generation !== projectTransitionGenerationRef.current) return;
      if (mountedBackend) {
        await disposeWorkspaceRuntime(mountedBackend).catch(() => undefined);
        if (generation !== projectTransitionGenerationRef.current) return;
        setBackend((current) =>
          current === mountedBackend ? null : current,
        );
        setVmStatus(INITIAL_STATUS);
      }
      clearProjectScopedRuntimeState();
      setActiveProject(project);
      activeProjectIdRef.current = project.id;
      setDraft(project.prompt);
      setFiles([]);
      setEvents([]);
      setSourceDirectory(null);
      setSourceDirectoryName('');
      setConversations([]);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      setHasStarted(false);
      setReady(false);
      setBuilding(false);
      setNetworkRetrying(false);
      setStopping(false);
      setStoppingOperation(null);
      tailnetReadyLoggedRef.current = null;
      if (!activatePersistedProject) return;
      await ensureVaultReady();
      if (generation !== projectTransitionGenerationRef.current) return;
      await vaultRef.current.activateProject(project.id);
      if (generation !== projectTransitionGenerationRef.current) return;
      const [vaultProject, nextConversations] = await Promise.all([
        vaultRef.current.getProject(project.id),
        vaultRef.current.listConversations(project.id),
      ]);
      if (generation !== projectTransitionGenerationRef.current) return;
      setConversations(nextConversations);
      const selectedId =
        vaultProject?.activeConversationId ?? nextConversations[0]?.id ?? null;
      activeConversationIdRef.current = selectedId;
      setActiveConversationId(selectedId);
      if (selectedId) {
        const storedEvents =
          await vaultRef.current.listConversationEvents(selectedId);
        if (generation !== projectTransitionGenerationRef.current) return;
        const restoredEvents = storedEvents
          .map(logEventFromVault)
          .filter((event): event is LogEvent => event !== null);
        setEvents(restoredEvents.slice(-200));
        setHasStarted(restoredEvents.length > 0);
      }
    });
    projectTransitionChainRef.current = transition.catch(() => undefined);
    return transition;
  };

  const newProject = (): Promise<void> =>
    transitionProject(
      createVaultProjectDraft({
        name: 'Untitled site',
        prompt: DEFAULT_PROMPT,
      }),
      false,
    );

  const selectProject = (project: VaultProject): Promise<void> =>
    transitionProject(project, true);

  const newConversation = async () => {
    startupHydrationInvalidatedRef.current = true;
    await ensureVaultReady();
    let project = await vaultRef.current.getProject(activeProject.id);
    if (!project) {
      project = await vaultRef.current.createProject({
        id: activeProject.id,
        name: activeProject.name,
        prompt: activeProject.prompt,
      });
    }
    const conversation = await vaultRef.current.createConversation({
      projectId: project.id,
      title: 'New conversation',
      model,
    });
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setConversations(await vaultRef.current.listConversations(project.id));
    setEvents([]);
    setDraft('');
    setHasStarted(false);
    setErrorMessage(null);
  };

  const selectConversation = async (conversation: VaultConversation) => {
    startupHydrationInvalidatedRef.current = true;
    if (
      building ||
      networkRetrying ||
      conversation.id === activeConversationIdRef.current
    ) {
      return;
    }
    await ensureVaultReady();
    const storedEvents = await vaultRef.current.listConversationEvents(
      conversation.id,
    );
    const restoredEvents = storedEvents
      .map(logEventFromVault)
      .filter((event): event is LogEvent => event !== null);
    activeConversationIdRef.current = conversation.id;
    setActiveConversationId(conversation.id);
    setEvents(restoredEvents.slice(-200));
    setHasStarted(restoredEvents.length > 0);
    setDraft('');
    setErrorMessage(null);
    await vaultRef.current.setActiveConversation(
      activeProject.id,
      conversation.id,
    );
  };

  const removeProject = async (projectId: string) => {
    startupHydrationInvalidatedRef.current = true;
    const projectName =
      projects.find((project) => project.id === projectId)?.name ??
      (activeProject.id === projectId ? activeProject.name : 'this project');
    if (
      !window.confirm(
        `Delete “${projectName}” and all of its Browser Vault checkpoints, conversations, and terminal history? This cannot be undone.`,
      )
    ) {
      return;
    }
    projectTransitionGenerationRef.current += 1;
    let terminalSave = Promise.resolve();
    if (activeProject.id === projectId) {
      abortActiveOperations();
      setBuilding(false);
      setNetworkRetrying(false);
      conversationEnsureRef.current = null;
      const terminalScrollback = clearProjectScopedRuntimeState();
      terminalSave = persistTerminalScrollback(projectId, terminalScrollback, {
        allowInvalidated: true,
      });
      checkpointChainRef.current = Promise.resolve();
    }
    invalidatedProjectIdsRef.current.add(projectId);
    await terminalSave;
    if (activeProject.id === projectId) {
      if (backend) {
        await disposeWorkspaceRuntime(backend).catch(() => undefined);
        setBackend(null);
      }
      setVmStatus(INITIAL_STATUS);
    }
    try {
      await ensureVaultReady();
      await vaultRef.current.deleteProject(projectId);
    } catch (error) {
      invalidatedProjectIdsRef.current.delete(projectId);
      console.error('[vault] could not remove project', error);
      setErrorMessage(
        `Could not delete ${projectName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (activeProject.id === projectId) {
      const project = createVaultProjectDraft({
        name: 'Untitled site',
        prompt: DEFAULT_PROMPT,
      });
      setActiveProject(project);
      activeProjectIdRef.current = project.id;
      setDraft(project.prompt);
      setFiles([]);
      setEvents([]);
      setTerminal('');
      setDebugLog('');
      setTerminalCommand('');
      setSourceDirectory(null);
      setSourceDirectoryName('');
      setConversations([]);
      setActiveConversationId(null);
      activeConversationIdRef.current = null;
      setHasStarted(false);
      setReady(false);
      setBuilding(false);
      setNetworkRetrying(false);
      setStopping(false);
      setStoppingOperation(null);
      setErrorMessage(null);
      setCheckpointState('idle');
      setShowFiles(false);
      setShowLogs(false);
      setShowTerminal(false);
      tailnetReadyLoggedRef.current = null;
    }
    setProjects(await vaultRef.current.listProjects());
  };

  const attachSourceFolder = async () => {
    if (!localFolderSupported) {
      return;
    }
    try {
      const handle = await pickSourceDirectory();
      await ensureVaultReady();
      const project = await vaultRef.current.createProject({
        id: activeProject.id,
        name: activeProject.name,
        prompt: activeProject.prompt,
      });
      await vaultRef.current.putSetting(
        projectSourceDirectorySettingKey(project.id),
        handle,
      );
      setProjects(await vaultRef.current.listProjects());
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
    await ensureVaultReady();
    await vaultRef.current.deleteSetting(
      projectSourceDirectorySettingKey(activeProject.id),
    );
    setSourceDirectory(null);
    setSourceDirectoryName('');
  };

  const syncSourceToFolder = async (
    sourceFiles: SourceFile[],
    directory: FileSystemDirectoryHandle,
  ) => {
    try {
      if (sourceFiles.length === 0) return;
      await writeSourceFiles(directory, sourceFiles);
    } catch (error) {
      appendEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const saveVaultCheckpoint = async (
    vm: WorkspaceRuntime | null,
    reason: 'agent-tool' | 'terminal-command' | 'manual' | 'before-reset',
    options: { allowQuiescing?: boolean } = {},
  ): Promise<boolean> => {
    if (
      vm &&
      (vm.isDisposed() ||
        (quiescingBackendsRef.current.has(vm) && !options.allowQuiescing))
    ) {
      // Stop closes checkpoint admission synchronously before abort listeners
      // can persist late agent or terminal state. Work already admitted remains
      // on checkpointChainRef and is still drained before disposal.
      if (reason === 'agent-tool' || reason === 'terminal-command') {
        return false;
      }
      throw new Error('The VM is stopping or has already stopped.');
    }
    const projectAtRequest = {
      id: activeProject.id,
      name: activeProject.name,
      prompt: activeProject.prompt,
    };
    if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
      return false;
    }
    const previous = checkpointChainRef.current.catch(() => undefined);
    const checkpointTask = previous.then(async () => {
      if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
        return false;
      }
      if (activeProjectIdRef.current === projectAtRequest.id) {
        if (checkpointStateTimerRef.current !== null) {
          window.clearTimeout(checkpointStateTimerRef.current);
          checkpointStateTimerRef.current = null;
        }
        setCheckpointState('saving');
      }
      try {
        await ensureVaultReady();
        if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
          return false;
        }
        let project = await vaultRef.current.getProject(projectAtRequest.id);
        if (!project) {
          project = await vaultRef.current.createProject(projectAtRequest);
        }

        if (!vm) {
          throw new Error(
            'A running VM with tar snapshot support is required to save a workspace checkpoint.',
          );
        }

        let committedCheckpointId: string | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
            return false;
          }
          const latest = await vaultRef.current.getProject(projectAtRequest.id);
          await vm.writeText(
            VAULT_HEAD_MARKER,
            latest?.headCheckpointId ?? '',
          );
          // A conflict means another tab or queued save advanced the head.
          // Recapture the live workspace after reading that new head; replaying
          // the old archive could otherwise roll a newer checkpoint backward.
          const archive = await vm.createWorkspaceArchive();
          if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
            return false;
          }
          try {
            const committed = await vaultRef.current.commitCheckpoint({
              projectId: projectAtRequest.id,
              archive,
              reason,
              expectedParentId: latest?.headCheckpointId ?? null,
            });
            committedCheckpointId = committed.id;
            break;
          } catch (error) {
            const isCheckpointRace =
              error instanceof Error &&
              error.message.includes('Checkpoint conflict');
            if (!isCheckpointRace || attempt === 2) throw error;
          }
        }
        if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
          return false;
        }
        if (committedCheckpointId) {
          try {
            await vm.writeText(VAULT_HEAD_MARKER, committedCheckpointId);
          } catch (error) {
            // The archive and Browser Vault head are already durable, but the
            // live cache cannot be trusted across reloads unless it carries
            // that exact lineage. Never report a fully successful snapshot in
            // this state: the next boot will deliberately restore the archive
            // and could otherwise discard later, uncheckpointed cache edits.
            throw new Error(
              'The recovery snapshot was committed, but SparkRun could not mark the live VM cache with its new lineage. Restart the VM from the committed snapshot before making more changes.',
              { cause: error },
            );
          }
        }
        await vaultRef.current.pruneCheckpoints(projectAtRequest.id, 12);
        if (
          reason === 'agent-tool' ||
          reason === 'terminal-command' ||
          reason === 'manual'
        ) {
          // Terminal commands can add or remove files without going through
          // an agent tool. A committed checkpoint is the natural consistency
          // boundary for refreshing the visible Files surface; otherwise the
          // vault is correct while the badge/list stays stale until reboot.
          // Keep this scan outside the durability barrier: a UI refresh must
          // not lengthen Stop or turn a committed snapshot into a false error.
          void loadFiles(vm, projectAtRequest.id).catch((error) => {
            if (
              componentActiveRef.current &&
              activeProjectIdRef.current === projectAtRequest.id &&
              workspaceLeaseRef.current?.backend === vm &&
              !vm.isDisposed() &&
              !quiescingBackendsRef.current.has(vm)
            ) {
              console.warn('[workspace] file list refresh failed', error);
            }
          });
        }
        if (
          !invalidatedProjectIdsRef.current.has(projectAtRequest.id) &&
          activeProjectIdRef.current === projectAtRequest.id
        ) {
          setCheckpointState('saved');
          const resetTimer = window.setTimeout(() => {
            if (checkpointStateTimerRef.current === resetTimer) {
              checkpointStateTimerRef.current = null;
            }
            if (
              !invalidatedProjectIdsRef.current.has(projectAtRequest.id) &&
              activeProjectIdRef.current === projectAtRequest.id
            ) {
              setCheckpointState('idle');
            }
          }, 1_800);
          checkpointStateTimerRef.current = resetTimer;
        }
        try {
          setStorageDurability(await requestDurableBrowserStorage());
        } catch {
          // The checkpoint itself is already safely committed.
        }
        return Boolean(committedCheckpointId);
      } catch (error) {
        if (invalidatedProjectIdsRef.current.has(projectAtRequest.id)) {
          return false;
        }
        console.error('[vault] checkpoint failed', error);
        if (activeProjectIdRef.current === projectAtRequest.id) {
          setCheckpointState('error');
          appendEvent({
            kind: 'error',
            label: 'Snapshot failed',
            text: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    });
    checkpointChainRef.current = checkpointTask.then(
      () => undefined,
      () => undefined,
    );
    return checkpointTask;
  };

  const probePreservedWorkspace = async (
    vm: WorkspaceRuntime,
    lineage: string,
  ): Promise<void> => {
    try {
      // Rewriting the lineage marker exercises the same staged copy path used
      // by normal file tools without deleting a proven cache or creating a
      // disposable probe inode. Equality proves ancestry, not byte identity:
      // the preserved tree may contain newer work that has not checkpointed.
      await vm.writeText(VAULT_HEAD_MARKER, lineage);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `SparkRun preserved this project's VM workspace but could not verify that it is writable. The cache was left untouched. Open Setup and use Reset workspace to rebuild it from the latest Browser Vault checkpoint. If this project has no checkpoint yet, resetting will discard the inaccessible cache. ${detail}`,
      );
    }
  };

  const restoreVerifiedVaultCheckpoint = async (
    vm: WorkspaceRuntime,
    projectBeforeRestore: VaultProject,
    checkpoint: VaultCheckpoint,
    skippedCorrupt: number,
  ): Promise<void> => {
    await vm.restoreWorkspaceArchive(checkpoint.archive);
    await vm.writeText(VAULT_HEAD_MARKER, checkpoint.id);
    const rolledBackProviderState =
      skippedCorrupt > 0 ||
      (Boolean(projectBeforeRestore?.headCheckpointId) &&
        projectBeforeRestore?.headCheckpointId !== checkpoint.id);
    if (rolledBackProviderState) {
      await vaultRef.current.invalidateProjectProviderContinuations(
        projectBeforeRestore.id,
      );
    }
    appendEvent({
      kind: 'status',
      label: 'Workspace recovered',
      text: `Restored checkpoint ${checkpoint.id.slice(-12)} from the independent browser vault.${
        skippedCorrupt > 0
          ? ` Skipped ${skippedCorrupt} corrupt newer checkpoint${
              skippedCorrupt === 1 ? '' : 's'
            }.`
          : ''
      }${
        rolledBackProviderState
          ? ' Provider continuation state was reset so the coding agent will rebuild context from the verified files and transcript.'
          : ''
      }`,
    });
  };

  const reconcileWorkspaceAtBoot = async (
    vm: WorkspaceRuntime,
    project: VaultProject,
  ): Promise<void> => {
    // Validate Browser Vault bytes before trusting either the recorded head or
    // the live cache marker. This can return a verified parent when a newer
    // checkpoint was interrupted or corrupted.
    const recovery = await vaultRef.current.getRestorableCheckpoint(project.id);
    const checkpoint = recovery.checkpoint;

    if (!checkpoint) {
      // With no independent recovery archive, the per-project cache is the only
      // possible copy. Preserve it and prove the write path without silently
      // cleaning even when the Vault contains only unusable checkpoint rows.
      await probePreservedWorkspace(vm, '');
      return;
    }

    const cachedLineage = await vm
      .readText(VAULT_HEAD_MARKER)
      .then((value) => value.trim())
      .catch(() => null);
    if (
      recovery.skippedCorrupt === 0 &&
      cachedLineage === checkpoint.id
    ) {
      await probePreservedWorkspace(vm, checkpoint.id);
      return;
    }

    // A missing/mismatched marker has no trustworthy relationship to the
    // verified Vault head. A corrupt-head fallback is also an explicit
    // rollback. Recreate the workspace inode before restoring so the known
    // CheerpX phantom-inode/EROFS state cannot poison the recovered copy.
    await vm.resetWorkspace();
    const projectBeforeRestore =
      (await vaultRef.current.getProject(project.id)) ?? project;
    await restoreVerifiedVaultCheckpoint(
      vm,
      projectBeforeRestore,
      checkpoint,
      recovery.skippedCorrupt,
    );
  };

  const snapshotNow = async () => {
    if (
      !backend ||
      building ||
      networkRetrying ||
      backend.isDisposed() ||
      quiescingBackendsRef.current.has(backend)
    ) {
      appendEvent({
        kind: 'error',
        label: 'Snapshot unavailable',
        text: building || networkRetrying
          ? 'Wait for the active operation to stop before taking a manual snapshot.'
          : 'Start the VM before taking a workspace snapshot.',
      });
      return;
    }
    try {
      await saveVaultCheckpoint(backend, 'manual');
    } catch {
      return;
    }
    appendEvent({
      kind: 'status',
      label: 'Snapshot',
      text: 'Committed a recovery snapshot to the browser vault.',
    });
  };

  const resetWorkspaceCaches = async (
    includeDiskCache: boolean,
  ): Promise<void> => {
    const projectAtReset = activeProject;
    const mountedBackend = backend;

    // Freeze agent activity before capturing the final recoverable state. The
    // VM remains mounted until checkpointing has either succeeded or the user
    // has explicitly accepted permanent loss of uncommitted changes.
    abortActiveOperations();
    setBuilding(false);
    setNetworkRetrying(false);
    if (mountedBackend) {
      if (!mountedBackend.isDisposed()) {
        try {
          await saveVaultCheckpoint(mountedBackend, 'before-reset');
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const discardUncommitted = window.confirm(
            `SparkRun could not save a final Browser Vault checkpoint: ${detail}\n\nContinuing will permanently lose all uncommitted changes in the live VM workspace. Continue with the reset anyway?`,
          );
          if (!discardUncommitted) {
            return;
          }
        }
      }

      // Disposing releases CheerpX's IndexedDB mounts. Deleting either cache
      // before this resolves can leave a blocked or half-deleted database.
      await disposeWorkspaceRuntime(mountedBackend);
      setBackend((current) => (current === mountedBackend ? null : current));
      setVmStatus(INITIAL_STATUS);
    }

    await hardResetSparkrunCaches({
      includeDiskCache,
      workspaceDbName: projectAtReset.workspaceDbName,
      rootCacheDbName: rootCacheDatabaseName(projectAtReset.environmentId),
    });
    browserPageLifecycle.reload();
  };

  const restartVmNow = async () => {
    const fatalNetworkFailureNow =
      backend?.getFatalNetworkFailure?.() ??
      getFatalTailnetRuntimeFailure();
    if (fatalNetworkFailureNow) {
      if (fatalNetworkReloadInFlightRef.current) return;
      fatalNetworkReloadInFlightRef.current = true;
      const mountedCandidate =
        backend ?? workspaceLeaseRef.current?.backend ?? null;
      const mountedBackend =
        mountedCandidate && !mountedCandidate.isDisposed()
          ? mountedCandidate
          : null;
      const interruptedOperation: ActiveOperation | null =
        networkRetryAbortControllerRef.current
          ? 'tailnet'
          : buildAbortControllerRef.current
            ? 'coding'
            : null;
      let proceedingToReload = false;
      try {
        appendEvent({
          kind: 'status',
          label: 'Reloading network runtime',
          text: 'Stopping active work, saving the workspace, then reloading the page to reconstruct CheerpX networking.',
        });
        if (interruptedOperation) {
          setStoppingOperation(interruptedOperation);
          setStopping(true);
        }
        if (mountedBackend) {
          // Close late terminal/agent checkpoint admission before abort
          // callbacks run. The one explicit recovery snapshot below is the
          // only operation allowed through this quiescing boundary.
          quiescingBackendsRef.current.add(mountedBackend);
        }
        abortActiveOperations();
        setBuilding(false);
        setNetworkRetrying(false);
        setReady(false);
        for (const timerId of terminalCheckpointTimersRef.current) {
          window.clearTimeout(timerId);
        }
        terminalCheckpointTimersRef.current.clear();
        if (rawTerminalCheckpointTimerRef.current !== null) {
          window.clearTimeout(rawTerminalCheckpointTimerRef.current);
          rawTerminalCheckpointTimerRef.current = null;
        }
        await checkpointChainRef.current.catch(() => undefined);
        if (mountedBackend && !mountedBackend.isDisposed()) {
          try {
            await saveVaultCheckpoint(mountedBackend, 'before-reset', {
              allowQuiescing: true,
            });
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            const discardUncommitted = window.confirm(
              `SparkRun could not save a final Browser Vault checkpoint: ${detail}\n\nReloading is required to repair networking, but continuing may lose uncommitted workspace changes. Reload anyway?`,
            );
            if (!discardUncommitted) {
              appendEvent({
                kind: 'error',
                label: 'Network reload paused',
                text: 'The page was not reloaded because the final workspace checkpoint failed.',
              });
              return;
            }
          }
          await disposeWorkspaceRuntime(mountedBackend);
        }
        proceedingToReload = true;
        browserPageLifecycle.reload();
        return;
      } catch (error) {
        appendEvent({
          kind: 'error',
          label: 'Network reload failed',
          text: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        if (!proceedingToReload) {
          if (mountedBackend) {
            quiescingBackendsRef.current.delete(mountedBackend);
          }
          setStopping(false);
          setStoppingOperation(null);
          fatalNetworkReloadInFlightRef.current = false;
        }
      }
    }
    if (building || networkRetrying) return;
    try {
      await bootVm();
      appendEvent({
        kind: 'status',
        label: 'VM restarted',
        text: 'The VM restarted from the latest durable workspace state.',
      });
    } catch (error) {
      appendEvent({
        kind: 'error',
        label: 'VM restart failed',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const bootVm = async (signal?: AbortSignal): Promise<WorkspaceRuntime> => {
    // Serialize VM boots. Stop+Build in quick succession can leave the previous
    // (now aborted) build still inside WebVmBackend.create — which is not
    // abortable — and two creates racing the same persistent workspace IndexedDB
    // risks corruption. Wait for any prior boot's critical section to finish.
    const priorBoot = vmBootChainRef.current;
    let releaseBoot: () => void = () => undefined;
    vmBootChainRef.current = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    vmBootInFlightRef.current += 1;
    try {
      await priorBoot.catch(() => undefined);
      await backendResetChainRef.current.catch(() => undefined);
      return await bootVmCritical(signal);
    } finally {
      vmBootInFlightRef.current -= 1;
      releaseBoot();
    }
  };

  const bootVmCritical = async (
    signal?: AbortSignal,
  ): Promise<WorkspaceRuntime> => {
    // Reuse a healthy VM that already owns this project's workspace lease.
    // Rebooting on every prompt made each follow-up request pay a full
    // checkpoint + CheerpX teardown + boot + reconcile before the first
    // model call, and killed any running preview with it.
    const activeLease = workspaceLeaseRef.current;
    // The lease is the synchronous source of truth: a VM booted moments ago
    // (auto-boot on workbench entry) may not be committed to React state yet
    // when the user presses Build.
    const mountedBackend = backend ?? activeLease?.backend ?? null;
    const currentTailscaleKey = tailscaleAuthKey.trim();
    if (
      mountedBackend &&
      !mountedBackend.isDisposed() &&
      activeLease?.backend === mountedBackend &&
      activeLease.projectId === activeProject.id &&
      !mountedBackend.getFatalNetworkFailure?.() &&
      bootedTailscaleKeyRef.current === currentTailscaleKey
    ) {
      // Same superseded guard as the fresh-boot path: an aborted or
      // project-switched build must not sail through here and keep running
      // against the reused VM.
      if (
        signal?.aborted ||
        !componentActiveRef.current ||
        activeProjectIdRef.current !== activeProject.id
      ) {
        const abortError = new Error('VM boot was superseded.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      appendEvent({
        kind: 'status',
        label: 'VM ready',
        text: 'Reusing the running VM and workspace.',
      });
      if (!backend) setBackend(mountedBackend);
      return mountedBackend;
    }
    const throwIfBootSuperseded = () => {
      if (
        signal?.aborted ||
        !componentActiveRef.current ||
        activeProjectIdRef.current !== activeProject.id
      ) {
        const abortError = new Error('VM boot was superseded.');
        abortError.name = 'AbortError';
        throw abortError;
      }
    };
    throwIfBootSuperseded();
    if (mountedBackend) {
      if (!mountedBackend.isDisposed()) {
        appendEvent({
          kind: 'status',
          label: 'Restarting VM',
          text:
            bootedTailscaleKeyRef.current !== currentTailscaleKey
              ? 'The Tailscale key changed; checkpointing the workspace and restarting the VM with it.'
              : 'Checkpointing the workspace before restarting the VM.',
        });
        await saveVaultCheckpoint(mountedBackend, 'before-reset');
      } else {
        appendEvent({
          kind: 'status',
          label: 'Restarting VM',
          text: 'The previous VM stopped after a failed command proof; starting a fresh VM from the durable workspace.',
        });
      }
      await disposeWorkspaceRuntime(mountedBackend);
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

    let vmDuringBoot: WorkspaceRuntime | null = null;
    let leaseDuringBoot: WorkspaceLease | null = null;
    try {
      await ensureVaultReady();
      let vaultProject = await vaultRef.current.getProject(activeProject.id);
      if (!vaultProject) {
        vaultProject = await vaultRef.current.createProject({
          id: activeProject.id,
          name: activeProject.name,
          prompt: activeProject.prompt,
        });
      }
      const projectIdAtBoot = vaultProject.id;
      throwIfBootSuperseded();
      const acquiredLease = await acquireWorkspaceLease(projectIdAtBoot);
      leaseDuringBoot = acquiredLease;
      bootedTailscaleKeyRef.current = currentTailscaleKey;
      const vm = await WebVmBackend.create({
        tailscaleAuthKey: currentTailscaleKey || undefined,
        workspaceDbName: vaultProject.workspaceDbName,
        rootCacheDbName: rootCacheDatabaseName(vaultProject.environmentId),
        diskProfile: DEFAULT_WEBVM_DISK_PROFILE,
        prepareWorkspace: 'preserve',
        onConsole: (text) => {
          if (activeProjectIdRef.current === projectIdAtBoot) {
            appendTerminal(text);
          }
        },
        onDebug: (entry) => {
          if (activeProjectIdRef.current === projectIdAtBoot) {
            appendDebug(entry);
          }
        },
        onStatus: (status) => {
          if (activeProjectIdRef.current !== projectIdAtBoot) return;
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
              }. Waiting for server readiness before opening.`,
            });
          }
        },
      });
      vmDuringBoot = vm;
      workspaceLeaseRef.current = {
        projectId: projectIdAtBoot,
        backend: vm,
        lease: acquiredLease,
      };
      await reconcileWorkspaceAtBoot(vm, vaultProject);
      if (
        signal?.aborted ||
        !componentActiveRef.current ||
        activeProjectIdRef.current !== projectIdAtBoot
      ) {
        // This build was stopped while the VM was booting. Don't commit it as
        // the active backend (a newer build may already own one); tear it down.
        const abortError = new Error('VM boot was superseded.');
        abortError.name = 'AbortError';
        throw abortError;
      }
      setBackend(vm);
      await loadFiles(vm);
      return vm;
    } catch (error) {
      if (vmDuringBoot) {
        await disposeWorkspaceRuntime(vmDuringBoot).catch(() => undefined);
        setBackend((current) =>
          current === vmDuringBoot ? null : current,
        );
      } else if (leaseDuringBoot) {
        await leaseDuringBoot.release().catch(() => undefined);
      }
      if (isAbortError(error)) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      setVmStatus({
        lifecycle: 'error',
        message,
        tailnetIp: null,
        loginUrl: null,
        previewUrl: null,
        serverPort: null,
      });
      throw error;
    }
  };

  const send = async () => {
    if (
      building ||
      networkRetrying ||
      networkRetryAbortControllerRef.current ||
      sendInFlightRef.current
    ) {
      return;
    }
    const trimmedDraft = draft.trim();
    if (!trimmedDraft) return;
    const buildPrompt = trimmedDraft;

    const trimmedApiKey = apiKey.trim();
    const apiKeyError = validateGoogleApiKey(trimmedApiKey);
    if (apiKeyError) {
      setErrorMessage(
        trimmedApiKey
          ? apiKeyError
          : 'Google AI key is required before building.',
      );
      return;
    }
    startupHydrationInvalidatedRef.current = true;
    sendInFlightRef.current = true;
    setErrorMessage(null);
    let conversation: VaultConversation;
    try {
      conversation = await ensureActiveConversation(buildPrompt);
      if (conversation.title === 'New conversation') {
        conversation = await vaultRef.current.renameConversation(
          conversation.id,
          redactCodingSecrets(buildPrompt).trim().slice(0, 72) ||
            'New conversation',
        );
        await refreshConversations(conversation.projectId);
      }
    } catch (error) {
      sendInFlightRef.current = false;
      const message = error instanceof Error ? error.message : String(error);
      setErrorMessage(message);
      appendEvent({
        kind: 'error',
        label: 'Could not start request',
        text: message,
      });
      return;
    }
    if (
      !componentActiveRef.current ||
      activeProjectIdRef.current !== conversation.projectId
    ) {
      sendInFlightRef.current = false;
      return;
    }

    setHasStarted(true);
    setBuilding(true);
    setReady(false);
    // Keep VM diagnostics across builds: the VM now boots before the first
    // prompt, and its boot log is part of what a failed run needs to show.
    tailnetReadyLoggedRef.current = null;
    buildAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    buildAbortControllerRef.current = abortController;
    // Every event this run produces is pinned to the conversation that
    // started it. Late callbacks (harness status, cancellation
    // reconciliation) then persist to the right conversation instead of
    // leaking into whichever one the user has since opened.
    const runOrigin = {
      projectId: conversation.projectId,
      conversationId: conversation.id,
    };
    const appendRunEvent = (event: Omit<LogEvent, 'id' | 'time'>) =>
      appendEvent(event, runOrigin);
    appendRunEvent({ kind: 'chat', text: buildPrompt });
    setDraft('');

    const ensureNotAborted = () => {
      if (abortController.signal.aborted) {
        const abortError = new Error('Website generation was stopped.');
        abortError.name = 'AbortError';
        throw abortError;
      }
    };

    // Re-grant local-folder write permission now, while the Build click still
    // provides the transient user activation that requestPermission() requires.
    // Doing it later (during the post-build sync) on a handle restored from
    // IndexedDB would fail with a SecurityError on every run after a reload.
    if (sourceDirectory) {
      try {
        await ensureDirectoryWritePermission(sourceDirectory);
      } catch (error) {
        appendRunEvent({
          kind: 'status',
          label: 'Folder sync',
          text: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let runVm: WorkspaceRuntime | null = null;
    try {
      const vm = await bootVm(abortController.signal);
      runVm = vm;
      // Tailnet activation is deferred until after agent writes complete.
      // On some machines, activating CheerpX's userspace Tailscale flips the
      // workspace IDB mount to read-only, which would break every cp from
      // the agent. We let writes finish on a clean (no-Tailnet) workspace,
      // then startServer() activates Tailnet right before launching python.

      appendRunEvent({
        kind: 'status',
        label: 'Gemini',
        text: `Building with ${model}`,
      });

      let agentFinalText = '';
      const storedConversation = await vaultRef.current.getConversation(
        conversation.id,
      );
      const priorSession: CodingHarnessSession | null =
        storedConversation?.harnessSession ?? null;
      let checkpointedToolTranscriptLength =
        priorSession?.transcript.at(-1)?.kind === 'tool-result'
          ? priorSession.transcript.length
          : 0;
      // Keep the provider SDK out of the startup bundle. It is only needed
      // once the user actually launches a coding turn.
      const { GeminiInteractionsCodingHarness } = await import(
        './lib/geminiCodingHarness'
      );
      const harness = new GeminiInteractionsCodingHarness({
        apiKey: trimmedApiKey,
        model,
        environmentInstruction: DEFAULT_WEBVM_DISK_PROFILE.agentEnvironmentNotes,
      });
      const result = await harness.run({
        prompt: buildPrompt,
        runtime: vm,
        session: priorSession,
        abortSignal: abortController.signal,
        onSession: async (session) => {
          const lastEntry = session.transcript.at(-1);
          const hasNewToolResult =
            lastEntry?.kind === 'tool-result' &&
            session.transcript.length > checkpointedToolTranscriptLength;
          // Pure inspections (read_file/list_directory) cannot have changed
          // the workspace, so they don't justify archiving it; per-result
          // archives dominated run time once a project grew dependencies.
          // Any other (or unknown) tool is conservatively treated as
          // mutating.
          const canHaveMutatedWorkspace = !(
            lastEntry?.toolName === CODING_READ_FILE_TOOL ||
            lastEntry?.toolName === CODING_LIST_DIRECTORY_TOOL
          );
          if (hasNewToolResult && !canHaveMutatedWorkspace) {
            checkpointedToolTranscriptLength = session.transcript.length;
          }
          if (hasNewToolResult && canHaveMutatedWorkspace) {
            // Register the workspace checkpoint on its serialized chain before
            // this callback's first await. Stop can then see and drain it even
            // while Browser Vault persistence is still in flight. Persist the
            // transcript only after that admission commits: a late callback
            // after Stop must never claim a tool result whose workspace was
            // rolled back to the last durable checkpoint.
            const checkpoint = saveVaultCheckpoint(vm, 'agent-tool');
            const admitted = await checkpoint;
            if (!admitted) return;
            checkpointedToolTranscriptLength = session.transcript.length;
          }
          await vaultRef.current.saveConversationHarnessSession(
            conversation.id,
            session,
          );
        },
        onEvent: (event: CodingHarnessEvent) => {
          if (event.type === 'model') {
            return;
          }
          if (event.type === 'done') {
            agentFinalText = event.message;
            return;
          }
          const logEvent = eventFromAgentEvent(event);
          if (logEvent) {
            appendRunEvent(logEvent);
          }
        },
      });
      await refreshConversations(activeProject.id);

      // Stop pressed during/after the agent run: bail before the server start,
      // health checks, folder sync, and project save run — otherwise a build the
      // user already stopped would flip to "live" and overwrite the saved
      // project with its results.
      ensureNotAborted();

      let url = vm.getPreviewUrl();
      let previewAttempted = Boolean(url);
      let serverHealthy = false;

      // start_preview is the primary path for Vite, Node, Python, and other
      // real development servers. A plain index.html still receives a safe
      // static fallback so the zero-config creation experience remains solid.
      if (!url) {
        const rootEntries = await vm.listDirectory('');
        const hasStaticEntry = rootEntries.some(
          (entry) => entry.type === 'file' && entry.path === 'index.html',
        );
        if (hasStaticEntry) {
          previewAttempted = true;
          appendRunEvent({
            kind: 'status',
            label: 'Static preview',
            text: 'No managed preview was running, so SparkRun is starting the built-in static server.',
          });
          const startResult = await vm.startDefaultPreview();
          if (startResult.status !== 0) {
            appendRunEvent({
              kind: 'error',
              label: 'Preview start failed',
              text:
                cleanStatusOutput(startResult.output) ||
                `Preview command exited with ${startResult.status}`,
            });
          }
          url = vm.getPreviewUrl();
        }
      }

      if (previewAttempted) {
        const health = await vm.checkPreview();
        serverHealthy = health.status === 0;
        appendRunEvent({
          kind: serverHealthy ? 'status' : 'error',
          label: serverHealthy ? 'Server ready' : 'Server failed',
          text:
            cleanStatusOutput(health.output) ||
            `Readiness check exited with ${health.status}`,
        });
      }

      if (previewAttempted && serverHealthy && !url) {
        appendRunEvent({
          kind: 'status',
          label: 'Tailnet',
          text: 'Waiting for the VM Tailnet IP before exposing the server URL.',
        });
        url = await waitForPreviewUrl(vm, 45_000, abortController.signal);
      }
      await loadFiles(vm);
      if (sourceDirectory) {
        const sourceFiles = await collectSourceFiles(vm);
        await syncSourceToFolder(sourceFiles, sourceDirectory);
      }

      // The health/preview phase has several long awaits (waitForPreviewUrl
      // alone is up to 45s). If Stop was pressed during them, don't mark the
      // build live or overwrite the saved project.
      ensureNotAborted();

      const finalText = formatFinalSummary(
        result.finalText || agentFinalText || 'Coding task finished.',
        url,
      );
      if (url && serverHealthy) {
        appendRunEvent({
          kind: 'ready',
          text: `**Server is ready at:** ${url}\n\nOpen the URL in Chrome to prove the outer-browser connection.\n\n${finalText}`,
        });
        setReady(true);
      } else if (!previewAttempted) {
        appendRunEvent({
          kind: 'ready',
          label: 'Complete',
          text: `**Task complete.**\n\n${finalText}`,
        });
      } else {
        appendRunEvent({
          kind: 'error',
          label: !serverHealthy ? 'Preview unavailable' : 'Tailnet unavailable',
          text: !serverHealthy
            ? `The coding task finished, but its preview process is not healthy.\n\n${finalText}`
            : `The preview process is running but no Tailnet URL is available yet.\n\n${finalText}`,
        });
      }

      await saveActiveProject(
        { prompt: buildPrompt },
        { requireExisting: true },
      );
      ensureNotAborted();
      await saveVaultCheckpoint(vm, 'agent-tool');

      if (result.reachedTurnBudget) {
        appendRunEvent({
          kind: 'status',
          label: 'Turn budget reached',
          text: 'Agent hit the turn budget. Send a new prompt to keep iterating.',
        });
      }

    } catch (error) {
      const aborted = abortController.signal.aborted || isAbortError(error);
      const ownsCurrentRun =
        buildAbortControllerRef.current === abortController;
      if (aborted) {
        if (ownsCurrentRun) {
          // Preserve the stopped request as a ready-to-edit retry. If the user
          // already typed a replacement while the run was stopping, keep it.
          setDraft((current) => (current.trim() ? current : buildPrompt));
          appendRunEvent({
            kind: 'status',
            label: 'Stopped',
            text: 'The active request and VM process tree stopped. Send another prompt to resume from the latest durable checkpoint.',
          });
        }
        return;
      }
      if (runVm && ownsCurrentRun && !runVm.isDisposed()) {
        await saveVaultCheckpoint(runVm, 'agent-tool').catch(() => undefined);
      }
      appendRunEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      sendInFlightRef.current = false;
      // Only clear state if this is still the current build. A stale build that
      // was superseded (Stop then Build, or a project switch) must not turn off
      // the building indicator for the newer build that now owns the ref.
      if (buildAbortControllerRef.current === abortController) {
        buildAbortControllerRef.current = null;
        setBuilding(false);
      }
      if (
        stoppingControllerRef.current === abortController &&
        stoppingBackendRef.current === null
      ) {
        stoppingControllerRef.current = null;
        setStopping(false);
        setStoppingOperation(null);
      }
    }
  };

  const cancelBuild = () => {
    const controller = buildAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    // React may not have committed setBackend(vm) yet even though the boot
    // lease and agent run already own that VM. The lease is the synchronous
    // source of truth for Stop's process boundary.
    const mountedCandidate = backend ?? workspaceLeaseRef.current?.backend ?? null;
    const mountedBackend =
      mountedCandidate && !mountedCandidate.isDisposed()
        ? mountedCandidate
        : null;
    stoppingControllerRef.current = controller;
    stoppingBackendRef.current = mountedBackend;
    setStoppingOperation('coding');
    setStopping(true);
    if (mountedBackend) {
      quiescingBackendsRef.current.add(mountedBackend);
    }
    for (const timerId of terminalCheckpointTimersRef.current) {
      window.clearTimeout(timerId);
    }
    terminalCheckpointTimersRef.current.clear();
    if (rawTerminalCheckpointTimerRef.current !== null) {
      window.clearTimeout(rawTerminalCheckpointTimerRef.current);
      rawTerminalCheckpointTimerRef.current = null;
    }
    controller.abort();
    setReady(false);

    // CheerpX has no reliable process-level kill handle. Stop is fail-closed:
    // abort the provider immediately, let any already-running completed-tool
    // checkpoint finish, then dispose the runtime process boundary. An active
    // tool has no checkpoint in flight and therefore still stops immediately.
    if (mountedBackend) {
      const previousReset = backendResetChainRef.current.catch(() => undefined);
      const stopTask = previousReset
        .then(async () => {
          await checkpointChainRef.current.catch(() => undefined);
          await disposeWorkspaceRuntime(mountedBackend);
          setBackend((current) =>
            current === mountedBackend ? null : current,
          );
          setVmStatus(INITIAL_STATUS);
        })
        .finally(() => {
          if (stoppingControllerRef.current === controller) {
            stoppingControllerRef.current = null;
            stoppingBackendRef.current = null;
            setStopping(false);
            setStoppingOperation(null);
          }
        });
      backendResetChainRef.current = stopTask.catch((error) => {
        console.error('[workspace] Stop cleanup failed', error);
      });
    }
    appendEvent({
      kind: 'status',
      label: 'Stopping',
      text: 'Stopping the active request and VM process tree…',
    });
  };

  const cancelNetworkRetry = () => {
    const controller = networkRetryAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    const mountedCandidate =
      backend ?? workspaceLeaseRef.current?.backend ?? null;
    const mountedBackend =
      mountedCandidate && !mountedCandidate.isDisposed()
        ? mountedCandidate
        : null;
    stoppingControllerRef.current = controller;
    stoppingBackendRef.current = mountedBackend;
    setStoppingOperation('tailnet');
    setStopping(true);
    if (mountedBackend) {
      quiescingBackendsRef.current.add(mountedBackend);
    }
    for (const timerId of terminalCheckpointTimersRef.current) {
      window.clearTimeout(timerId);
    }
    terminalCheckpointTimersRef.current.clear();
    if (rawTerminalCheckpointTimerRef.current !== null) {
      window.clearTimeout(rawTerminalCheckpointTimerRef.current);
      rawTerminalCheckpointTimerRef.current = null;
    }
    controller.abort();
    if (networkRetryAbortControllerRef.current === controller) {
      networkRetryAbortControllerRef.current = null;
    }
    setNetworkRetrying(false);
    setReady(false);

    appendEvent({
      kind: 'status',
      label: 'Stopping Tailnet retry',
      text: 'Stopping the Tailnet retry and VM process tree…',
    });

    if (!mountedBackend) {
      stoppingControllerRef.current = null;
      stoppingBackendRef.current = null;
      setStopping(false);
      setStoppingOperation(null);
      appendEvent({
        kind: 'status',
        label: 'Tailnet retry stopped',
        text: 'The Tailnet retry stopped.',
      });
      return;
    }

    const previousReset = backendResetChainRef.current.catch(() => undefined);
    const stopTask = previousReset
      .then(async () => {
        await checkpointChainRef.current.catch(() => undefined);
        await disposeWorkspaceRuntime(mountedBackend);
        setBackend((current) =>
          current === mountedBackend ? null : current,
        );
        setVmStatus(INITIAL_STATUS);
        appendEvent({
          kind: 'status',
          label: 'Tailnet retry stopped',
          text: 'The Tailnet retry and VM process tree stopped. Start another build to restore the latest durable workspace checkpoint.',
        });
      })
      .finally(() => {
        if (stoppingControllerRef.current === controller) {
          stoppingControllerRef.current = null;
          stoppingBackendRef.current = null;
          setStopping(false);
          setStoppingOperation(null);
        }
      });
    backendResetChainRef.current = stopTask.catch((error) => {
      console.error('[workspace] Tailnet Stop cleanup failed', error);
    });
  };

  const cancelActiveOperation = () => {
    if (networkRetryAbortControllerRef.current) {
      cancelNetworkRetry();
      return;
    }
    cancelBuild();
  };

  const retryTailnet = async () => {
    const existingNetworkFailure =
      backend?.getFatalNetworkFailure?.() ??
      getFatalTailnetRuntimeFailure();
    if (existingNetworkFailure) {
      // A page-global CheerpX network crash cannot be retried in this
      // document. The prominent header action must perform the safe recovery,
      // even if a coding turn is still active.
      await restartVmNow();
      return;
    }
    // Nonfatal retry is intentionally idle-only. It must never supersede an
    // agent controller or continue network work against the VM Stop disposes.
    if (
      building ||
      sendInFlightRef.current ||
      networkRetrying ||
      networkRetryAbortControllerRef.current
    ) {
      return;
    }
    if (!backend) {
      appendEvent({
        kind: 'error',
        label: 'Retry Tailnet',
        text: 'No VM is running yet. Start a build first.',
      });
      return;
    }

    setNetworkRetrying(true);
    setReady(false);
    setErrorMessage(null);
    const abortController = new AbortController();
    networkRetryAbortControllerRef.current = abortController;
    const ensureNotAborted = () => {
      if (abortController.signal.aborted) {
        const abortError = new Error('Retry Tailnet was stopped.');
        abortError.name = 'AbortError';
        throw abortError;
      }
    };
    try {
      appendEvent({
        kind: 'status',
        label: 'Retry Tailnet',
        text: 'Restarting the browser-side Tailnet login and waiting for a VM address.',
      });
      const loginUrl = await backend.connectPrivateNetwork({
        timeoutMs: 60_000,
        forceLogin: true,
      });
      ensureNotAborted();
      if (loginUrl) {
        window.open(loginUrl, '_blank', 'noopener,noreferrer');
        appendEvent({
          kind: 'status',
          label: 'Retry Tailnet',
          text: 'Opened Tailscale login. Waiting for the VM Tailnet address.',
        });
        await backend.connectPrivateNetwork({ timeoutMs: 60_000 });
        ensureNotAborted();
      }

      if (!backend.getPrivateNetworkAddress()) {
        const fatalNetworkFailure = backend.getFatalNetworkFailure?.();
        appendEvent({
          kind: 'error',
          label: fatalNetworkFailure
            ? 'Network runtime needs reload'
            : 'Tailnet unavailable',
          text: fatalNetworkFailure
            ? `${fatalNetworkFailure} Press Restart VM to save the workspace and reload safely.`
            : 'Tailnet still has not provided a VM IP. The workspace files are still saved; try again once the Tailnet device appears.',
        });
        return;
      }

      appendEvent({
        kind: 'status',
        label: 'Tailnet ready',
        text: `Tailnet IP ready: ${backend.getPrivateNetworkAddress()}. Starting the VM web server.`,
      });

      ensureNotAborted();
      const startResult = await backend.startDefaultPreview();
      ensureNotAborted();
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

      const health = await backend.checkPreview();
      ensureNotAborted();
      const serverHealthy = health.status === 0;
      appendEvent({
        kind: serverHealthy ? 'status' : 'error',
        label: serverHealthy ? 'Server ready' : 'Server failed',
        text:
          cleanStatusOutput(health.output) ||
          `Readiness check exited with ${health.status}`,
      });
      if (!serverHealthy) {
        return;
      }

      const url =
        backend.getPreviewUrl() ??
        (await waitForPreviewUrl(backend, 20_000, abortController.signal));
      ensureNotAborted();
      if (!url) {
        appendEvent({
          kind: 'error',
          label: 'Tailnet unavailable',
          text: 'The server is ready, but no Tailnet preview URL is available yet.',
        });
        return;
      }

      ensureNotAborted();
      await loadFiles(backend);
      ensureNotAborted();
      await saveActiveProject({}, { requireExisting: true });
      ensureNotAborted();
      appendEvent({
        kind: 'ready',
        text: `**Server is ready at:** ${url}\n\nOpen the URL in Chrome to prove the outer-browser connection.`,
      });
      setReady(true);
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) {
        return;
      }
      appendEvent({
        kind: 'error',
        label: 'Retry Tailnet',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (networkRetryAbortControllerRef.current === abortController) {
        networkRetryAbortControllerRef.current = null;
        setNetworkRetrying(false);
      }
      if (
        stoppingControllerRef.current === abortController &&
        stoppingBackendRef.current === null
      ) {
        stoppingControllerRef.current = null;
        setStopping(false);
        setStoppingOperation(null);
      }
    }
  };

  const prepareTerminal = () => {
    if (!backend || building || networkRetrying) {
      return;
    }
    const result = backend.startInteractiveShell();
    const output = cleanStatusOutput(result.output);
    if (result.status !== 0 && output) {
      appendTerminal(`${output}\n`);
    }
  };

  /**
   * Boot the VM outside a coding run (workbench entry, Start VM in the
   * terminal). No-op while a run or network operation owns the VM, or when a
   * healthy VM already exists.
   */
  const startVmNow = async () => {
    if (building || networkRetrying || stopping) return;
    if (backend && !backend.isDisposed()) return;
    try {
      await bootVm();
    } catch (error) {
      if (isAbortError(error)) return;
      appendEvent({
        kind: 'error',
        label: 'VM start failed',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const openTerminal = () => {
    setShowFiles(false);
    setShowLogs(false);
    setShowTerminal(true);
    // The shell attaches from the dock effect below once a healthy VM exists.
    if (!backend || backend.isDisposed()) {
      void startVmNow();
    }
  };

  const openFiles = () => {
    setShowLogs(false);
    setShowTerminal(false);
    setShowFiles(true);
  };

  const openLogs = () => {
    setShowFiles(false);
    setShowTerminal(false);
    setShowLogs(true);
  };

  // The dock can be open before the VM exists (Start VM, auto-boot). Attach
  // the interactive shell as soon as a healthy VM appears; the call is
  // idempotent on an already-running shell.
  const backendForShell = backend && !backend.isDisposed() ? backend : null;
  useEffect(() => {
    if (!showTerminal || !backendForShell || building || networkRetrying) return;
    prepareTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTerminal, backendForShell, building, networkRetrying]);

  // Boot the VM as soon as a project opens in the workbench so the terminal
  // and the first build do not wait for a cold start. Once per project; a
  // failed boot is reported and not retried automatically.
  const autoBootProjectIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (screen !== 'chat') return;
    if (backend || building || networkRetrying || stopping) return;
    // A lease means a VM is booted or booting for this tab already (React
    // state can lag the boot); never start a second one.
    if (workspaceLeaseRef.current || vmBootInFlightRef.current) return;
    if (autoBootProjectIdRef.current === activeProject.id) return;
    autoBootProjectIdRef.current = activeProject.id;
    void startVmNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, backend, building, networkRetrying, stopping, activeProject.id]);

  // Ctrl/Cmd + ` toggles the docked terminal, as in most editors.
  useEffect(() => {
    if (screen !== 'chat') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '`' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      if (showTerminal) setShowTerminal(false);
      else openTerminal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, showTerminal, backend, building, networkRetrying, stopping]);

  const runTerminalCommand = (
    commandOverride?: string,
    revealDrawer = true,
  ) => {
    const command = (commandOverride ?? terminalCommand).trim();
    if (!command) return;
    setTerminalCommand('');
    if (revealDrawer) {
      setShowTerminal(true);
    }

    if (building || networkRetrying) {
      appendTerminal(
        networkRetrying
          ? 'Terminal input is paused while SparkRun reconnects Tailnet.\n'
          : 'Terminal input is paused while the coding agent is running.\n',
      );
      return;
    }
    if (!backend) {
      appendTerminal('No VM is running.\n');
      return;
    }
    const projectId = activeProject.id;
    const vm = backend;

    const result = backend.writeTerminalInput(`${command}\n`);
    const output = cleanStatusOutput(result.output);
    if (output) {
      appendTerminal(`${output}\n`);
    }
    if (result.status !== 0) {
      appendTerminal(`[exit ${result.status}]\n`);
    }
    const conversationId = activeConversationIdRef.current;
    const persistedCommand = redactCodingSecrets(command);
    const persistedScrollback = redactCodingSecrets(
      terminalRef.current.slice(-100_000),
    );
    void ensureVaultReady()
      .then(async () => {
        if (invalidatedProjectIdsRef.current.has(projectId)) return;
        await vaultRef.current.patchTerminalSession({
          id: `terminal-${projectId}`,
          projectId,
          title: 'Main terminal',
          cwd: SITE_ROOT,
          appendCommand: persistedCommand,
          scrollback: persistedScrollback,
        });
        if (conversationId) {
          await vaultRef.current.appendConversationEvent({
            conversationId,
            role: 'tool',
            kind: 'terminal-command',
            payload: { command: persistedCommand, cwd: SITE_ROOT },
          });
        }
      })
      .catch((error) => {
        if (!invalidatedProjectIdsRef.current.has(projectId)) {
          console.error('[vault] terminal history save failed', error);
        }
      });

    // The raw CheerpX terminal API does not expose a prompt-complete event yet.
    // An idle checkpoint catches normal commands; long-running work is also
    // protected by the mandatory checkpoint before any restart/reset.
    const timerId = window.setTimeout(() => {
      terminalCheckpointTimersRef.current.delete(timerId);
      if (
        invalidatedProjectIdsRef.current.has(projectId) ||
        vm.isDisposed() ||
        quiescingBackendsRef.current.has(vm)
      ) {
        return;
      }
      void ensureVaultReady()
        .then(async () => {
          if (
            invalidatedProjectIdsRef.current.has(projectId) ||
            vm.isDisposed() ||
            quiescingBackendsRef.current.has(vm)
          ) {
            return;
          }
          // CheerpX output arrives asynchronously after writeTerminalInput()
          // returns. Persist the current scrollback at the idle boundary, not
          // only the eager pre-output snapshot taken when the command was sent.
          await vaultRef.current.patchTerminalSession({
            id: `terminal-${projectId}`,
            projectId,
            title: 'Main terminal',
            cwd: SITE_ROOT,
            scrollback: redactCodingSecrets(
              terminalRef.current.slice(-100_000),
            ),
          });
          if (
            activeProjectIdRef.current === projectId &&
            workspaceLeaseRef.current?.backend === vm &&
            !vm.isDisposed() &&
            !quiescingBackendsRef.current.has(vm)
          ) {
            await saveVaultCheckpoint(vm, 'terminal-command');
          }
        })
        .catch((error) => {
          if (!invalidatedProjectIdsRef.current.has(projectId)) {
            console.error('[vault] terminal idle checkpoint failed', error);
          }
        });
    }, 2_500);
    terminalCheckpointTimersRef.current.add(timerId);
  };

  const sendTerminalInput = (commandOverride?: string) => {
    runTerminalCommand(commandOverride, true);
  };

  const sendInlineTerminalInput = (commandOverride?: string) => {
    runTerminalCommand(commandOverride, false);
  };

  const sendRawTerminalInput = (value: string) => {
    if (!backend || !value || building || networkRetrying) return;
    const result = backend.writeTerminalInput(value);
    if (result.status !== 0 && result.output) {
      appendTerminal(`\r\n${result.output}\r\n`);
    }
    if (rawTerminalCheckpointTimerRef.current !== null) {
      window.clearTimeout(rawTerminalCheckpointTimerRef.current);
    }
    const projectId = activeProject.id;
    const vm = backend;
    rawTerminalCheckpointTimerRef.current = window.setTimeout(() => {
      rawTerminalCheckpointTimerRef.current = null;
      if (
        invalidatedProjectIdsRef.current.has(projectId) ||
        vm.isDisposed() ||
        quiescingBackendsRef.current.has(vm)
      ) {
        return;
      }
      void ensureVaultReady()
        .then(async () => {
          if (
            invalidatedProjectIdsRef.current.has(projectId) ||
            vm.isDisposed() ||
            quiescingBackendsRef.current.has(vm)
          ) {
            return;
          }
          await vaultRef.current.patchTerminalSession({
            id: `terminal-${projectId}`,
            projectId,
            title: 'Main terminal',
            cwd: SITE_ROOT,
            scrollback: redactCodingSecrets(
              terminalRef.current.slice(-100_000),
            ),
          });
          if (
            activeProjectIdRef.current === projectId &&
            workspaceLeaseRef.current?.backend === vm &&
            !vm.isDisposed() &&
            !quiescingBackendsRef.current.has(vm)
          ) {
            await saveVaultCheckpoint(vm, 'terminal-command');
          }
        })
        .catch((error) => {
          if (!invalidatedProjectIdsRef.current.has(projectId)) {
            console.error('[vault] raw terminal checkpoint failed', error);
          }
        });
    }, 2_500);
  };

  const openWebsite = () => {
    if (!previewUrl) return;
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  };

  const continueToChat = () => {
    if (
      !hasOpenedBefore &&
      (!activeProject.name.trim() || validateGoogleApiKey(apiKey) !== null)
    ) {
      return;
    }
    startupHydrationInvalidatedRef.current = true;
    setHasOpenedBefore(true);
    setDraft((current) => current || activeProject.prompt || DEFAULT_PROMPT);
    setScreen('chat');
    void ensureVaultReady()
      .then(() =>
        vaultRef.current.putSetting(ONBOARDING_COMPLETE_SETTING_KEY, true),
      )
      .catch((error) =>
        console.error('[vault] could not persist onboarding state', error),
      );
  };

  const goToSetup = () => {
    setScreen('setup');
  };

  const previewReady =
    ready && Boolean(previewUrl) && !fatalNetworkFailure;
  const subtitleTone: 'live' | 'run' | 'idle' = previewReady
    ? 'idle'
    : building
      ? 'run'
      : 'idle';

  const subtitle =
    screen === 'setup'
      ? ''
      : previewReady
        ? `server ready · ${hostFromPreviewUrl(previewUrl) ?? `${vmStatus.tailnetIp ?? '—'}:${activeServerPort ?? 'auto'}`}`
        : building
          ? 'vm building…'
          : `ready · ${model}`;

  const title =
    screen === 'setup' ? 'Setup' : activeProject.name || 'Untitled';

  return (
    <>
      <div inert={showFiles || showLogs ? true : undefined}>
        <AppBar
        inert={railModalOpen}
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
          onModel={updateModel}
          onRemember={updateRememberKeys}
          hasOpenedBefore={hasOpenedBefore}
          onContinue={continueToChat}
          projects={projects}
          activeProject={activeProject}
          onSelectProject={(project) => void selectProject(project)}
          onDeleteProject={(projectId) => void removeProject(projectId)}
          onNewProject={() => void newProject()}
          onSaveProject={() => {
            void saveActiveProject({
              name: activeProject.name,
              prompt: draft,
            }).catch((error) => {
              appendEvent({
                kind: 'error',
                label: 'Project save failed',
                text: error instanceof Error ? error.message : String(error),
              });
            });
          }}
          sourceDirectoryName={sourceDirectoryName}
          hasSourceDirectory={Boolean(sourceDirectory)}
          localFolderSupported={localFolderSupported}
          onAttachFolder={() => void attachSourceFolder()}
          onDetachFolder={() => void detachSourceFolder()}
          onResetWorkspace={resetWorkspaceCaches}
        />
      ) : (
        <WorkbenchShell
          activeProject={activeProject}
          projects={projects}
          conversations={conversations}
          activeConversationId={activeConversationId}
          storage={storageDurability}
          checkpointState={checkpointState}
          vmStatus={vmStatus}
          building={building || networkRetrying}
          fatalNetworkFailure={fatalNetworkFailure}
          onNewProject={() => void newProject()}
          onSelectProject={(project) => void selectProject(project)}
          onNewConversation={() => void newConversation()}
          onSelectConversation={(conversation) => void selectConversation(conversation)}
          onSnapshot={() => void snapshotNow()}
          onRestartVm={() => void restartVmNow()}
          onRailModalChange={setRailModalOpen}
        >
          <ChatScreen
            cfg={{ model, projectName: activeProject.name }}
            onModel={updateModel}
            events={events}
            files={files}
            building={building}
            networkRetrying={networkRetrying}
            stopping={stopping}
            stoppingOperation={stoppingOperation}
            ready={ready}
            fatalNetworkFailure={fatalNetworkFailure}
            tailnetIp={vmStatus.tailnetIp ?? null}
            previewUrl={previewUrl}
            serverPort={activeServerPort}
            vmStatus={vmStatus}
            hasStarted={hasStarted}
            draft={draft}
            onDraft={setDraft}
            onSend={() => void send()}
            onCancel={cancelActiveOperation}
            onOpenWebsite={openWebsite}
            onRetryTailnet={() => void retryTailnet()}
            onFiles={openFiles}
            onLogs={openLogs}
            onTerminal={openTerminal}
            onCloseTerminal={() => setShowTerminal(false)}
            onStartVm={() => void startVmNow()}
            terminalOpen={showTerminal}
            terminalDockHeight={terminalDockHeight}
            onTerminalDockHeight={updateTerminalDockHeight}
            terminalText={terminal}
            terminalInput={terminalCommand}
            terminalAvailable={Boolean(backend)}
            terminalDisabled={!backend || building || networkRetrying}
            onTerminalInput={setTerminalCommand}
            onSendTerminalInput={sendInlineTerminalInput}
            onRawTerminalInput={sendRawTerminalInput}
            onReadFile={readWorkspaceFile}
            debugLog={debugLog}
            errorMessage={errorMessage}
          />
        </WorkbenchShell>
        )}
      </div>
      <FileDrawer
        open={showFiles}
        onClose={() => setShowFiles(false)}
        files={files}
        onReadFile={readWorkspaceFile}
      />
      <LogDrawer
        open={showLogs}
        onClose={() => setShowLogs(false)}
        text={debugLog}
      />
    </>
  );
}
