import { useEffect, useMemo, useRef, useState } from 'react';
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
import { MODEL_ID, SERVER_PORT } from './lib/constants';
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
import { WebVmBackend, type WebVmStatus } from './lib/webvm';
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

interface LogEvent {
  id: number;
  kind: EventKind;
  label?: string;
  text?: string;
  cmd?: string;
  lines?: string[];
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

const MODELS = [
  { id: MODEL_ID, label: 'Flash preview', sub: 'Only model enabled' },
];

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

function eventToLogKind(event: AgentEvent): EventKind {
  if (event.type === 'done') return 'ready';
  if (event.type === 'error') return 'error';
  if (event.type === 'model') return 'thought';
  return 'cmd';
}

function makeId(): number {
  return Date.now() + Math.floor(Math.random() * 1000);
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

function SetupScreen(props: SetupScreenProps) {
  const [showKey1, setShowKey1] = useState(false);
  const [showKey2, setShowKey2] = useState(false);

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
              className="text-input has-suffix"
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
          <p className="field-hint">
            Found at aistudio.google.com → Get API key.
          </p>
        </div>

        <div className="field" style={{ marginBottom: 0 }}>
          <label className="field-label" htmlFor="setup-tail-key">
            <Cable size={13} aria-hidden="true" /> Tailscale auth key
          </label>
          <div className="input-wrap">
            <input
              id="setup-tail-key"
              className="text-input has-suffix"
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
          <p className="field-hint">
            Reusable auth key. Your VM joins your tailnet so the preview opens
            at a stable hostname.
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
  fileCount: number;
  building: boolean;
  ready: boolean;
  tailnetIp: string | null;
  vmStatus: WebVmStatus;
  hasStarted: boolean;
  draft: string;
  onDraft: (value: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onOpenWebsite: () => void;
  onTerminal: () => void;
  errorMessage: string | null;
}

function StreamLine({ line }: { line: string }) {
  let cls = 'stream-line';
  if (line.startsWith('[vm]')) cls = 'stream-line vm';
  else if (/error|fail/i.test(line)) cls = 'stream-line err';
  return <div className={cls}>{line}</div>;
}

function ChatScreen({
  cfg,
  events,
  fileCount,
  building,
  ready,
  tailnetIp,
  vmStatus,
  hasStarted,
  draft,
  onDraft,
  onSend,
  onCancel,
  onOpenWebsite,
  onTerminal,
  errorMessage,
}: ChatScreenProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
            <Monitor size={12} aria-hidden="true" />:{SERVER_PORT}
          </span>
          {fileCount > 0 ? (
            <span className="pill">
              <Files size={12} aria-hidden="true" />
              {fileCount} file{fileCount === 1 ? '' : 's'}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            aria-label="Open terminal"
            className="terminal-toggle"
            onClick={onTerminal}
            type="button"
          >
            <TerminalIcon size={12} aria-hidden="true" />
            Terminal
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

          {events.map((event) => (
            <LogRow key={event.id} event={event} />
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
                  {tailnetIp ? `${tailnetIp}:${SERVER_PORT}` : 'preview'}
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
    cmd: 'Run',
    stream: 'Output',
    ready: 'Live',
    error: 'Error',
  };
  const label = event.label ?? labelMap[event.kind];

  let body: React.ReactNode = null;
  if (event.kind === 'chat') {
    body = <div className="chat-bubble">{event.text}</div>;
  } else if (event.kind === 'thought' || event.kind === 'status') {
    body = <div className="thought-text">{event.text}</div>;
  } else if (event.kind === 'cmd') {
    body = (
      <div className="cmd-text">
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
        {event.text}
      </div>
    );
  } else if (event.kind === 'error') {
    body = (
      <div className="error-banner">
        <TriangleAlert size={14} aria-hidden="true" />
        {event.text}
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
}

function TerminalDrawer({ open, onClose, text }: TerminalDrawerProps) {
  const lines = text ? text.split('\n') : [];
  return (
    <>
      <div
        className={`term-overlay ${open ? 'open' : ''}`}
        onClick={onClose}
      />
      <div className={`term-drawer ${open ? 'open' : ''}`}>
        <div className="term-head">
          <div className="term-head-title">
            <TerminalIcon size={14} aria-hidden="true" /> Terminal
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
        <div className="term-body">
          {!text ? (
            <div className="empty">$ VM output will stream here</div>
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

  const [projects, setProjects] = useState<SavedProject[]>(() => loadProjects());
  const [activeProject, setActiveProject] = useState<SavedProject>(() =>
    createProject(DEFAULT_PROMPT),
  );

  const [backend, setBackend] = useState<WebVmBackend | null>(null);
  const [vmStatus, setVmStatus] = useState<WebVmStatus>(INITIAL_STATUS);
  const [files, setFiles] = useState<DirectoryEntry[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [terminal, setTerminal] = useState('');
  const [building, setBuilding] = useState(false);
  const [ready, setReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [sourceDirectory, setSourceDirectory] =
    useState<FileSystemDirectoryHandle | null>(null);
  const [sourceDirectoryName, setSourceDirectoryName] = useState('');
  const localFolderSupported = useMemo(() => isLocalFolderSupported(), []);
  const restoredProjectIdRef = useRef<string | null>(null);

  const previewUrl = useMemo(
    () => vmStatus.previewUrl ?? backend?.getPreviewUrl() ?? null,
    [backend, vmStatus],
  );

  const appendEvent = (event: Omit<LogEvent, 'id' | 'time'>) => {
    setEvents((current) =>
      [...current, { ...event, id: makeId(), time: clock() }].slice(-200),
    );
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
    setTailscaleAuthKey(value);
    saveKeysIfRemembered(apiKey, value);
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
    setFiles(mergeEntries(collected));
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
      return backend;
    }
    setVmStatus({
      lifecycle: 'booting',
      message: 'Starting WebVM',
      tailnetIp: null,
      loginUrl: null,
      previewUrl: null,
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
        onStatus: (status) => {
          setVmStatus(status);
          if (status.loginUrl) {
            appendEvent({
              kind: 'thought',
              text: `Tailscale login URL ready: ${status.loginUrl}`,
            });
          }
        },
      });
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
      });
      appendEvent({ kind: 'error', text: message });
      throw error;
    }
  };

  const send = async () => {
    const trimmedDraft = draft.trim();
    if (!trimmedDraft) return;

    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) {
      setErrorMessage('Google AI key is required before building.');
      return;
    }
    setErrorMessage(null);

    setHasStarted(true);
    setBuilding(true);
    setReady(false);
    appendEvent({ kind: 'chat', text: trimmedDraft });
    setDraft('');

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
                appendEvent({
                  kind: 'status',
                  label: 'Connecting Tailscale',
                  text: 'Opened Tailscale login',
                });
              } else if (vm.getPreviewUrl()) {
                appendEvent({
                  kind: 'status',
                  label: 'Connecting Tailscale',
                  text: `Tailnet IP ready: ${vm.getPreviewUrl()}`,
                });
              }
            })
            .catch((error: unknown) => {
              appendEvent({
                kind: 'error',
                text: error instanceof Error ? error.message : String(error),
              });
            });

      appendEvent({ kind: 'thought', text: `Calling ${model}…` });

      const result = await runWebsiteAgent({
        apiKey: trimmedApiKey,
        prompt: trimmedDraft,
        backend: vm,
        onEvent: (event: AgentEvent) => {
          appendEvent({ kind: eventToLogKind(event), text: event.message });
        },
      });

      await vm.startServer();
      await tailnetPromise;
      await loadFiles(vm);
      const sourceFiles = await collectSourceFiles(vm);
      if (sourceDirectory) {
        await syncSourceToFolder(vm, sourceDirectory);
      }

      const url = vm.getPreviewUrl();
      if (url) {
        appendEvent({
          kind: 'ready',
          text: `Site is live. Hosted page ready at ${url}`,
        });
        setReady(true);
      } else {
        appendEvent({
          kind: 'thought',
          text: 'Files are built and the VM server started, but no Tailnet IP is available yet.',
        });
      }

      saveActiveProject({
        prompt: trimmedDraft,
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

      if (result.finalText) {
        appendEvent({ kind: 'thought', text: result.finalText });
      }
    } catch (error) {
      appendEvent({
        kind: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBuilding(false);
    }
  };

  const cancelBuild = () => {
    setBuilding(false);
    appendEvent({
      kind: 'status',
      label: 'Stopped',
      text: 'Stopped. Send another prompt to resume.',
    });
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
        ? `live · ${vmStatus.tailnetIp ?? '—'}:${SERVER_PORT}`
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
          fileCount={files.length}
          building={building}
          ready={ready}
          tailnetIp={vmStatus.tailnetIp ?? null}
          vmStatus={vmStatus}
          hasStarted={hasStarted}
          draft={draft}
          onDraft={setDraft}
          onSend={() => void send()}
          onCancel={cancelBuild}
          onOpenWebsite={openWebsite}
          onTerminal={() => setShowTerminal(true)}
          errorMessage={errorMessage}
        />
      )}
      <TerminalDrawer
        open={showTerminal}
        onClose={() => setShowTerminal(false)}
        text={terminal}
      />
    </>
  );
}
