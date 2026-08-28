import Dexie, { type EntityTable } from 'dexie';
import type { CodingHarnessSession } from './codingHarness';

export const VAULT_DATABASE_NAME = 'sparkrun-vault-v3';
export const VAULT_SCHEMA_VERSION = 1;
export const ACTIVE_PROJECT_SETTING_KEY = 'active-project-id';
const PENDING_WORKSPACE_DELETE_PREFIX = 'pending-workspace-delete:';
const PROJECT_DELETE_TOMBSTONE_PREFIX = 'deleted-project:';

export function projectSourceDirectorySettingKey(projectId: string): string {
  return `project:${projectId}:source-directory`;
}

export type CheckpointReason =
  | 'agent-tool'
  | 'terminal-command'
  | 'interval'
  | 'manual'
  | 'before-reset';

export interface VaultProject {
  id: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  headCheckpointId: string | null;
  activeConversationId: string | null;
  environmentId: string;
  workspaceDbName: string;
  schemaVersion: number;
}

export interface VaultCheckpoint {
  id: string;
  projectId: string;
  parentId: string | null;
  reason: CheckpointReason;
  state: 'writing' | 'committed';
  archive: Blob;
  archiveSha256: string;
  sizeBytes: number;
  format: 'tar.gz';
  createdAt: string;
}

interface StoredVaultCheckpoint extends Omit<VaultCheckpoint, 'archive'> {
  // Store the canonical archive bytes instead of a Blob. ArrayBuffer has a
  // consistent structured-clone representation across IndexedDB engines,
  // while Blob implementations can lose their prototype/metadata when they
  // cross realms or non-browser IndexedDB implementations. A Blob is rebuilt
  // only at the restore boundary after these bytes pass integrity checks.
  archiveBytes: ArrayBuffer;
}

export interface VaultConversation {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'idle' | 'error';
  provider: 'google-interactions' | 'pi';
  model: string;
  previousInteractionId: string | null;
  harnessSession: CodingHarnessSession | null;
  summary: string;
  lastEventSequence: number;
}

export interface VaultConversationEvent {
  id: string;
  conversationId: string;
  projectId: string;
  sequence: number;
  role: 'user' | 'assistant' | 'tool' | 'system';
  kind: string;
  payload: unknown;
  interactionId: string | null;
  toolCallId: string | null;
  createdAt: string;
}

export interface VaultTerminalSession {
  id: string;
  projectId: string;
  title: string;
  cwd: string;
  commandHistory: string[];
  scrollback: string;
  updatedAt: string;
}

export interface VaultEnvironment {
  id: string;
  label: string;
  rootDbName: string;
  baseDiskUrl: string;
  cheerpxVersion: string;
  bootstrapRecipe: string[];
  installedTools: Array<{
    manager: string;
    name: string;
    version: string;
  }>;
  updatedAt: string;
}

export interface VaultSetting {
  key: string;
  value: unknown;
}

export interface StorageDurability {
  persisted: boolean;
  usageBytes: number | null;
  quotaBytes: number | null;
}

type VaultTables = Dexie & {
  projects: EntityTable<VaultProject, 'id'>;
  checkpoints: EntityTable<StoredVaultCheckpoint, 'id'>;
  conversations: EntityTable<VaultConversation, 'id'>;
  conversationEvents: EntityTable<VaultConversationEvent, 'id'>;
  terminalSessions: EntityTable<VaultTerminalSession, 'id'>;
  environments: EntityTable<VaultEnvironment, 'id'>;
  settings: EntityTable<VaultSetting, 'key'>;
};

function now(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}

function safeDatabaseSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96);
}

export function createVaultProjectDraft(input: {
  id?: string;
  name: string;
  prompt: string;
  environmentId?: string;
}): VaultProject {
  const createdAt = now();
  const id = input.id ?? createId('project');
  return {
    id,
    name: input.name.trim() || 'Untitled project',
    prompt: input.prompt,
    createdAt,
    updatedAt: createdAt,
    headCheckpointId: null,
    activeConversationId: null,
    environmentId: input.environmentId ?? 'default-web',
    workspaceDbName: `sparkrun-workspace-v3-${safeDatabaseSegment(id)}`,
    schemaVersion: VAULT_SCHEMA_VERSION,
  };
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  // Re-wrap the buffer so Web Crypto receives a view from the current realm.
  // IndexedDB is allowed to return structured clones created in a different
  // JavaScript realm (for example a worker), where `instanceof ArrayBuffer`
  // is false even though the value is a valid ArrayBuffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function storedArchiveBytes(
  checkpoint: StoredVaultCheckpoint,
): ArrayBuffer | null {
  const value: unknown = checkpoint.archiveBytes;
  return Object.prototype.toString.call(value) === '[object ArrayBuffer]' &&
    typeof (value as ArrayBuffer).byteLength === 'number'
    ? (value as ArrayBuffer)
    : null;
}

