/**
 * Provider- and VM-neutral contracts for SparkRun's coding harness.
 *
 * The harness deliberately owns no browser storage. Callers can persist the
 * returned session as JSON in IndexedDB, a server database, or another store.
 * `onSession` is invoked after every recoverable step so a tab crash loses as
 * little agent context as possible.
 */

export const CODING_HARNESS_SESSION_VERSION = 1 as const;

export type CodingHarnessEventType =
  | 'model'
  | 'tool'
  | 'status'
  | 'error'
  | 'done';

export interface CodingHarnessEvent {
  type: CodingHarnessEventType;
  message: string;
  interactionId?: string;
  toolCallId?: string;
}

export interface CodingTranscriptEntry {
  id: string;
  createdAt: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: 'message' | 'tool-call' | 'tool-result' | 'recovery';
  content: string;
  interactionId?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * JSON-serializable state sufficient to resume an Interactions conversation.
 * `providerState` is intentionally opaque to the runtime and storage layers.
 */
export interface CodingHarnessSession {
  version: typeof CODING_HARNESS_SESSION_VERSION;
  id: string;
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  previousInteractionId: string | null;
  transcript: CodingTranscriptEntry[];
  providerState: Record<string, unknown>;
}

export interface CodingRuntimeDirectoryEntry {
  /** Path relative to `CodingRuntime.workspaceRoot`. */
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  sizeBytes?: number;
}

export interface CodingRuntimeCommandOptions {
  /** Absolute VM path, or a path relative to `workspaceRoot`. */
  cwd?: string;
  background?: boolean;
  stream?: boolean;
  timeoutMs?: number;
  /** Cancels the command; runtimes may dispose their process boundary. */
  signal?: AbortSignal;
}

export interface CodingRuntimeCommandResult {
  status: number;
  output: string;
  background?: boolean;
}

export interface CodingRuntimePreviewOptions {
  command: string;
  port: number;
  /** Absolute VM path, or a path relative to `workspaceRoot`. */
  cwd?: string;
  signal?: AbortSignal;
}

export interface CodingRuntimePreviewResult extends CodingRuntimeCommandResult {
  port: number;
  url: string | null;
}

/**
 * A small capability interface implemented by CheerpX, BrowserPod, a native
 * worker, or test doubles. Paths passed to file methods are always relative to
 * `workspaceRoot`; shell commands run only inside the selected VM runtime.
 */
export interface CodingRuntime {
  readonly id: string;
  readonly workspaceRoot: string;
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, content: string): Promise<void>;
  listDirectory(relativePath: string): Promise<CodingRuntimeDirectoryEntry[]>;
  runCommand(
    command: string,
    options?: CodingRuntimeCommandOptions,
  ): Promise<CodingRuntimeCommandResult>;
  /**
   * Launch a long-lived web process through the host-managed supervisor.
   * Implementations may activate private networking immediately before launch.
   */
  startPreview?(
    options: CodingRuntimePreviewOptions,
  ): Promise<CodingRuntimePreviewResult>;
}

export interface CodingHarnessRunOptions {
  prompt: string;
  runtime: CodingRuntime;
  session?: CodingHarnessSession | null;
  abortSignal?: AbortSignal;
  maxTurns?: number;
  /** Overall server-side execution budget for one model turn. */
  turnTimeoutMs?: number;
  retryBaseDelayMs?: number;
  onEvent?: (event: CodingHarnessEvent) => void;
  /** Persist this snapshot before resolving the callback. */
  onSession?: (
    session: CodingHarnessSession,
  ) => void | Promise<void>;
}

export interface CodingHarnessRunResult {
  finalText: string;
  changedFiles: string[];
  session: CodingHarnessSession;
  reachedTurnBudget: boolean;
}

export interface CodingHarness {
  readonly provider: string;
  readonly model: string;
  run(options: CodingHarnessRunOptions): Promise<CodingHarnessRunResult>;
}

export function cloneCodingSession(
  session: CodingHarnessSession,
): CodingHarnessSession {
  return {
    ...session,
    transcript: session.transcript.map((entry) => ({ ...entry })),
    providerState: { ...session.providerState },
  };
}

export function assertCompatibleSession(
  session: CodingHarnessSession,
  provider: string,
): void {
  if (session.version !== CODING_HARNESS_SESSION_VERSION) {
    throw new Error(
      `Unsupported coding session version ${String(session.version)}.`,
    );
  }
  if (session.provider !== provider) {
    throw new Error(
      `Cannot resume a ${session.provider} session with the ${provider} harness.`,
    );
  }
  if (!Array.isArray(session.transcript)) {
    throw new Error('Coding session transcript is invalid.');
  }
}
