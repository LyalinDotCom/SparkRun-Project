import { describe, expect, it, vi } from 'vitest';
import {
  acquireWorkspaceLease,
  workspaceLeaseLockName,
  type WorkspaceLockManager,
} from './workspaceLease';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeLockManager implements WorkspaceLockManager {
  readonly held = new Set<string>();
  readonly calls: Array<{
    name: string;
    options: { mode: 'exclusive'; ifAvailable: true };
  }> = [];
  completedRequests = 0;
  requestError: unknown = null;
  throwSynchronously: unknown = null;
  failAfterCallback: unknown = null;
  finalizeAfter: Promise<void> | null = null;

  request(
    name: string,
    options: { mode: 'exclusive'; ifAvailable: true },
    callback: (lock: Lock | null) => void | Promise<void>,
  ): Promise<unknown> {
    this.calls.push({ name, options });
    if (this.throwSynchronously) throw this.throwSynchronously;
    if (this.requestError) return Promise.reject(this.requestError);
    if (this.held.has(name)) return Promise.resolve(callback(null));

    this.held.add(name);
    return Promise.resolve(
      callback({ name, mode: 'exclusive' } as Lock),
    )
      .then(async () => {
        if (this.finalizeAfter) await this.finalizeAfter;
        if (this.failAfterCallback) throw this.failAfterCallback;
      })
      .finally(() => {
        this.held.delete(name);
        this.completedRequests += 1;
      });
  }
}

describe('workspace lease', () => {
  it('holds an exclusive per-project Web Lock until release completes', async () => {
    const manager = new FakeLockManager();
    const lease = await acquireWorkspaceLease('project-a', {
      lockManager: manager,
    });

    expect(manager.calls).toEqual([
      {
        name: workspaceLeaseLockName('project-a'),
        options: { mode: 'exclusive', ifAvailable: true },
      },
    ]);
    expect(manager.held.has(lease.lockName)).toBe(true);
    expect(manager.completedRequests).toBe(0);
    expect(lease.released).toBe(false);

    await lease.release();

    expect(manager.held.has(lease.lockName)).toBe(false);
    expect(manager.completedRequests).toBe(1);
    expect(lease.released).toBe(true);
  });

  it('fails immediately instead of queueing when another tab holds the project', async () => {
    const manager = new FakeLockManager();
    const first = await acquireWorkspaceLease('shared-project', {
      lockManager: manager,
    });

    await expect(
      acquireWorkspaceLease('shared-project', { lockManager: manager }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(manager.calls[1]?.options.ifAvailable).toBe(true);

    await first.release();
    const afterRelease = await acquireWorkspaceLease('shared-project', {
      lockManager: manager,
    });
    await afterRelease.release();
  });

  it('allows different projects to hold independent leases', async () => {
    const manager = new FakeLockManager();
    const first = await acquireWorkspaceLease('project-a', {
      lockManager: manager,
    });
    const second = await acquireWorkspaceLease('project-b', {
      lockManager: manager,
    });

    expect(manager.held).toEqual(
      new Set([first.lockName, second.lockName]),
    );

    await Promise.all([first.release(), second.release()]);
  });

  it('makes release idempotent and waits for browser finalization', async () => {
    const manager = new FakeLockManager();
    const finalization = deferred();
    manager.finalizeAfter = finalization.promise;
    const lease = await acquireWorkspaceLease('project-a', {
      lockManager: manager,
    });

    const firstRelease = lease.release();
    const secondRelease = lease.release();
    let settled = false;
    void firstRelease.finally(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(secondRelease).toBe(firstRelease);
    expect(settled).toBe(false);
    expect(lease.released).toBe(false);

    finalization.resolve();
    await firstRelease;
    expect(settled).toBe(true);
    expect(lease.released).toBe(true);
  });

  it('fails closed when Web Locks are unavailable', async () => {
    await expect(
      acquireWorkspaceLease('project-a', { lockManager: null }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('reports invalid project IDs before requesting a lock', async () => {
    const manager = new FakeLockManager();
    await expect(
      acquireWorkspaceLease('   ', { lockManager: manager }),
    ).rejects.toMatchObject({ code: 'invalid-project' });
    expect(manager.calls).toHaveLength(0);
  });

  it.each([
    ['synchronous', true],
    ['asynchronous', false],
  ])('normalizes %s request errors', async (_label, synchronous) => {
    const manager = new FakeLockManager();
    const cause = new Error('browser lock failure');
    if (synchronous) manager.throwSynchronously = cause;
    else manager.requestError = cause;

    await expect(
      acquireWorkspaceLease('project-a', { lockManager: manager }),
    ).rejects.toMatchObject({
      code: 'request-failed',
      cause,
    });
  });

  it('surfaces request completion errors from deterministic release', async () => {
    const manager = new FakeLockManager();
    const cause = new Error('callback completion failed');
    manager.failAfterCallback = cause;
    const lease = await acquireWorkspaceLease('project-a', {
      lockManager: manager,
    });

    await expect(lease.release()).rejects.toMatchObject({
      code: 'release-failed',
      cause,
    });
    expect(lease.released).toBe(true);
    expect(manager.held.has(lease.lockName)).toBe(false);
  });

  it('uses navigator.locks by default when the browser exposes it', async () => {
    const manager = new FakeLockManager();
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'locks',
    );
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: manager,
    });

    try {
      const lease = await acquireWorkspaceLease('default-manager');
      expect(manager.calls).toHaveLength(1);
      await lease.release();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(navigator, 'locks', originalDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'locks');
      }
    }
  });

  it('does not leave an unhandled rejection while an acquired request fails', async () => {
    const manager = new FakeLockManager();
    manager.failAfterCallback = new Error('late failure');
    const unhandled = vi.fn();
    window.addEventListener('unhandledrejection', unhandled);
    const lease = await acquireWorkspaceLease('project-a', {
      lockManager: manager,
    });

    await expect(lease.release()).rejects.toMatchObject({
      code: 'release-failed',
    });
    await Promise.resolve();
    window.removeEventListener('unhandledrejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