function materializeCheckpoint(
  checkpoint: StoredVaultCheckpoint,
): VaultCheckpoint | null {
  const archiveBytes = storedArchiveBytes(checkpoint);
  if (!archiveBytes) return null;
  const { archiveBytes: _archiveBytes, ...metadata } = checkpoint;
  try {
    return {
      ...metadata,
      archive: new Blob([new Uint8Array(archiveBytes)], {
        type: 'application/gzip',
      }),
    };
  } catch {
    return null;
  }
}

async function isVerifiedCheckpoint(
  checkpoint: StoredVaultCheckpoint,
): Promise<boolean> {
  const archiveBytes = storedArchiveBytes(checkpoint);
  if (
    checkpoint.state !== 'committed' ||
    !archiveBytes ||
    !Number.isSafeInteger(checkpoint.sizeBytes) ||
    checkpoint.sizeBytes < 0 ||
    archiveBytes.byteLength !== checkpoint.sizeBytes ||
    !/^[a-f0-9]{64}$/.test(checkpoint.archiveSha256)
  ) {
    return false;
  }
  try {
    return (await sha256(archiveBytes)) === checkpoint.archiveSha256;
  } catch {
    return false;
  }
}

export class BrowserVault {
  readonly db: VaultTables;

  constructor(databaseName = VAULT_DATABASE_NAME) {
    const db = new Dexie(databaseName) as VaultTables;
    db.version(VAULT_SCHEMA_VERSION).stores({
      projects: '&id, updatedAt, activeConversationId, environmentId',
      checkpoints: '&id, projectId, [projectId+createdAt], state',
      conversations: '&id, projectId, [projectId+updatedAt], status',
      conversationEvents:
        '&id, conversationId, projectId, [conversationId+sequence]',
      terminalSessions: '&id, projectId, [projectId+updatedAt]',
      environments: '&id, updatedAt',
      settings: '&key',
    });
    this.db = db;
  }

