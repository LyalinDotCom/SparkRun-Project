const WORKSPACE_LOCK_PREFIX = 'sparkrun:workspace:v1:';

export type WorkspaceLeaseErrorCode =
  | 'invalid-project'
  | 'unsupported'
  | 'unavailable'
  | 'request-failed'
  | 'release-failed';

/** A stable, UI-friendly failure from the workspace lease boundary. */
export class WorkspaceLeaseError extends Error {
  readonly code: WorkspaceLeaseErrorCode;

  constructor(
    code: WorkspaceLeaseErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkspaceLeaseError';
    this.code = code;
  }
}

/**
 * The subset of LockManager used here. Keeping this surface small makes the
 * lease independently testable without pretending a fake implements query().
 */
export type WorkspaceLockRequestOptions =
  | { mode: 'exclusive'; ifAvailable: true }
  | { mode: 'exclusive'; steal: true };

export interface WorkspaceLockManager {
  request(
    name: string,
    options: WorkspaceLockRequestOptions,
    callback: (lock: Lock | null) => void | Promise<void>,
  ): Promise<unknown>;
}

export interface WorkspaceLease {
  readonly projectId: string;
  readonly lockName: string;
  /** True only after the browser confirms the request callback has ended. */
  readonly released: boolean;
  /**
   * Ends the lock callback and waits for LockManager.request() to settle.
   * Repeated calls return the same promise.
   */
  release(): Promise<void>;
}

export interface AcquireWorkspaceLeaseOptions {
  /** Dependency injection for tests. Passing null explicitly fails closed. */
  lockManager?: WorkspaceLockManager | null;
  /**
   * Take the workspace over from whichever tab holds it. The other tab's lock
   * request is aborted by the browser, so its lease reports released and it
   * cannot run further VM work; this tab becomes the single owner. Only for an
   * explicit user action ("Take over in this tab"), never for automatic boots.
   */
  takeOver?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorCause(error: unknown): ErrorOptions | undefined {
  return error === undefined ? undefined : { cause: error };
}

function requestFailure(error: unknown): WorkspaceLeaseError {
  return error instanceof WorkspaceLeaseError
    ? error
    : new WorkspaceLeaseError(
        'request-failed',
        'The browser could not acquire the project workspace lock.',
        errorCause(error),
      );
}

function resolveLockManager(
  options: AcquireWorkspaceLeaseOptions,
): WorkspaceLockManager {
  let lockManager: WorkspaceLockManager | null | undefined;
  if (Object.prototype.hasOwnProperty.call(options, 'lockManager')) {
    lockManager = options.lockManager;
  } else {
    try {
      lockManager =
        typeof navigator === 'undefined'
          ? undefined
          : (navigator.locks as WorkspaceLockManager | undefined);
    } catch (error) {
      throw new WorkspaceLeaseError(
        'unsupported',
        'This browser cannot safely coordinate project workspaces with the Web Locks API.',
        errorCause(error),
      );
    }
  }

  if (!lockManager || typeof lockManager.request !== 'function') {
    throw new WorkspaceLeaseError(
      'unsupported',
      'This browser does not expose the Web Locks API, so SparkRun will not open the workspace unsafely.',
    );
  }
  return lockManager;
}

export function workspaceLeaseLockName(projectId: string): string {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new WorkspaceLeaseError(
      'invalid-project',
      'A non-empty project ID is required to acquire a workspace lease.',
    );
  }
  return `${WORKSPACE_LOCK_PREFIX}${projectId}`;
}

class HeldWorkspaceLease implements WorkspaceLease {
  readonly projectId: string;
  readonly lockName: string;

  #released = false;
  #releasePromise: Promise<void> | null = null;
  readonly #signalRelease: () => void;
  readonly #requestCompletion: Promise<void>;

  constructor(input: {
    projectId: string;
    lockName: string;
    signalRelease: () => void;
    requestCompletion: Promise<void>;
  }) {
    this.projectId = input.projectId;
    this.lockName = input.lockName;
    this.#signalRelease = input.signalRelease;
    this.#requestCompletion = input.requestCompletion;
  }

  get released(): boolean {
    return this.#released;
  }

  release(): Promise<void> {
    if (this.#releasePromise) return this.#releasePromise;

    this.#signalRelease();
    this.#releasePromise = this.#requestCompletion
      .catch((error) => {
        throw new WorkspaceLeaseError(
          'release-failed',
          'The browser reported an error while releasing the project workspace lock.',
          errorCause(error),
        );
      })
      .finally(() => {
        this.#released = true;
      });
    return this.#releasePromise;
  }
}

/**
 * Attempts to acquire this project's exclusive browser-wide workspace lease.
 *
 * `ifAvailable` is intentional: a second tab fails immediately instead of
 * queueing a hidden VM boot behind the first tab. The request callback remains
 * pending for the full lease lifetime and ends only when `release()` is called.
 */
export async function acquireWorkspaceLease(
  projectId: string,
  options: AcquireWorkspaceLeaseOptions = {},
): Promise<WorkspaceLease> {
  const lockName = workspaceLeaseLockName(projectId);
  const lockManager = resolveLockManager(options);
  const granted = deferred<void>();
  const releaseGate = deferred<void>();
  let callbackInvoked = false;
  let callbackGranted = false;
  let requestCompletion: Promise<void>;

  try {
    requestCompletion = Promise.resolve(
      lockManager.request(
        lockName,
        options.takeOver
          ? { mode: 'exclusive', steal: true }
          : { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (callbackInvoked) {
            throw new WorkspaceLeaseError(
              'request-failed',
              'The browser invoked the workspace lock callback more than once.',
            );
          }
          callbackInvoked = true;

          if (!lock) {
            granted.reject(
              new WorkspaceLeaseError(
                'unavailable',
                'This project is already open in another tab. Close that workspace before trying again.',
              ),
            );
            return;
          }

          callbackGranted = true;
          granted.resolve();
          await releaseGate.promise;
        },
      ),
    ).then(() => undefined);
  } catch (error) {
    // A conforming LockManager throws before invoking the callback, but release
    // defensively if an injected or browser implementation did both.
    if (callbackGranted) releaseGate.resolve();
    throw requestFailure(error);
  }

  // Handle request failures immediately while acquisition is pending. Keeping
  // this rejection handler attached also prevents a later browser-side failure
  // from becoming an unhandled rejection while the caller still owns a lease.
  void requestCompletion.catch((error) => {
    if (!callbackGranted) granted.reject(requestFailure(error));
  });

  await granted.promise;
  return new HeldWorkspaceLease({
    projectId,
    lockName,
    signalRelease: () => releaseGate.resolve(),
    requestCompletion,
  });
}
