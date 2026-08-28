import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_PROJECT_SETTING_KEY,
  BrowserVault,
  createVaultProjectDraft,
  projectSourceDirectorySettingKey,
} from './browserVault';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('BrowserVault', () => {
  let vault: BrowserVault;

  beforeEach(async () => {
    vault = new BrowserVault(`sparkrun-vault-test-${crypto.randomUUID()}`);
    await vault.open();
  });

  afterEach(async () => {
    await vault.delete();
  });

  it('commits binary checkpoints atomically and advances the project head', async () => {
    const project = await vault.createProject({
      name: 'Durable app',
      prompt: 'Build it',
    });
    const first = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob([new Uint8Array([0, 1, 2, 255])]),
      reason: 'manual',
      expectedParentId: null,
    });

    expect(first.state).toBe('committed');
    expect(first.format).toBe('tar.gz');
    expect(first.sizeBytes).toBe(4);
    expect(first.archiveSha256).toHaveLength(64);
    expect((await vault.getHeadCheckpoint(project.id))?.id).toBe(first.id);
    const storedFirst = await vault.db.checkpoints.get(first.id);
    expect(Object.prototype.toString.call(storedFirst?.archiveBytes)).toBe(
      '[object ArrayBuffer]',
    );
    expect(storedFirst?.archiveBytes.byteLength).toBe(first.sizeBytes);

    const second = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['next']),
      reason: 'terminal-command',
      expectedParentId: first.id,
    });
    expect(second.parentId).toBe(first.id);
    expect((await vault.listCheckpoints(project.id)).map((item) => item.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('rejects a stale checkpoint writer without replacing the valid head', async () => {
    const project = await vault.createProject({ name: 'Race', prompt: '' });
    const current = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['current']),
      reason: 'manual',
      expectedParentId: null,
    });

    await expect(
      vault.commitCheckpoint({
        projectId: project.id,
        archive: new Blob(['stale']),
        reason: 'manual',
        expectedParentId: null,
      }),
    ).rejects.toThrow('Checkpoint conflict');
    expect((await vault.getHeadCheckpoint(project.id))?.id).toBe(current.id);
    expect(
      await vault.db.checkpoints.where('projectId').equals(project.id).count(),
    ).toBe(1);
  });

  it('does not advance the head when checkpoint materialization fails', async () => {
    const project = await vault.createProject({
      name: 'Materialization failure',
      prompt: '',
    });
    const parent = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['safe-parent']),
      reason: 'manual',
    });
    const archive = new Blob(['unmaterializable']);
    const readArchive = archive.arrayBuffer.bind(archive);
    const NativeBlob = globalThis.Blob;
    Object.defineProperty(archive, 'arrayBuffer', {
      value: async () => {
        const bytes = await readArchive();
        globalThis.Blob = class ThrowingBlob {
          constructor() {
            throw new Error('simulated Blob construction failure');
          }
        } as typeof Blob;
        return bytes;
      },
    });

    try {
      await expect(
        vault.commitCheckpoint({
          projectId: project.id,
          archive,
          reason: 'manual',
          expectedParentId: parent.id,
        }),
      ).rejects.toThrow('lost its canonical archive bytes');
    } finally {
      globalThis.Blob = NativeBlob;
    }

    expect((await vault.getProject(project.id))?.headCheckpointId).toBe(
      parent.id,
    );
    expect((await vault.getHeadCheckpoint(project.id))?.id).toBe(parent.id);
    expect(
      await vault.db.checkpoints.where('projectId').equals(project.id).count(),
    ).toBe(1);
  });

  it('verifies checkpoint bytes and falls back to the newest valid parent', async () => {
    const project = await vault.createProject({ name: 'Fallback', prompt: '' });
    const parent = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['safe-parent']),
      reason: 'manual',
    });
    const head = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['safe-head']),
      reason: 'manual',
      expectedParentId: parent.id,
    });
    // Preserve the recorded byte count so the SHA-256 check, not just the
    // inexpensive size guard, proves the archive was altered.
    await vault.db.checkpoints.update(head.id, {
      archiveBytes: await new Blob(['evil-head']).arrayBuffer(),
    });
    const storedHead = await vault.db.checkpoints.get(head.id);
    const storedParent = await vault.db.checkpoints.get(parent.id);
    expect(storedHead?.parentId).toBe(parent.id);
    expect(storedHead?.archiveBytes.byteLength).toBe(head.sizeBytes);
    expect(storedParent?.archiveBytes.byteLength).toBe(parent.sizeBytes);

    const recovered = await vault.getRestorableCheckpoint(project.id);

    expect(recovered.checkpoint?.id).toBe(parent.id);
    expect(recovered.skippedCorrupt).toBe(1);
    expect(
      new TextDecoder().decode(
        await recovered.checkpoint?.archive.arrayBuffer(),
      ),
    ).toBe('safe-parent');
  });

  it('recovers the newest verified checkpoint when the recorded head is missing', async () => {
    const project = await vault.createProject({
      name: 'Missing head fallback',
      prompt: '',
    });
    const parent = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['retained-parent']),
      reason: 'manual',
    });
    const head = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['missing-head']),
      reason: 'manual',
      expectedParentId: parent.id,
    });
    await vault.db.checkpoints.delete(head.id);

    const recovered = await vault.getRestorableCheckpoint(project.id);

    expect(recovered.checkpoint?.id).toBe(parent.id);
    expect(recovered.skippedCorrupt).toBe(0);
  });

  it('round-trips canonical checkpoint bytes through a reopened IndexedDB', async () => {
    const project = await vault.createProject({
      name: 'Reopen',
      prompt: '',
    });
    const checkpoint = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob([new Uint8Array([0, 17, 128, 255])]),
      reason: 'manual',
    });
    const databaseName = vault.db.name;
    await vault.close();
    vault = new BrowserVault(databaseName);
    await vault.open();

    const recovered = await vault.getRestorableCheckpoint(project.id);

    expect(recovered.checkpoint?.id).toBe(checkpoint.id);
    expect(
      Array.from(
        new Uint8Array(await recovered.checkpoint!.archive.arrayBuffer()),
      ),
    ).toEqual([0, 17, 128, 255]);
    expect(recovered.skippedCorrupt).toBe(0);
  });

  it('updates editable metadata without rolling back checkpoint or conversation heads', async () => {
    const original = await vault.createProject({
      name: 'Before rename',
      prompt: 'Build it',
    });
    const conversation = await vault.createConversation({
      projectId: original.id,
      title: 'Build',
      model: 'gemini-3.7-flash',
    });
    const checkpoint = await vault.commitCheckpoint({
      projectId: original.id,
      archive: new Blob(['durable']),
      reason: 'manual',
    });

    const stored = await vault.saveProjectMetadata({
      ...original,
      name: 'After rename',
      prompt: 'Improve it',
    });

    expect(stored).toMatchObject({
      name: 'After rename',
      prompt: 'Improve it',
      headCheckpointId: checkpoint.id,
      activeConversationId: conversation.id,
    });
    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBe(
      original.id,
    );
  });

  it('renames a new conversation without losing its durable state', async () => {
    const project = await vault.createProject({
      name: 'Conversation titles',
      prompt: '',
    });
    const conversation = await vault.createConversation({
      projectId: project.id,
      title: 'New conversation',
      model: 'gemini-3.7-flash',
    });

    const renamed = await vault.renameConversation(
      conversation.id,
      'Build the operations dashboard',
    );

    expect(renamed).toMatchObject({
      id: conversation.id,
      projectId: project.id,
      title: 'Build the operations dashboard',
      previousInteractionId: null,
      harnessSession: null,
    });
    expect((await vault.getConversation(conversation.id))?.title).toBe(
      'Build the operations dashboard',
    );
  });

  it('does not let a late metadata update roll back active-project selection', async () => {
    const earlier = await vault.createProject({
      id: 'earlier-project',
      name: 'Earlier',
      prompt: '',
    });
    const selected = await vault.createProject({
      id: 'selected-project',
      name: 'Selected',
      prompt: '',
    });
    const release = deferred();
    const lateSave = release.promise.then(() =>
      vault.saveProjectMetadata({ ...earlier, name: 'Late rename' }),
    );

    release.resolve();
    await lateSave;

    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBe(
      selected.id,
    );
    expect((await vault.getProject(earlier.id))?.name).toBe('Late rename');
  });

  it('does not let an idempotent project ensure roll back active selection', async () => {
    const earlier = await vault.createProject({
      id: 'ensure-earlier-project',
      name: 'Earlier',
      prompt: '',
    });
    const selected = await vault.createProject({
      id: 'ensure-selected-project',
      name: 'Selected',
      prompt: '',
    });

    await vault.createProject({
      id: earlier.id,
      name: earlier.name,
      prompt: earlier.prompt,
    });

    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBe(
      selected.id,
    );
  });

  it('still persists and activates a new untombstoned metadata draft', async () => {
    const draft = createVaultProjectDraft({
      id: 'intentional-metadata-create',
      name: 'Intentional create',
      prompt: 'Create it',
    });

    const stored = await vault.saveProjectMetadata(draft);

    expect(await vault.getProject(stored.id)).toMatchObject({
      name: 'Intentional create',
      prompt: 'Create it',
    });
    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBe(stored.id);
  });

  it('coalesces concurrent creation of the same logical project', async () => {
    const peer = new BrowserVault(vault.db.name);
    await peer.open();
    try {
      const [first, second] = await Promise.all([
        vault.createProject({
          id: 'shared-project',
          name: 'First startup',
          prompt: 'Build it',
        }),
        peer.createProject({
          id: 'shared-project',
          name: 'Second startup',
          prompt: 'Build it',
        }),
      ]);

      expect(second.id).toBe(first.id);
      expect(await vault.db.projects.where('id').equals(first.id).count()).toBe(1);
    } finally {
      await peer.close();
    }
  });

  it('persists multiple conversations and strictly ordered events', async () => {
    const project = await vault.createProject({ name: 'Chat app', prompt: '' });
    const first = await vault.createConversation({
      projectId: project.id,
      title: 'Build the app',
      model: 'gemini-3.7-flash',
    });
    const second = await vault.createConversation({
      projectId: project.id,
      title: 'Review the app',
      model: 'gemini-3.7-flash',
    });

    await vault.appendConversationEvent({
      conversationId: first.id,
      role: 'user',
      kind: 'message',
      payload: { text: 'Hello' },
    });
    await vault.appendConversationEvent({
      conversationId: first.id,
      role: 'assistant',
      kind: 'message',
      payload: { text: 'Working' },
      interactionId: 'interaction-1',
    });

    const events = await vault.listConversationEvents(first.id);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(events[1].interactionId).toBe('interaction-1');
    expect((await vault.listConversations(project.id)).map((item) => item.id)).toContain(
      second.id,
    );
    expect((await vault.getProject(project.id))?.activeConversationId).toBe(second.id);
  });

  it('invalidates project provider continuations after rollback without losing transcripts or events', async () => {
    const project = await vault.createProject({
      id: 'rolled-back-project',
      name: 'Rolled back',
      prompt: '',
    });
    const first = await vault.createConversation({
      projectId: project.id,
      title: 'First conversation',
      model: 'gemini-3.7-flash',
    });
    const second = await vault.createConversation({
      projectId: project.id,
      title: 'Second conversation',
      model: 'gemini-3.7-flash',
    });
    const unrelatedProject = await vault.createProject({
      id: 'unrelated-project',
      name: 'Unrelated',
      prompt: '',
    });
    const unrelated = await vault.createConversation({
      projectId: unrelatedProject.id,
      title: 'Unrelated conversation',
      model: 'gemini-3.7-flash',
    });
    const timestamp = '2026-08-28T12:00:00.000Z';
    const transcript = [
      {
        id: 'saved-tool-result',
        createdAt: timestamp,
        role: 'tool' as const,
        kind: 'tool-result' as const,
        content: 'Wrote src/app.ts successfully.',
        interactionId: 'first-interaction',
        toolCallId: 'write-app',
        toolName: 'write_file',
      },
    ];
    await vault.saveConversationHarnessSession(first.id, {
      version: 1,
      id: 'first-session',
      provider: 'google-interactions',
      model: 'gemini-3.7-flash',
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: 'first-interaction',
      transcript,
      providerState: {
        interactionCount: 4,
        pendingProviderTurn: true,
        interruptedDuringTools: true,
        runtimeId: 'old-runtime',
      },
    });
    await vault.appendConversationEvent({
      conversationId: first.id,
      role: 'tool',
      kind: 'tool-result',
      payload: { text: 'Wrote src/app.ts successfully.' },
      interactionId: 'first-interaction',
      toolCallId: 'write-app',
    });
    await vault.appendConversationEvent({
      conversationId: second.id,
      role: 'assistant',
      kind: 'message',
      payload: { text: 'Second context' },
      interactionId: 'second-interaction',
    });
    await vault.saveConversationHarnessSession(unrelated.id, {
      version: 1,
      id: 'unrelated-session',
      provider: 'google-interactions',
      model: 'gemini-3.7-flash',
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: 'unrelated-interaction',
      transcript: [],
      providerState: { pendingProviderTurn: true },
    });
    const eventsBefore = await vault.listConversationEvents(first.id);

    await expect(
      vault.invalidateProjectProviderContinuations(project.id),
    ).resolves.toBe(2);

    const invalidatedFirst = await vault.getConversation(first.id);
    expect(invalidatedFirst?.previousInteractionId).toBeNull();
    expect(invalidatedFirst?.harnessSession).toMatchObject({
      previousInteractionId: null,
      transcript,
      providerState: {
        interactionCount: 4,
        pendingProviderTurn: false,
        interruptedDuringTools: false,
        runtimeId: 'old-runtime',
      },
    });
    expect(await vault.getConversation(second.id)).toMatchObject({
      previousInteractionId: null,
      harnessSession: null,
    });
    expect(await vault.listConversationEvents(first.id)).toEqual(eventsBefore);
    expect(await vault.getConversation(unrelated.id)).toMatchObject({
      previousInteractionId: 'unrelated-interaction',
      harnessSession: {
        previousInteractionId: 'unrelated-interaction',
        providerState: { pendingProviderTurn: true },
      },
    });
  });

  it('rejects provider-continuation invalidation for an unknown project', async () => {
    await expect(
      vault.invalidateProjectProviderContinuations('missing-project'),
    ).rejects.toThrow('Unknown project: missing-project');
  });

  it('coalesces concurrent default-conversation initialization', async () => {
    const project = await vault.createProject({
      id: 'conversation-race-project',
      name: 'Conversation race',
      prompt: '',
    });
    const peer = new BrowserVault(vault.db.name);
    await peer.open();
    try {
      const [first, second] = await Promise.all([
        vault.getOrCreateActiveConversation({
          projectId: project.id,
          title: 'First initializer',
          model: 'gemini-3.7-flash',
        }),
        peer.getOrCreateActiveConversation({
          projectId: project.id,
          title: 'Second initializer',
          model: 'gemini-3.7-flash',
        }),
      ]);

      expect(second.id).toBe(first.id);
      expect(
        await vault.db.conversations.where('projectId').equals(project.id).count(),
      ).toBe(1);
    } finally {
      await peer.close();
    }
  });

  it('recovers abandoned writing markers without touching the committed head', async () => {
    const project = await vault.createProject({ name: 'Recovery', prompt: '' });
    const head = await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['safe']),
      reason: 'manual',
    });
    const storedHead = await vault.db.checkpoints.get(head.id);
    expect(storedHead).toBeDefined();
    await vault.db.checkpoints.add({
      ...storedHead!,
      id: 'checkpoint-incomplete',
      state: 'writing',
      parentId: head.id,
    });

    expect(await vault.recoverIncompleteWrites()).toBe(1);
    expect((await vault.getHeadCheckpoint(project.id))?.id).toBe(head.id);
  });

  it('removes project-scoped settings with the project', async () => {
    const project = await vault.createProject({ name: 'Delete me', prompt: '' });
    const settingKey = projectSourceDirectorySettingKey(project.id);
    await vault.putSetting(settingKey, { name: 'project-folder' });

    await vault.deleteProject(project.id);

    expect(await vault.getProject(project.id)).toBeUndefined();
    expect(await vault.getSetting(settingKey)).toBeUndefined();
    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBeUndefined();
  });

  it('does not resurrect a deleted project when an in-flight build saves late', async () => {
    const project = await vault.createProject({
      name: 'Delete me',
      prompt: 'Build it',
    });
    await vault.deleteProject(project.id);

    await expect(
      vault.saveProjectMetadata(
        { ...project, prompt: 'Late build result' },
        { requireExisting: true },
      ),
    ).rejects.toThrow(`Unknown project: ${project.id}`);
    expect(await vault.getProject(project.id)).toBeUndefined();
  });

  it('tombstones deletion against a deferred unguarded metadata create', async () => {
    const project = await vault.createProject({
      id: 'late-metadata-project',
      name: 'Delete me',
      prompt: 'Before deletion',
    });
    const selected = await vault.createProject({
      id: 'metadata-survivor',
      name: 'Keep me',
      prompt: '',
    });
    const release = deferred();
    const lateSave = release.promise.then(() =>
      vault.saveProjectMetadata({
        ...project,
        prompt: 'Late metadata write',
      }),
    );

    await vault.deleteProject(project.id);
    const rejectedSave = expect(lateSave).rejects.toThrow(
      `Unknown project: ${project.id}`,
    );
    release.resolve();
    await rejectedSave;

    await expect(
      vault.createProject({
        id: project.id,
        name: 'Late recreation',
        prompt: '',
      }),
    ).rejects.toThrow(`Unknown project: ${project.id}`);
    expect(await vault.getProject(project.id)).toBeUndefined();
    expect(await vault.getSetting(ACTIVE_PROJECT_SETTING_KEY)).toBe(
      selected.id,
    );
  });

  it('rejects a checkpoint whose digest finishes after project deletion', async () => {
    const project = await vault.createProject({
      id: 'late-checkpoint-project',
      name: 'Late checkpoint',
      prompt: '',
    });
    await vault.commitCheckpoint({
      projectId: project.id,
      archive: new Blob(['committed before deletion']),
      reason: 'manual',
    });
    const digestStarted = deferred();
    const releaseDigest = deferred();
    const archive = new Blob(['late checkpoint']);
    const readArchive = archive.arrayBuffer.bind(archive);
    Object.defineProperty(archive, 'arrayBuffer', {
      value: async () => {
        digestStarted.resolve();
        await releaseDigest.promise;
        return readArchive();
      },
    });

    const lateCheckpoint = vault.commitCheckpoint({
      projectId: project.id,
      archive,
      reason: 'manual',
    });
    await digestStarted.promise;
    await vault.deleteProject(project.id);
    const rejectedCheckpoint = expect(lateCheckpoint).rejects.toThrow(
      `Unknown project: ${project.id}`,
    );
    releaseDigest.resolve();
    await rejectedCheckpoint;

    expect(await vault.getProject(project.id)).toBeUndefined();
    expect(
      await vault.db.checkpoints.where('projectId').equals(project.id).count(),
    ).toBe(0);
  });

  it('rejects deferred conversation writes after project deletion', async () => {
    const project = await vault.createProject({
      id: 'late-conversation-project',
      name: 'Late conversation',
      prompt: '',
    });
    const conversation = await vault.createConversation({
      projectId: project.id,
      title: 'Delete during event save',
      model: 'gemini-3.7-flash',
    });
    await vault.appendConversationEvent({
      conversationId: conversation.id,
      role: 'user',
      kind: 'message',
      payload: { text: 'Persisted before deletion' },
    });
    const release = deferred();
    const lateEvent = release.promise.then(() =>
      vault.appendConversationEvent({
        conversationId: conversation.id,
        role: 'assistant',
        kind: 'message',
        payload: { text: 'Too late' },
      }),
    );
    const lateHarnessSession = release.promise.then(() =>
      vault.saveConversationHarnessSession(conversation.id, {
        version: 1,
        id: 'late-session',
        provider: 'google-interactions',
        model: 'gemini-3.7-flash',
        createdAt: '2026-08-27T12:00:00.000Z',
        updatedAt: '2026-08-27T12:00:01.000Z',
        previousInteractionId: 'late-interaction',
        transcript: [],
        providerState: {},
      }),
    );

    await vault.deleteProject(project.id);
    const rejectedEvent = expect(lateEvent).rejects.toThrow(
      `Unknown conversation: ${conversation.id}`,
    );
    const rejectedSession = expect(lateHarnessSession).rejects.toThrow(
      `Unknown conversation: ${conversation.id}`,
    );
    release.resolve();
    await Promise.all([rejectedEvent, rejectedSession]);

    expect(await vault.getConversation(conversation.id)).toBeUndefined();
    expect(await vault.listConversationEvents(conversation.id)).toEqual([]);
  });

  it('rejects a deferred terminal save after project deletion', async () => {
    const project = await vault.createProject({
      id: 'late-terminal-project',
      name: 'Late terminal',
      prompt: '',
    });
    await vault.saveTerminalSession({
      id: `terminal-${project.id}`,
      projectId: project.id,
      title: 'Main terminal',
      cwd: '/workspace/site',
      commandHistory: ['echo before'],
      scrollback: 'before deletion',
      updatedAt: '2026-08-27T11:59:00.000Z',
    });
    const release = deferred();
    const lateTerminalSave = release.promise.then(() =>
      vault.saveTerminalSession({
        id: `terminal-${project.id}`,
        projectId: project.id,
        title: 'Main terminal',
        cwd: '/workspace/site',
        commandHistory: ['pwd'],
        scrollback: '/workspace/site',
        updatedAt: '2026-08-27T12:00:00.000Z',
      }),
    );

    await vault.deleteProject(project.id);
    const rejectedSave = expect(lateTerminalSave).rejects.toThrow(
      `Unknown project: ${project.id}`,
    );
    release.resolve();
    await rejectedSave;

    expect(await vault.listTerminalSessions(project.id)).toEqual([]);
  });

  it('atomically preserves rapid terminal commands and scrollback patches', async () => {
    const project = await vault.createProject({
      id: 'terminal-atomic-project',
      name: 'Terminal atomicity',
      prompt: '',
    });
    const id = `terminal-${project.id}`;
    await Promise.all([
      ...Array.from({ length: 20 }, (_, index) =>
        vault.patchTerminalSession({
          id,
          projectId: project.id,
          title: 'Main terminal',
          cwd: '/workspace/site',
          appendCommand: `command-${index}`,
        }),
      ),
      vault.patchTerminalSession({
        id,
        projectId: project.id,
        title: 'Main terminal',
        cwd: '/workspace/site',
        scrollback: 'latest scrollback',
      }),
    ]);

    const [session] = await vault.listTerminalSessions(project.id);
    expect(session.commandHistory).toHaveLength(20);
    expect(new Set(session.commandHistory)).toEqual(
      new Set(Array.from({ length: 20 }, (_, index) => `command-${index}`)),
    );
    expect(session.scrollback).toBe('latest scrollback');
  });
});
