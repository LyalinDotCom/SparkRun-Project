import type { CodingRuntime } from './codingHarness';
import type { DirectoryEntry, VmCommandResult } from './vmFileContract';

export type WorkspaceRuntimeProvider = 'cheerpx' | 'browserpod' | 'test';

/** Observable runtime contracts that change workbench behavior. */
export interface WorkspaceRuntimeCapabilities {
  interactiveTerminal: boolean;
  managedPreview: boolean;
  privatePreview: boolean;
  workspaceArchive: boolean;
  hardDispose: boolean;
}

export interface PrivateNetworkConnectOptions {
  timeoutMs?: number;
  forceLogin?: boolean;
}

/**
 * The complete execution surface consumed by the SparkRun workbench.
 *
 * `CodingRuntime` is the smaller agent-facing contract. This interface adds
 * the checkpoint, terminal, preview, and lifecycle operations owned by App. A
 * provider is not eligible for the product path until it implements and proves
 * this entire contract in Chrome.
 */
export interface WorkspaceRuntime extends CodingRuntime {
  readonly provider: WorkspaceRuntimeProvider;
  readonly capabilities: WorkspaceRuntimeCapabilities;

  listDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  readBytes(relativePath: string): Promise<Uint8Array>;
  resetWorkspace(): Promise<void>;
  createWorkspaceArchive(): Promise<Blob>;
  restoreWorkspaceArchive(archive: Blob): Promise<void>;

  getPreviewUrl(): string | null;
  getPrivateNetworkAddress(): string | null;
  /** Page-global network faults that require reconstructing the browser runtime. */
  getFatalNetworkFailure?(): string | null;
  connectPrivateNetwork(
    options?: PrivateNetworkConnectOptions,
  ): Promise<string | null>;
  startDefaultPreview(): Promise<VmCommandResult>;
  checkPreview(): Promise<VmCommandResult>;
  stopPreview(): Promise<VmCommandResult>;

  startInteractiveShell(): VmCommandResult;
  writeTerminalInput(input: string): VmCommandResult;

  isDisposed(): boolean;
  dispose(): Promise<void>;
}