  async open(): Promise<void> {
    await this.db.open();
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async delete(): Promise<void> {
    this.db.close();
    await Dexie.delete(this.db.name);
  }

  async listProjects(): Promise<VaultProject[]> {
    return this.db.projects.orderBy('updatedAt').reverse().toArray();
  }

  async getProject(id: string): Promise<VaultProject | undefined> {
    return this.db.projects.get(id);
  }

  async saveProjectMetadata(
    project: VaultProject,
    options: { requireExisting?: boolean } = {},
  ): Promise<VaultProject> {
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.settings],
      async () => {
        const tombstone = await this.db.settings.get(
          this.projectDeleteTombstoneKey(project.id),
        );
        const current = await this.db.projects.get(project.id);
        if (tombstone || (!current && options.requireExisting)) {
          throw new Error(`Unknown project: ${project.id}`);
        }
        const stored: VaultProject = current
          ? {
              ...current,
              name: project.name.trim() || 'Untitled project',
              prompt: project.prompt,
              updatedAt: now(),
              schemaVersion: VAULT_SCHEMA_VERSION,
            }
          : {
              ...project,
              name: project.name.trim() || 'Untitled project',
              updatedAt: now(),
              schemaVersion: VAULT_SCHEMA_VERSION,
            };
        await this.db.projects.put(stored);
        // Updating metadata must not implicitly change project selection. A
        // newly persisted draft still becomes active, preserving the create
        // behavior callers rely on without allowing a late update to roll a
        // newer selection backward.
        if (!current) {
          await this.db.settings.put({
            key: ACTIVE_PROJECT_SETTING_KEY,
            value: stored.id,
          });
        }
        return stored;
      },
    );
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.settings.get(key))?.value as T | undefined;
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    await this.db.settings.put({ key, value });
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.settings.delete(key);
  }

  async activateProject(projectId: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.settings],
      async () => {
        if (!(await this.db.projects.get(projectId))) {
          throw new Error(`Unknown project: ${projectId}`);
        }
        await this.db.settings.put({
          key: ACTIVE_PROJECT_SETTING_KEY,
          value: projectId,
        });
      },
    );
  }

  async createProject(input: {
    id?: string;
    name: string;
    prompt: string;
    environmentId?: string;
  }): Promise<VaultProject> {
    const project = createVaultProjectDraft(input);
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.settings],
      async () => {
        if (
          await this.db.settings.get(this.projectDeleteTombstoneKey(project.id))
        ) {
          throw new Error(`Unknown project: ${project.id}`);
        }
        // App startup and the Build click can discover a missing project at the
        // same time. An explicit id represents one logical project, so creation
        // is idempotent instead of exposing an IndexedDB ConstraintError.
        if (input.id) {
          const existing = await this.db.projects.get(project.id);
          if (existing) {
            // Ensuring that an already-persisted project exists is not a user
            // selection action. Conversation/checkpoint initialization can
            // finish after the user switches projects; implicitly activating
            // here would roll that newer selection backward.
            return existing;
          }
        }
        await this.db.projects.add(project);
        await this.db.settings.put({
          key: ACTIVE_PROJECT_SETTING_KEY,
          value: project.id,
        });
        return project;
      },
    );
  }

  private pendingWorkspaceDeleteKey(workspaceDbName: string): string {
    return `${PENDING_WORKSPACE_DELETE_PREFIX}${workspaceDbName}`;
  }

  private projectDeleteTombstoneKey(projectId: string): string {
    return `${PROJECT_DELETE_TOMBSTONE_PREFIX}${projectId}`;
  }

  private async deleteWorkspaceDatabase(
    workspaceDbName: string,
    timeoutMs = 1_000,
  ): Promise<boolean> {
    const key = this.pendingWorkspaceDeleteKey(workspaceDbName);
    const deletion = Dexie.delete(workspaceDbName)
      .then(async () => {
        await this.db.settings.delete(key).catch(() => undefined);
        return true;
      })
      .catch(() => false);
    return Promise.race([
      deletion,
      new Promise<boolean>((resolve) => {
        globalThis.setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  }

  async deleteProject(projectId: string): Promise<void> {
    let workspaceDbName: string | undefined;
    await this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.checkpoints,
        this.db.conversations,
        this.db.conversationEvents,
        this.db.terminalSessions,
        this.db.settings,
      ],
      async () => {
        const project = await this.db.projects.get(projectId);
        const conversations = await this.db.conversations
          .where('projectId')
          .equals(projectId)
          .primaryKeys();
        workspaceDbName = project?.workspaceDbName;
        await this.db.settings.put({
          key: this.projectDeleteTombstoneKey(projectId),
          value: now(),
        });
        if (workspaceDbName) {
          await this.db.settings.put({
            key: this.pendingWorkspaceDeleteKey(workspaceDbName),
            value: workspaceDbName,
          });
        }
        await this.db.projects.delete(projectId);
        await this.db.checkpoints.where('projectId').equals(projectId).delete();
        await this.db.conversations.where('projectId').equals(projectId).delete();
        await this.db.conversationEvents.where('projectId').equals(projectId).delete();
        await this.db.terminalSessions.where('projectId').equals(projectId).delete();
        const activeProject = await this.db.settings.get(
          ACTIVE_PROJECT_SETTING_KEY,
        );
        if (activeProject?.value === projectId) {
          await this.db.settings.delete(ACTIVE_PROJECT_SETTING_KEY);
        }
        await this.db.settings.delete(
          projectSourceDirectorySettingKey(projectId),
        );
        for (const conversationId of conversations) {
          await this.db.conversationEvents
            .where('conversationId')
            .equals(String(conversationId))
            .delete();
        }
      },
    );
    if (workspaceDbName) {
      // CheerpX can keep the workspace database mounted briefly after its
      // server stops. Do not let that browser-level `blocked` event hang the
      // project deletion UI; retain a vault tombstone and retry on next open.
      await this.deleteWorkspaceDatabase(workspaceDbName);
    }
  }

  async commitCheckpoint(input: {
    projectId: string;
    archive: Blob;
    reason: CheckpointReason;
    expectedParentId?: string | null;
  }): Promise<VaultCheckpoint> {
    // Read the Blob exactly once and make those immutable bytes the source of
    // both the persisted payload and its integrity metadata. This avoids a
    // time-of-check/time-of-write split between Blob metadata and its bytes.
    const archiveBytes = await input.archive.arrayBuffer();
    const checkpoint: StoredVaultCheckpoint = {
      id: createId('checkpoint'),
      projectId: input.projectId,
      parentId: null,
      reason: input.reason,
      state: 'writing',
      archiveBytes,
      archiveSha256: await sha256(archiveBytes),
      sizeBytes: archiveBytes.byteLength,
      format: 'tar.gz',
      createdAt: now(),
    };

    // The writing marker is deliberately durable. If the browser dies before
    // the second transaction commits, recovery ignores it and keeps the prior
    // project head instead of promoting a partial snapshot.
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.checkpoints],
      async () => {
        const project = await this.db.projects.get(input.projectId);
        if (!project) {
          throw new Error(`Unknown project: ${input.projectId}`);
        }
        if (
          input.expectedParentId !== undefined &&
          project.headCheckpointId !== input.expectedParentId
        ) {
          throw new Error(
            `Checkpoint conflict for ${input.projectId}: expected ${
              input.expectedParentId ?? 'no head'
            }, found ${project.headCheckpointId ?? 'no head'}.`,
          );
        }
        checkpoint.parentId = project.headCheckpointId;
        await this.db.checkpoints.add(checkpoint);
      },
    );

    try {
      // Materialize the public return value before promoting this checkpoint.
      // Blob construction is fallible in some browser/runtime combinations;
      // doing it after the transaction committed could report failure after
      // advancing the head, and the cleanup path would then risk removing the
      // committed row beneath that head.
      checkpoint.state = 'committed';
      const materialized = materializeCheckpoint(checkpoint);
      if (!materialized) {
        throw new Error(
          `Checkpoint ${checkpoint.id} lost its canonical archive bytes while saving.`,
        );
      }
      await this.db.transaction(
        'rw',
        [this.db.projects, this.db.checkpoints],
        async () => {
          const current = await this.db.projects.get(input.projectId);
          if (!current) {
            throw new Error(`Unknown project: ${input.projectId}`);
          }
          if (current.headCheckpointId !== checkpoint.parentId) {
            throw new Error(
              `Checkpoint conflict for ${input.projectId}: the head changed while saving.`,
            );
          }
          // Deliberately a full put, not Table.update({ state }): Dexie's
          // update/modify path re-reads the stored record, deep-clones it, and
          // writes the clone back — and that clone step mangles the stored
          // ArrayBuffer payload into a plain object. Re-putting the canonical
          // in-memory record keeps archiveBytes intact and also resurrects the
          // row if a concurrent recovery pass deleted the writing marker.
          await this.db.checkpoints.put(checkpoint);
          await this.db.projects.put({
            ...current,
            headCheckpointId: checkpoint.id,
            updatedAt: now(),
          });
        },
      );
      return materialized;
    } catch (error) {
      // Leaving a writing record is safe, but a best-effort cleanup prevents
      // quota being consumed when the app itself catches the failure. Only
      // remove the durable writing marker: a committed row may already be a
      // project head if the storage engine reports a late transaction error.
      await this.db
        .transaction(
          'rw',
          [this.db.projects, this.db.checkpoints],
          async () => {
            const [project, stored] = await Promise.all([
              this.db.projects.get(input.projectId),
              this.db.checkpoints.get(checkpoint.id),
            ]);
            if (
              stored?.state === 'writing' &&
              project?.headCheckpointId !== checkpoint.id
            ) {
              await this.db.checkpoints.delete(checkpoint.id);
            }
          },
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async getHeadCheckpoint(projectId: string): Promise<VaultCheckpoint | null> {
    const project = await this.db.projects.get(projectId);
    if (!project?.headCheckpointId) return null;
    const checkpoint = await this.db.checkpoints.get(project.headCheckpointId);
    return checkpoint?.state === 'committed'
      ? materializeCheckpoint(checkpoint)
      : null;
  }

  async getRestorableCheckpoint(projectId: string): Promise<{
    checkpoint: VaultCheckpoint | null;
    skippedCorrupt: number;
  }> {
    const project = await this.db.projects.get(projectId);
    if (!project?.headCheckpointId) {
      return { checkpoint: null, skippedCorrupt: 0 };
    }

    const tried = new Set<string>();
    let skippedCorrupt = 0;
    let checkpointId: string | null = project.headCheckpointId;
    while (checkpointId && !tried.has(checkpointId)) {
      tried.add(checkpointId);
      const checkpoint: StoredVaultCheckpoint | undefined =
        await this.db.checkpoints.get(checkpointId);
      if (!checkpoint || checkpoint.projectId !== projectId) {
        break;
      }
      if (await isVerifiedCheckpoint(checkpoint)) {
        const materialized = materializeCheckpoint(checkpoint);
        if (materialized) {
          return { checkpoint: materialized, skippedCorrupt };
        }
      }
      skippedCorrupt += 1;
      checkpointId = checkpoint.parentId;
    }

    // A missing head record cannot tell us its parent. Retained committed
    // checkpoints are still useful, so inspect the remaining records newest
    // first and recover the first byte-for-byte verified archive.
    for (const checkpoint of await this.listStoredCheckpoints(projectId)) {
      if (tried.has(checkpoint.id)) continue;
      tried.add(checkpoint.id);
      if (await isVerifiedCheckpoint(checkpoint)) {
        const materialized = materializeCheckpoint(checkpoint);
        if (materialized) {
          return { checkpoint: materialized, skippedCorrupt };
        }
      }
      skippedCorrupt += 1;
    }
    return { checkpoint: null, skippedCorrupt };
  }

  async listCheckpoints(projectId: string): Promise<VaultCheckpoint[]> {
    return (await this.listStoredCheckpoints(projectId))
      .map(materializeCheckpoint)
      .filter(
        (checkpoint): checkpoint is VaultCheckpoint => checkpoint !== null,
      );
  }

  private async listStoredCheckpoints(
    projectId: string,
  ): Promise<StoredVaultCheckpoint[]> {
    const checkpoints = await this.db.checkpoints
      .where('projectId')
      .equals(projectId)
      .toArray();
    return checkpoints
      .filter((checkpoint) => checkpoint.state === 'committed')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async pruneCheckpoints(projectId: string, keep = 10): Promise<void> {
    const project = await this.db.projects.get(projectId);
    const checkpoints = await this.listStoredCheckpoints(projectId);
    const retained = new Set(
      checkpoints.slice(0, Math.max(keep, 1)).map((checkpoint) => checkpoint.id),
    );
    if (project?.headCheckpointId) retained.add(project.headCheckpointId);
    const stale = checkpoints.filter((checkpoint) => !retained.has(checkpoint.id));
    await this.db.checkpoints.bulkDelete(stale.map((checkpoint) => checkpoint.id));
  }

  async createConversation(input: {
    projectId: string;
    title: string;
    provider?: VaultConversation['provider'];
    model: string;
  }): Promise<VaultConversation> {
    const timestamp = now();
    const conversation: VaultConversation = {
      id: createId('conversation'),
      projectId: input.projectId,
      title: input.title.trim() || 'New conversation',
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'active',
      provider: input.provider ?? 'google-interactions',
      model: input.model,
      previousInteractionId: null,
      harnessSession: null,
      summary: '',
      lastEventSequence: 0,
    };
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        const project = await this.db.projects.get(input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);
        await this.db.conversations.add(conversation);
        await this.db.projects.put({
          ...project,
          activeConversationId: conversation.id,
          updatedAt: timestamp,
        });
      },
    );
    return conversation;
  }

  async renameConversation(
    conversationId: string,
    title: string,
  ): Promise<VaultConversation> {
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        const conversation = await this.db.conversations.get(conversationId);
        if (!conversation) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }
        if (!(await this.db.projects.get(conversation.projectId))) {
          throw new Error(`Unknown project: ${conversation.projectId}`);
        }
        // Patch only the renamed fields. Writing the whole record back would
        // clobber fields a concurrent writer just advanced (lastEventSequence,
        // harnessSession, previousInteractionId, ...).
        const patch = {
          title: title.trim() || 'New conversation',
          updatedAt: now(),
        };
        await this.db.conversations.update(conversationId, patch);
        return { ...conversation, ...patch };
      },
    );
  }

  async getOrCreateActiveConversation(input: {
    projectId: string;
    title: string;
    provider?: VaultConversation['provider'];
    model: string;
  }): Promise<VaultConversation> {
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        const project = await this.db.projects.get(input.projectId);
        if (!project) throw new Error(`Unknown project: ${input.projectId}`);

        if (project.activeConversationId) {
          const active = await this.db.conversations.get(
            project.activeConversationId,
          );
          if (active) return active;
        }

        const timestamp = now();
        const conversation: VaultConversation = {
          id: createId('conversation'),
          projectId: input.projectId,
          title: input.title.trim() || 'New conversation',
          createdAt: timestamp,
          updatedAt: timestamp,
          status: 'active',
          provider: input.provider ?? 'google-interactions',
          model: input.model,
          previousInteractionId: null,
          harnessSession: null,
          summary: '',
          lastEventSequence: 0,
        };
        await this.db.conversations.add(conversation);
        await this.db.projects.put({
          ...project,
          activeConversationId: conversation.id,
          updatedAt: timestamp,
        });
        return conversation;
      },
    );
  }

  async setActiveConversation(
    projectId: string,
    conversationId: string,
  ): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        const project = await this.db.projects.get(projectId);
        if (!project) throw new Error(`Unknown project: ${projectId}`);
        const conversation = await this.db.conversations.get(conversationId);
        if (!conversation || conversation.projectId !== projectId) {
          throw new Error(
            `Conversation ${conversationId} does not belong to ${projectId}.`,
          );
        }
        await this.db.projects.put({
          ...project,
          activeConversationId: conversationId,
          updatedAt: now(),
        });
      },
    );
  }

  async listConversations(projectId: string): Promise<VaultConversation[]> {
    const conversations = await this.db.conversations
      .where('projectId')
      .equals(projectId)
      .toArray();
    return conversations.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async getConversation(
    conversationId: string,
  ): Promise<VaultConversation | undefined> {
    return this.db.conversations.get(conversationId);
  }

  /**
   * Break every provider-side continuation chain after the workspace has been
   * rolled back to an older verified checkpoint. Provider interaction ids can
   * encode assumptions about files that no longer exist, so all conversations
   * for the project must reconstruct context from their preserved transcript
   * and the restored workspace on their next turn.
   */
  async invalidateProjectProviderContinuations(
    projectId: string,
  ): Promise<number> {
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        if (!(await this.db.projects.get(projectId))) {
          throw new Error(`Unknown project: ${projectId}`);
        }

        const conversations = await this.db.conversations
          .where('projectId')
          .equals(projectId)
          .toArray();
        const invalidatedAt = now();
        const invalidated = conversations.map((conversation) => {
          const harnessSession = conversation.harnessSession
            ? structuredClone(conversation.harnessSession)
            : null;
          if (harnessSession) {
            harnessSession.previousInteractionId = null;
            harnessSession.updatedAt = invalidatedAt;
            harnessSession.providerState = {
              ...harnessSession.providerState,
              pendingProviderTurn: false,
              interruptedDuringTools: false,
            };
          }
          return {
            ...conversation,
            previousInteractionId: null,
            harnessSession,
          } satisfies VaultConversation;
        });

        if (invalidated.length > 0) {
          await this.db.conversations.bulkPut(invalidated);
        }
        return invalidated.length;
      },
    );
  }

  async saveConversationHarnessSession(
    conversationId: string,
    session: CodingHarnessSession,
  ): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.conversations],
      async () => {
        const conversation = await this.db.conversations.get(conversationId);
        if (!conversation) {
          throw new Error(`Unknown conversation: ${conversationId}`);
        }
        if (!(await this.db.projects.get(conversation.projectId))) {
          throw new Error(`Unknown project: ${conversation.projectId}`);
        }
        if (session.provider !== conversation.provider) {
          throw new Error(
            `Cannot save a ${session.provider} session in a ${conversation.provider} conversation.`,
          );
        }
        await this.db.conversations.put({
          ...conversation,
          model: session.model,
          previousInteractionId: session.previousInteractionId,
          harnessSession: structuredClone(session),
          status: 'active',
          updatedAt: now(),
        });
      },
    );
  }

  async appendConversationEvent(input: {
    conversationId: string;
    role: VaultConversationEvent['role'];
    kind: string;
    payload: unknown;
    interactionId?: string | null;
    toolCallId?: string | null;
  }): Promise<VaultConversationEvent> {
    return this.db.transaction(
      'rw',
      [
        this.db.projects,
        this.db.conversations,
        this.db.conversationEvents,
      ],
      async () => {
        const conversation = await this.db.conversations.get(input.conversationId);
        if (!conversation) {
          throw new Error(`Unknown conversation: ${input.conversationId}`);
        }
        if (!(await this.db.projects.get(conversation.projectId))) {
          throw new Error(`Unknown project: ${conversation.projectId}`);
        }
        const sequence = conversation.lastEventSequence + 1;
        const createdAt = now();
        const event: VaultConversationEvent = {
          id: `${conversation.id}:${sequence}`,
          conversationId: conversation.id,
          projectId: conversation.projectId,
          sequence,
          role: input.role,
          kind: input.kind,
          payload: input.payload,
          interactionId: input.interactionId ?? null,
          toolCallId: input.toolCallId ?? null,
          createdAt,
        };
        await this.db.conversationEvents.add(event);
        await this.db.conversations.put({
          ...conversation,
          updatedAt: createdAt,
          lastEventSequence: sequence,
          previousInteractionId:
            input.interactionId ?? conversation.previousInteractionId,
        });
        return event;
      },
    );
  }

  async listConversationEvents(
    conversationId: string,
  ): Promise<VaultConversationEvent[]> {
    return this.db.conversationEvents
      .where('[conversationId+sequence]')
      .between([conversationId, Dexie.minKey], [conversationId, Dexie.maxKey])
      .sortBy('sequence');
  }

  async saveTerminalSession(session: VaultTerminalSession): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.projects, this.db.terminalSessions],
      async () => {
        if (!(await this.db.projects.get(session.projectId))) {
          throw new Error(`Unknown project: ${session.projectId}`);
        }
        await this.db.terminalSessions.put({ ...session, updatedAt: now() });
      },
    );
  }

  async patchTerminalSession(input: {
    id: string;
    projectId: string;
    title: string;
    cwd: string;
    appendCommand?: string;
    scrollback?: string;
  }): Promise<VaultTerminalSession> {
    return this.db.transaction(
      'rw',
      [this.db.projects, this.db.terminalSessions],
      async () => {
        if (!(await this.db.projects.get(input.projectId))) {
          throw new Error(`Unknown project: ${input.projectId}`);
        }
        const existing = await this.db.terminalSessions.get(input.id);
        if (existing && existing.projectId !== input.projectId) {
          throw new Error(
            `Terminal session ${input.id} does not belong to ${input.projectId}.`,
          );
        }
        const updatedAt = now();
        const session: VaultTerminalSession = {
          id: input.id,
          projectId: input.projectId,
          title: input.title,
          cwd: input.cwd,
          commandHistory:
            input.appendCommand === undefined
              ? (existing?.commandHistory ?? [])
              : [...(existing?.commandHistory ?? []), input.appendCommand].slice(
                  -500,
                ),
          scrollback: (input.scrollback ?? existing?.scrollback ?? '').slice(
            -100_000,
          ),
          updatedAt,
        };
        await this.db.terminalSessions.put(session);
        return session;
      },
    );
  }

  async listTerminalSessions(projectId: string): Promise<VaultTerminalSession[]> {
    const sessions = await this.db.terminalSessions
      .where('projectId')
      .equals(projectId)
      .toArray();
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async recoverIncompleteWrites(): Promise<number> {
    // Query and delete must share one transaction: with separate implicit
    // transactions, a concurrent tab's commit can promote a queried record to
    // 'committed' (and make it the project head) between the read and the
    // delete. The state-conditional delete removes only records still in
    // 'writing' state at delete time, so a committed head is never removed.
    const incomplete = await this.db.transaction(
      'rw',
      [this.db.checkpoints],
      async () =>
        this.db.checkpoints.where('state').equals('writing').delete(),
    );
    const pendingWorkspaceDeletes = await this.db.settings
      .filter((setting) => setting.key.startsWith(PENDING_WORKSPACE_DELETE_PREFIX))
      .toArray();
    for (const pending of pendingWorkspaceDeletes) {
      if (typeof pending.value === 'string') {
        await this.deleteWorkspaceDatabase(pending.value, 250);
      }
    }
    return incomplete;
  }
}

export async function requestDurableBrowserStorage(): Promise<StorageDurability> {
  const storage = navigator.storage;
  if (!storage) {
    return { persisted: false, usageBytes: null, quotaBytes: null };
  }
  let persisted = (await storage.persisted?.()) ?? false;
  if (!persisted) {
    persisted = (await storage.persist?.()) ?? false;
  }
  const estimate = await storage.estimate?.();
  return {
    persisted,
    usageBytes: estimate?.usage ?? null,
    quotaBytes: estimate?.quota ?? null,
  };
}

let defaultVault: BrowserVault | null = null;

export function getBrowserVault(): BrowserVault {
  defaultVault ??= new BrowserVault();
  return defaultVault;
}
