import { describe, expect, it, vi } from 'vitest';
import { MODEL_ID } from './constants';
import type {
  CodingHarnessSession,
  CodingRuntime,
  CodingRuntimeCommandOptions,
  CodingRuntimeDirectoryEntry,
  CodingRuntimePreviewOptions,
  CodingRuntimePreviewResult,
} from './codingHarness';
import {
  CODING_APPEND_FILE_TOOL,
  CODING_READ_FILE_TOOL,
  CODING_REPLACE_TOOL,
  CODING_RUN_COMMAND_TOOL,
  CODING_START_PREVIEW_TOOL,
  CODING_WRITE_FILE_TOOL,
  CODING_LIST_DIRECTORY_TOOL,
  executeCodingToolCall,
  normalizeCodingWorkspacePath,
  redactCodingSecrets,
} from './codingHarnessTools';
import {
  GEMINI_API_MAX_RETRIES,
  GEMINI_EXECUTION_RETRIES,
  GEMINI_INTERACTIONS_PROVIDER,
  GeminiInteractionsCodingHarness,
  type GeminiInteractionsClient,
  type GeminiInteractionResponse,
} from './geminiCodingHarness';

class MemoryCodingRuntime implements CodingRuntime {
  readonly id = 'test-runtime';
  readonly workspaceRoot = '/workspace';
  readonly files = new Map<string, string>();
  readonly commands: Array<{
    command: string;
    options?: CodingRuntimeCommandOptions;
  }> = [];
  readonly previews: CodingRuntimePreviewOptions[] = [];

  constructor(files: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
    }
  }

  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing file: ${path}`);
    return content;
  }

  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }

  async listDirectory(path: string): Promise<CodingRuntimeDirectoryEntry[]> {
    const prefix = path ? `${path}/` : '';
    const entries = new Map<string, CodingRuntimeDirectoryEntry>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      if (!rest) continue;
      const [name, ...tail] = rest.split('/');
      entries.set(`${prefix}${name}`, {
        path: `${prefix}${name}`,
        type: tail.length > 0 ? 'directory' : 'file',
      });
    }
    return [...entries.values()];
  }

  async runCommand(command: string, options?: CodingRuntimeCommandOptions) {
    this.commands.push({ command, options });
    return { status: 0, output: 'tests passed' };
  }

  async startPreview(
    options: CodingRuntimePreviewOptions,
  ): Promise<CodingRuntimePreviewResult> {
    this.previews.push(options);
    return {
      status: 0,
      output: 'preview health check passed',
      background: true,
      port: options.port,
      url: `https://100.64.0.25:${options.port}`,
    };
  }
}

describe('coding secret redaction', () => {
  it('redacts current dotted Google authorization keys', () => {
    const key =
      'AQ.a1b2c3d4e5f6g7h8i9j0.klmnopqrstuv-wxyz_0123456789';
    const redacted = redactCodingSecrets(`credential ${key}\nkeep=this`);

    expect(redacted).toBe(
      'credential [REDACTED_GOOGLE_KEY]\nkeep=this',
    );
    expect(redacted).not.toContain(key);
  });

  it('does not treat a short AQ abbreviation as a credential', () => {
    expect(redactCodingSecrets('See AQ.example for context.')).toBe(
      'See AQ.example for context.',
    );
  });

  it('redacts bare Google OAuth access tokens without matching prose', () => {
    const token = `ya29.${'a0AE'.repeat(12)}-temporary_access`;
    const redacted = redactCodingSecrets(`credential ${token}\nkeep=this`);

    expect(redacted).toBe(
      'credential [REDACTED_GOOGLE_OAUTH_TOKEN]\nkeep=this',
    );
    expect(redacted).not.toContain(token);
    expect(redactCodingSecrets('The ya29. prefix identifies OAuth tokens.')).toBe(
      'The ya29. prefix identifies OAuth tokens.',
    );
  });

  it('redacts recognizable GitHub and Stripe token prefixes', () => {
    const githubClassic = `ghp_${'a'.repeat(36)}`;
    const githubOAuth = `gho_${'b'.repeat(36)}`;
    const githubFineGrained = `github_pat_${'C'.repeat(82)}`;
    const stripeLive = `sk_live_${'d'.repeat(24)}`;
    const stripeTest = `sk_test_${'e'.repeat(24)}`;
    const raw = [
      githubClassic,
      githubOAuth,
      githubFineGrained,
      stripeLive,
      stripeTest,
    ].join('\n');

    const redacted = redactCodingSecrets(raw);

    for (const secret of [
      githubClassic,
      githubOAuth,
      githubFineGrained,
      stripeLive,
      stripeTest,
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED_GITHUB_TOKEN\]/g)).toHaveLength(3);
    expect(redacted.match(/\[REDACTED_STRIPE_KEY\]/g)).toHaveLength(2);
  });

  it('redacts bare long-lived and temporary AWS access key IDs', () => {
    const longLived = `AKIA${'A'.repeat(16)}`;
    const temporary = `ASIA${'B'.repeat(16)}`;
    const redacted = redactCodingSecrets(
      `printf '%s\\n' ${longLived} ${temporary}`,
    );

    expect(redacted).not.toContain(longLived);
    expect(redacted).not.toContain(temporary);
    expect(
      redacted.match(/\[REDACTED_AWS_ACCESS_KEY_ID\]/g),
    ).toHaveLength(2);
    expect(redactCodingSecrets('AKIA is an AWS access-key prefix.')).toBe(
      'AKIA is an AWS access-key prefix.',
    );
  });

  it('redacts quoted and unquoted oauth_token values without matching prose', () => {
    const redacted = redactCodingSecrets(
      'json={"oauth_token":"oauth-secret-value"}\nquery oauth-token=plain-secret-value',
    );

    expect(redacted).not.toContain('oauth-secret-value');
    expect(redacted).not.toContain('plain-secret-value');
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(redactCodingSecrets('OAuth token handling is documented.')).toBe(
      'OAuth token handling is documented.',
    );
  });

  it('preserves quoted assignment syntax so redacted JSON remains valid', () => {
    const redactedJson = redactCodingSecrets(
      '{"API_KEY":"123","safe":"visible"}',
    );

    expect(redactedJson).toBe(
      '{"API_KEY":"[REDACTED]","safe":"visible"}',
    );
    expect(JSON.parse(redactedJson)).toEqual({
      API_KEY: '[REDACTED]',
      safe: 'visible',
    });
    expect(redactCodingSecrets('API_KEY=123')).toBe('API_KEY=[REDACTED]');
    expect(redactCodingSecrets("API_KEY='123'")).toBe(
      "API_KEY='[REDACTED]'",
    );
  });

  it('redacts HTTP bearer and basic credentials without erasing documentation', () => {
    const bearer =
      'eyJhbGciOiJSUzI1NiJ9.payload-with_punctuation.signature+/=';
    const basic = 'dXNlcjpwQHNzLXdvcmQ=';
    const redacted = redactCodingSecrets(
      [
        `Authorization: Bearer ${bearer}`,
        `Proxy-Authorization: Basic ${basic}`,
        `json={"Authorization":"Bearer ${bearer}"}`,
        'Authorization documentation covers Bearer and Basic authentication.',
      ].join('\n'),
    );

    expect(redacted).not.toContain(bearer);
    expect(redacted).not.toContain(basic);
    expect(redacted.match(/\[REDACTED_AUTHORIZATION\]/g)).toHaveLength(3);
    expect(redacted).toContain(
      'Authorization documentation covers Bearer and Basic authentication.',
    );
    const jsonLine = redacted.split('\n')[2].slice('json='.length);
    expect(JSON.parse(jsonLine)).toEqual({
      Authorization: 'Bearer [REDACTED_AUTHORIZATION]',
    });
  });

  it('redacts exported, indented, and conventional credential assignments', () => {
    const redacted = redactCodingSecrets(
      [
        'export MY_SECRET=exported-secret',
        '  "client_secret": "quoted-client-secret"',
        'SMTP_PASS=smtp-secret',
        'PRIVATE_CRED: private-credential',
        'MONKEY=banana',
        'COMPASS_MODE=enabled',
      ].join('\n'),
    );

    for (const secret of [
      'exported-secret',
      'quoted-client-secret',
      'smtp-secret',
      'private-credential',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED\]/g)).toHaveLength(4);
    expect(redacted).toContain('MONKEY=banana');
    expect(redacted).toContain('COMPASS_MODE=enabled');
  });

  it('redacts credential-bearing URLs and common connection-string assignments', () => {
    const raw = [
      'postgres://builder:database-password@db.internal:5432/app',
      'DATABASE_URL=postgres://db.internal:5432/app',
      'config={"SENTRY_DSN":"https://public:private@sentry.example/1"}',
      'Documentation URL=https://example.com/public',
    ].join('\n');

    const redacted = redactCodingSecrets(raw);

    expect(redacted).not.toContain('database-password');
    expect(redacted).not.toContain('postgres://db.internal:5432/app');
    expect(redacted).not.toContain('public:private');
    expect(redacted).toContain('DATABASE_URL=[REDACTED]');
    expect(redacted).toContain('"SENTRY_DSN":"[REDACTED]"');
    expect(redacted).toContain('Documentation URL=https://example.com/public');
  });
});

function response(
  value: Partial<GeminiInteractionResponse> & { id: string },
): GeminiInteractionResponse {
  return { status: 'completed', steps: [], ...value };
}

function client(
  create: unknown,
  operations: {
    get?: unknown;
    cancel?: unknown;
  } = {},
): GeminiInteractionsClient {
  const callable = create as (
    params: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<GeminiInteractionResponse>;
  const get = (operations.get ?? vi.fn().mockRejectedValue(
    new Error('Unexpected background interaction poll.'),
  )) as (
    id: string,
    params?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<GeminiInteractionResponse>;
  const cancel = (operations.cancel ?? vi.fn().mockResolvedValue(
    response({ id: 'cancelled-interaction', status: 'cancelled' }),
  )) as (
    id: string,
    params?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<GeminiInteractionResponse>;
  return {
    interactions: {
      create: (params, options) => callable(params, options),
      get: (id, params, options) => get(id, params, options),
      cancel: (id, params, options) => cancel(id, params, options),
    },
  };
}

describe('GeminiInteractionsCodingHarness', () => {
  it.each([
    'cancelled',
    'incomplete',
    'budget_exceeded',
    undefined,
  ])('rejects non-success interaction status %s', async (status) => {
    const create = vi.fn().mockResolvedValue(
      response({ id: `status-${status ?? 'unknown'}`, status }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Build it.',
        runtime: new MemoryCodingRuntime(),
      }),
    ).rejects.toThrow(
      `Gemini interaction ended with non-success status: ${status ?? 'unknown'}`,
    );
  });

  it('rejects requires_action without a function call', async () => {
    const create = vi.fn().mockResolvedValue(
      response({ id: 'missing-call', status: 'requires_action' }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Build it.',
        runtime: new MemoryCodingRuntime(),
      }),
    ).rejects.toThrow('requires action but returned no function calls');
  });

  it('runs high-thinking model turns in the background and persists the id while polling', async () => {
    const create = vi.fn().mockResolvedValue(
      response({
        id: 'background-1',
        status: 'queued',
        output_text: '',
        created: '2026-08-28T08:00:00.000Z',
        updated: '2026-08-28T08:00:00.000Z',
      }),
    );
    const get = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'background-1',
          status: 'in_progress',
          output_text: '',
          updated: '2026-08-28T08:00:01.000Z',
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'background-1',
          status: 'completed',
          output_text: 'Background work completed.',
          updated: '2026-08-28T08:00:02.000Z',
          usage: {
            total_cached_tokens: 700,
            total_input_tokens: 1_200,
            total_output_tokens: 80,
            total_thought_tokens: 450,
            total_tool_use_tokens: 20,
            total_tokens: 1_730,
          },
        }),
      );
    const snapshots: CodingHarnessSession[] = [];
    const events: string[] = [];

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'Do the long task.',
      runtime: new MemoryCodingRuntime(),
      onSession: (session) => {
        snapshots.push(session);
      },
      onEvent: (event) => events.push(event.message),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({
      background: true,
      generation_config: { thinking_level: 'high' },
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe('background-1');
    expect(get.mock.calls[0][2]).toMatchObject({ maxRetries: 0 });
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerState: expect.objectContaining({
            pendingInteractionId: 'background-1',
          }),
        }),
      ]),
    );
    expect(result.finalText).toContain('Background work completed');
    expect(result.session.previousInteractionId).toBe('background-1');
    expect(result.session.providerState).not.toHaveProperty(
      'pendingInteractionId',
    );
    expect(result.session.providerState.lastInteractionTelemetry).toMatchObject({
      schemaVersion: 1,
      interactionId: 'background-1',
      observation: 'terminal',
      status: 'completed',
      providerCreatedAt: '2026-08-28T08:00:00.000Z',
      providerUpdatedAt: '2026-08-28T08:00:02.000Z',
      providerElapsedMs: 2_000,
      createApiCalls: 1,
      pollApiCalls: 2,
      usage: {
        cachedTokens: 700,
        inputTokens: 1_200,
        outputTokens: 80,
        thoughtTokens: 450,
        toolUseTokens: 20,
        totalTokens: 1_730,
      },
    });
    const acceptedSnapshot = snapshots.find(
      (snapshot) =>
        (
          snapshot.providerState.lastInteractionTelemetry as
            | { observation?: unknown }
            | undefined
        )?.observation === 'accepted',
    );
    expect(acceptedSnapshot?.providerState.lastInteractionTelemetry).toMatchObject(
      { observation: 'accepted', pollApiCalls: 0 },
    );
    expect(events).toContainEqual(
      expect.stringContaining('1,200 input / 80 output / 450 thought'),
    );
  });

  it('retries background polling eight times without recreating the interaction', async () => {
    const unavailable = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = vi.fn().mockResolvedValue(
      response({ id: 'background-retry', status: 'in_progress' }),
    );
    const get = vi.fn();
    for (let retry = 0; retry < GEMINI_API_MAX_RETRIES; retry += 1) {
      get.mockRejectedValueOnce(unavailable);
    }
    get.mockResolvedValueOnce(
      response({
        id: 'background-retry',
        output_text: 'Polling recovered on attempt nine.',
      }),
    );
    const events: string[] = [];

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'Do not duplicate this job.',
      runtime: new MemoryCodingRuntime(),
      retryBaseDelayMs: 0,
      onEvent: (event) => events.push(event.message),
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(9);
    expect(events.filter((event) => event.includes('Retrying'))).toHaveLength(8);
    expect(result.finalText).toContain('attempt nine');
    expect(result.session.providerState.lastInteractionTelemetry).toMatchObject({
      createApiCalls: 1,
      pollApiCalls: 9,
    });
  });

  it('resubmits a confirmed background execution failure up to the execution allowance', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      response({ id: 'capacity-failed', status: 'in_progress' }),
    );
    const get = vi.fn().mockResolvedValueOnce(
      response({
        id: 'capacity-failed',
        status: 'failed',
        errors: [
          {
            code: 500,
            message: 'The model is currently experiencing high demand.',
          },
        ],
      }),
    );
    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get }),
        backgroundPollIntervalMs: 0,
        executionRetries: 0,
      }).run({
        prompt: 'A single execution attempt fails closed.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('high demand');

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('treats a thrown high-demand GET as the execution death notice without transport retries', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      response({ id: 'capacity-transport', status: 'in_progress' }),
    );
    const get = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('The model is currently experiencing high demand.'),
        { status: 500 },
      ),
    );

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get }),
        backgroundPollIntervalMs: 0,
        executionRetries: 0,
      }).run({
        prompt: 'A dead execution is not polled again.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('high demand');

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps create and get transport retries exact without an outer replay loop', async () => {
    const transient = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = vi
      .fn()
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(
        response({ id: 'combined-budget', status: 'in_progress' }),
      );
    const get = vi.fn().mockRejectedValue(transient);
    const events: string[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get }),
        backgroundPollIntervalMs: 0,
        executionRetries: 0,
      }).run({
        prompt: 'Bound combined recovery.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
        onEvent: (event) => events.push(event.message),
      }),
    ).rejects.toThrow('service unavailable');

    // Create recovered within its own operation. GET then received its exact
    // initial-plus-eight allowance, and the completed create was not replayed.
    expect(create).toHaveBeenCalledTimes(3);
    expect(get).toHaveBeenCalledTimes(9);
    expect(events.filter((event) => event.includes('Retrying'))).toHaveLength(10);
  });

  it('does not treat a terminal failed response as a transport retry', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      response({
        id: 'failed-background',
        status: 'failed',
        errors: [{ code: 500, message: 'Temporary high demand.' }],
      }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create),
        executionRetries: 0,
      }).run({
        prompt: 'Do not replay a completed failed execution.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('Temporary high demand');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('cancels a background interaction when the user stops the run', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      response({ id: 'background-stop', status: 'in_progress' }),
    );
    const get = vi.fn().mockImplementation(async () => {
      controller.abort();
      const error = new Error('Coding task was stopped.');
      error.name = 'AbortError';
      throw error;
    });
    const cancel = vi.fn().mockResolvedValue(
      response({ id: 'background-stop', status: 'cancelled' }),
    );
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get, cancel }),
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Start then stop.',
        runtime: new MemoryCodingRuntime(),
        abortSignal: controller.signal,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBe('background-stop');
    expect(cancel.mock.calls[0][2]).toMatchObject({
      maxRetries: 0,
      timeout: 1_500,
    });
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'pendingInteractionId',
    );
    expect(snapshots.at(-1)?.providerState.pendingProviderTurn).toBe(true);
  });

  it('gives cancellation one initial transport attempt plus exactly eight retries', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      response({ id: 'cancel-retry-budget', status: 'in_progress' }),
    );
    const get = vi.fn().mockImplementation(async () => {
      controller.abort();
      const error = new Error('Coding task was stopped.');
      error.name = 'AbortError';
      throw error;
    });
    const unavailable = Object.assign(new Error('cancel unavailable'), {
      status: 503,
    });
    const cancel = vi.fn().mockRejectedValue(unavailable);
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get, cancel }),
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Stop and retry cancellation transport.',
        runtime: new MemoryCodingRuntime(),
        abortSignal: controller.signal,
        retryBaseDelayMs: 0,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(9);
    for (const call of cancel.mock.calls) {
      expect(call[2]).toMatchObject({ maxRetries: 0 });
    }
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'pendingInteractionId',
    );
    expect(
      snapshots.at(-1)?.providerState.unconfirmedCancellationIds,
    ).toEqual(['cancel-retry-budget']);
  });

  it('blocks a new execution while persisted cancellation remains unconfirmed', async () => {
    const timestamp = new Date().toISOString();
    const prior: CodingHarnessSession = {
      version: 1,
      id: 'unconfirmed-cancel-session',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: null,
      transcript: [],
      providerState: {
        unconfirmedCancellationIds: ['still-running-interaction'],
      },
    };
    const unavailable = Object.assign(new Error('cancel unavailable'), {
      status: 503,
    });
    const cancel = vi.fn().mockRejectedValue(unavailable);
    const create = vi.fn();
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { cancel }),
      }).run({
        prompt: 'Resume only after safe reconciliation.',
        runtime: new MemoryCodingRuntime(),
        session: prior,
        retryBaseDelayMs: 0,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toThrow('no new model execution was started');

    expect(cancel).toHaveBeenCalledTimes(GEMINI_API_MAX_RETRIES + 1);
    expect(create).not.toHaveBeenCalled();
    expect(
      snapshots.at(-1)?.providerState.unconfirmedCancellationIds,
    ).toEqual(['still-running-interaction']);
  });

  it('treats a missing persisted interaction as safely reconciled', async () => {
    const timestamp = new Date().toISOString();
    const prior: CodingHarnessSession = {
      version: 1,
      id: 'missing-cancel-session',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: null,
      transcript: [],
      providerState: {
        unconfirmedCancellationIds: ['expired-interaction'],
      },
    };
    const cancel = vi.fn().mockRejectedValue(
      Object.assign(new Error('Interaction not found.'), { status: 404 }),
    );
    const create = vi.fn().mockResolvedValue(
      response({ id: 'after-reconciliation', output_text: 'Resumed safely.' }),
    );

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { cancel }),
    }).run({
      prompt: 'Resume after reconciliation.',
      runtime: new MemoryCodingRuntime(),
      session: prior,
      retryBaseDelayMs: 0,
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.session.providerState).not.toHaveProperty(
      'unconfirmedCancellationIds',
    );
  });

  it('does not execute tool calls from an ambiguous GET that races with Stop', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      response({ id: 'background-race', status: 'in_progress' }),
    );
    const get = vi.fn().mockImplementation(async () => {
      controller.abort();
      return response({
        id: 'background-race',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'late-write',
            name: CODING_WRITE_FILE_TOOL,
            arguments: {
              file_path: 'late.txt',
              content: 'must not be written',
            },
          },
        ],
      });
    });
    const cancel = vi.fn().mockRejectedValue(
      Object.assign(new Error('Interaction not found.'), { status: 404 }),
    );
    const runtime = new MemoryCodingRuntime();
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get, cancel }),
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Stop at the boundary.',
        runtime,
        abortSignal: controller.signal,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(runtime.files.has('late.txt')).toBe(false);
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'pendingInteractionId',
    );
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'unconfirmedCancellationIds',
    );
  });

  it('does not cancel a terminal GET response observed before Stop propagates', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      response({ id: 'terminal-stop-race', status: 'in_progress' }),
    );
    const terminal = response({
      id: 'terminal-stop-race',
      status: 'requires_action',
      steps: [
        {
          type: 'function_call',
          id: 'terminal-late-write',
          name: CODING_WRITE_FILE_TOOL,
          arguments: {
            file_path: 'terminal-late.txt',
            content: 'must not be written',
          },
        },
      ],
    });
    Object.defineProperty(terminal, 'status', {
      configurable: true,
      enumerable: true,
      get: () => {
        controller.abort();
        return 'requires_action';
      },
    });
    const get = vi.fn().mockResolvedValue(terminal);
    const cancel = vi.fn().mockRejectedValue(new Error('must not be called'));
    const runtime = new MemoryCodingRuntime();
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get, cancel }),
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Stop after the provider is already terminal.',
        runtime,
        abortSignal: controller.signal,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(cancel).not.toHaveBeenCalled();
    expect(runtime.files.has('terminal-late.txt')).toBe(false);
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'pendingInteractionId',
    );
    expect(snapshots.at(-1)?.providerState).not.toHaveProperty(
      'unconfirmedCancellationIds',
    );
  });

  it('cancels a background interaction when its overall turn budget expires', async () => {
    const create = vi.fn().mockResolvedValue(
      response({ id: 'background-timeout', status: 'in_progress' }),
    );
    const cancel = vi.fn().mockResolvedValue(
      response({ id: 'background-timeout', status: 'cancelled' }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { cancel }),
        backgroundPollIntervalMs: 100,
      }).run({
        prompt: 'Bound this turn.',
        runtime: new MemoryCodingRuntime(),
        turnTimeoutMs: 50,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError', status: 408 });

    expect(create).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0][0]).toBe('background-timeout');
  });

  it('enforces the absolute turn deadline when a GET ignores AbortSignal', async () => {
    const create = vi.fn().mockResolvedValue(
      response({ id: 'late-background', status: 'in_progress' }),
    );
    const get = vi.fn(
      async (
        _id: string,
        _params?: Record<string, unknown>,
        _options?: Record<string, unknown>,
      ) =>
        new Promise<GeminiInteractionResponse>((resolve) => {
          globalThis.setTimeout(
            () =>
              resolve(
                response({
                  id: 'late-background',
                  status: 'requires_action',
                  steps: [
                    {
                      type: 'function_call',
                      id: 'late-write-after-deadline',
                      name: CODING_WRITE_FILE_TOOL,
                      arguments: {
                        file_path: 'late-after-deadline.txt',
                        content: 'must never be written',
                      },
                    },
                  ],
                }),
              ),
            150,
          );
        }),
    );
    const cancel = vi.fn().mockResolvedValue(
      response({ id: 'late-background', status: 'cancelled' }),
    );
    const runtime = new MemoryCodingRuntime();
    const startedAt = Date.now();

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get, cancel }),
        apiRequestTimeoutMs: 1_000,
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Respect the absolute deadline.',
        runtime,
        turnTimeoutMs: 40,
        retryBaseDelayMs: 0,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError', status: 408 });

    expect(Date.now() - startedAt).toBeLessThan(130);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][2]).toMatchObject({
      timeout: expect.any(Number),
      maxRetries: 0,
    });
    expect(Number(get.mock.calls[0][2]?.timeout)).toBeLessThanOrEqual(40);
    expect(cancel).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => globalThis.setTimeout(resolve, 170));
    expect(runtime.files.has('late-after-deadline.txt')).toBe(false);
  });

  it('uses Gemini 3.7 Flash Interactions, executes VM tools, and checkpoints the session', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'interaction-1',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'write-1',
              name: CODING_WRITE_FILE_TOOL,
              arguments: {
                file_path: 'src/main.ts',
                content: 'export const answer = 42;\n',
              },
            },
            {
              type: 'function_call',
              id: 'test-1',
              name: CODING_RUN_COMMAND_TOOL,
              arguments: {
                command: 'npm test',
                cwd: '/workspace',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'interaction-2',
          output_text: 'Implemented the change and the tests pass.',
        }),
      );
    const runtime = new MemoryCodingRuntime();
    const writeText = vi.spyOn(runtime, 'writeText');
    const runCommand = vi.spyOn(runtime, 'runCommand');
    const snapshots: CodingHarnessSession[] = [];
    const harness = new GeminiInteractionsCodingHarness({
      client: client(create),
    });

    const result = await harness.run({
      prompt: 'Implement the answer module and test it.',
      runtime,
      onSession: (session) => {
        snapshots.push(session);
      },
    });

    expect(harness.model).toBe(MODEL_ID);
    expect(harness.provider).toBe(GEMINI_INTERACTIONS_PROVIDER);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gemini-3.7-flash',
      input: 'Implement the answer module and test it.',
      generation_config: { thinking_level: 'high' },
    });
    expect(create.mock.calls[0][0].generation_config).not.toHaveProperty(
      'temperature',
    );
    expect(create.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: CODING_RUN_COMMAND_TOOL }),
      ]),
    );
    expect(create.mock.calls[0][0].system_instruction).toContain(
      'emit all of their function calls in one response',
    );
    expect(create.mock.calls[0][0].system_instruction).toContain(
      'Do not batch a call that requires another call',
    );
    expect(create.mock.calls[0][0].system_instruction).toContain(
      'most recent user message is the active objective',
    );
    expect(create.mock.calls[0][0].system_instruction).toContain(
      'take the next concrete action immediately',
    );
    expect(create.mock.calls[0][0].system_instruction).not.toContain(
      'Inspect existing work before changing it',
    );
    expect(create.mock.calls[0][0].system_instruction).toContain(
      'Do not restart a healthy preview for a narrow file-only repair',
    );
    expect(create.mock.calls[0][0].system_instruction).not.toContain(
      'Execution environment',
    );
    expect(create.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
    expect(create.mock.calls[1][0].previous_interaction_id).toBe(
      'interaction-1',
    );
    expect(create.mock.calls[1][0].input).toEqual([
      {
        type: 'function_result',
        call_id: 'write-1',
        name: CODING_WRITE_FILE_TOOL,
        result: [
          {
            type: 'text',
            text: 'Wrote 26 characters to /workspace/src/main.ts.',
          },
        ],
      },
      {
        type: 'function_result',
        call_id: 'test-1',
        name: CODING_RUN_COMMAND_TOOL,
        result: [
          {
            type: 'text',
            text: 'Command completed in /workspace:\ntests passed',
          },
        ],
      },
    ]);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runtime.files.get('src/main.ts')).toBe(
      'export const answer = 42;\n',
    );
    expect(runtime.commands).toEqual([
      {
        command: 'npm test',
        options: {
          cwd: '/workspace',
          background: false,
          timeoutMs: 90_000,
        },
      },
    ]);
    expect(result.changedFiles).toEqual(['src/main.ts']);
    expect(result.finalText).toContain('tests pass');
    expect(result.session.previousInteractionId).toBe('interaction-2');
    expect(result.reachedTurnBudget).toBe(false);
    expect(result.session.providerState.lastInteractionTelemetry).toMatchObject({
      observation: 'terminal',
      status: 'completed',
      createApiCalls: 1,
      pollApiCalls: 0,
      pollElapsedMs: 0,
    });
    expect(snapshots.length).toBeGreaterThanOrEqual(5);
    expect(() => JSON.stringify(result.session)).not.toThrow();
  });

  it('suppresses repeated inspection until a workspace-changing tool invalidates it', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'inspect-once',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'read-relative',
              name: CODING_READ_FILE_TOOL,
              arguments: { file_path: 'README.md' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'inspect-repeat',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'read-absolute',
              name: CODING_READ_FILE_TOOL,
              arguments: { file_path: '/workspace/README.md' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'mutate-after-repeat',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'write-readme',
              name: CODING_WRITE_FILE_TOOL,
              arguments: {
                file_path: 'README.md',
                content: 'updated evidence',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'inspect-after-mutation',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'read-after-write',
              name: CODING_READ_FILE_TOOL,
              arguments: { file_path: 'README.md' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: 'inspection-finished', output_text: 'Finished.' }),
      );
    const runtime = new MemoryCodingRuntime({
      'README.md': 'initial evidence',
    });
    const readText = vi.spyOn(runtime, 'readText');

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create),
    }).run({
      prompt: 'Update the project without circling on the same inspection.',
      runtime,
    });

    expect(readText).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(create.mock.calls[2][0].input)).toContain(
      'suppressed this exact repeated inspection',
    );
    expect(JSON.stringify(create.mock.calls[4][0].input)).toContain(
      'updated evidence',
    );
    expect(result.session.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: 'read-absolute',
          isError: true,
          content: expect.stringContaining('Use the prior evidence'),
        }),
      ]),
    );
  });

  it('corrects one future-intent completion instead of claiming the task finished', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'plan-only-first',
          output_text: "I'll inspect README.md next.",
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'plan-corrected',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'corrected-read',
              name: CODING_READ_FILE_TOOL,
              arguments: { file_path: 'README.md' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ id: 'corrected-final', output_text: 'Verified the file.' }),
      );
    const statuses: string[] = [];

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create),
    }).run({
      prompt: 'Inspect and verify README.md.',
      runtime: new MemoryCodingRuntime({ 'README.md': 'verified' }),
      onEvent: (event) => statuses.push(event.message),
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(create.mock.calls[1][0].previous_interaction_id).toBe(
      'plan-only-first',
    );
    expect(create.mock.calls[1][0].input).toContain(
      'Use the necessary tool now',
    );
    expect(statuses).toContainEqual(
      expect.stringContaining('intention instead of acting'),
    );
    expect(result.finalText).toBe('Verified the file.');
  });

  it('stops after two future-intent completions instead of circling', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({ id: 'plan-loop-one', output_text: "I'll inspect it next." }),
      )
      .mockResolvedValueOnce(
        response({ id: 'plan-loop-two', output_text: "I'll check it now." }),
      );

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Fix the project.',
        runtime: new MemoryCodingRuntime(),
      }),
    ).rejects.toThrow('without claiming success');

    expect(create).toHaveBeenCalledTimes(2);
  });

  it('starts each user request from bounded durable context and retains conversation history', async () => {
    const firstCreate = vi.fn().mockResolvedValue(
      response({ id: 'first-interaction', output_text: 'First task done.' }),
    );
    const runtime = new MemoryCodingRuntime();
    const first = await new GeminiInteractionsCodingHarness({
      client: client(firstCreate),
    }).run({ prompt: 'Create the project.', runtime });

    const resumeCreate = vi.fn().mockResolvedValue(
      response({ id: 'second-interaction', output_text: 'Follow-up done.' }),
    );
    const second = await new GeminiInteractionsCodingHarness({
      client: client(resumeCreate),
    }).run({
      prompt: 'Now add the follow-up.',
      runtime,
      session: JSON.parse(JSON.stringify(first.session)) as CodingHarnessSession,
    });

    expect(resumeCreate.mock.calls[0][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(resumeCreate.mock.calls[0][0].input).toEqual(expect.any(String));
    expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
      'Create the project.',
    );
    expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
      'Now add the follow-up.',
    );
    expect(String(resumeCreate.mock.calls[0][0].input).length).toBeLessThanOrEqual(
      32_000,
    );
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.transcript.map((event) => event.content)).toEqual(
      expect.arrayContaining([
        'Create the project.',
        'First task done.',
        'Now add the follow-up.',
        'Follow-up done.',
      ]),
    );
  });

  it.each([
    [
      'an aborted request',
      Object.assign(new Error('Request aborted by client'), {
        name: 'APIUserAbortError',
      }),
      1,
    ],
    [
      'a permanent request failure',
      Object.assign(new Error('invalid argument'), { status: 400 }),
      1,
    ],
    [
      'an exhausted transient request failure',
      Object.assign(new Error('service unavailable'), { status: 503 }),
      GEMINI_API_MAX_RETRIES + 1,
    ],
  ])(
    'reconstructs the durable prompt after %s instead of skipping it',
    async (_, failure, expectedAttempts) => {
      const runtime = new MemoryCodingRuntime();
      const initial = await new GeminiInteractionsCodingHarness({
        client: client(
          vi.fn().mockResolvedValue(
            response({
              id: 'acknowledged-interaction',
              output_text: 'Initial task done.',
            }),
          ),
        ),
      }).run({ prompt: 'Create the initial project.', runtime });

      const failedCreate = vi.fn().mockRejectedValue(failure);
      const snapshots: CodingHarnessSession[] = [];
      await expect(
        new GeminiInteractionsCodingHarness({
          client: client(failedCreate),
        }).run({
          prompt: 'Apply the follow-up that must not disappear.',
          runtime,
          session: initial.session,
          retryBaseDelayMs: 0,
          onSession: (session) => {
            snapshots.push(session);
          },
        }),
      ).rejects.toThrow();

      expect(failedCreate).toHaveBeenCalledTimes(expectedAttempts);
      const interrupted = snapshots.at(-1);
      expect(interrupted?.previousInteractionId).toBeNull();
      expect(interrupted?.providerState.pendingProviderTurn).toBe(true);
      expect(interrupted?.transcript).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: 'Apply the follow-up that must not disappear.',
          }),
        ]),
      );

      const resumeCreate = vi.fn().mockResolvedValue(
        response({
          id: 'reconstructed-interaction',
          output_text: 'Recovered both prompts.',
        }),
      );
      const resumed = await new GeminiInteractionsCodingHarness({
        client: client(resumeCreate),
      }).run({
        prompt: 'Resume after the failed request.',
        runtime,
        session: interrupted,
      });

      expect(resumeCreate.mock.calls[0][0]).not.toHaveProperty(
        'previous_interaction_id',
      );
      expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
        'Apply the follow-up that must not disappear.',
      );
      expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
        'Resume after the failed request.',
      );
      expect(resumed.session.providerState.pendingProviderTurn).toBe(false);
      expect(resumed.session.previousInteractionId).toBe(
        'reconstructed-interaction',
      );
    },
  );

  it('executes start_preview through the managed runtime and returns its URL to Gemini', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'preview-interaction',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'preview-call',
              name: CODING_START_PREVIEW_TOOL,
              arguments: {
                command: 'npm run dev -- --host 0.0.0.0 --port 4173',
                port: 4173,
                cwd: 'web',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          id: 'preview-complete',
          output_text: 'The managed preview is live.',
        }),
      );
    const runtime = new MemoryCodingRuntime();

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create),
    }).run({
      prompt: 'Start the app preview.',
      runtime,
    });

    expect(create.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: CODING_START_PREVIEW_TOOL }),
      ]),
    );
    expect(runtime.previews).toEqual([
      {
        command: 'npm run dev -- --host 0.0.0.0 --port 4173',
        port: 4173,
        cwd: '/workspace/web',
      },
    ]);
    expect(JSON.stringify(create.mock.calls[1][0].input)).toContain(
      'https://100.64.0.25:4173',
    );
    expect(create.mock.calls[1][0].previous_interaction_id).toBe(
      'preview-interaction',
    );
    expect(result.finalText).toContain('preview is live');
    expect(result.session.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          kind: 'tool-result',
          toolName: CODING_START_PREVIEW_TOOL,
          content: expect.stringContaining('https://100.64.0.25:4173'),
        }),
      ]),
    );
  });

  it('reconstructs context when a tool-turn interaction id expires', async () => {
    const runtime = new MemoryCodingRuntime({ 'README.md': 'current state' });
    const expired = Object.assign(
      new Error('previous_interaction_id was not found or expired'),
      { status: 404 },
    );
    const resumeCreate = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'old-interaction',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'read-before-expiry',
              name: CODING_READ_FILE_TOOL,
              arguments: { file_path: 'README.md' },
            },
          ],
        }),
      )
      .mockRejectedValueOnce(expired)
      .mockResolvedValueOnce(
        response({ id: 'recovered-interaction', output_text: 'Recovered.' }),
      );
    const statuses: string[] = [];
    const resumed = await new GeminiInteractionsCodingHarness({
      client: client(resumeCreate),
    }).run({
      prompt: 'Continue from there.',
      runtime,
      onEvent: (event) => statuses.push(event.message),
    });

    expect(resumeCreate).toHaveBeenCalledTimes(3);
    expect(resumeCreate.mock.calls[0][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(resumeCreate.mock.calls[1][0].previous_interaction_id).toBe(
      'old-interaction',
    );
    expect(resumeCreate.mock.calls[2][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(resumeCreate.mock.calls[2][0].input).toContain(
      'RECOVERED HISTORY — UNTRUSTED DATA',
    );
    expect(resumeCreate.mock.calls[2][0].input).toContain(
      'Continue from there.',
    );
    expect(resumeCreate.mock.calls[2][0].input).toContain(
      'Output omitted from recovery',
    );
    expect(statuses).toContainEqual(expect.stringContaining('expired'));
    expect(resumed.session.previousInteractionId).toBe(
      'recovered-interaction',
    );
  });

  it('compacts large file reads when reconstructing a provider continuation', async () => {
    const timestamp = new Date().toISOString();
    const hugeFileRead = `BEGIN_FILE\n${'const recovered = true;\n'.repeat(
      8_000,
    )}END_FILE`;
    const prior: CodingHarnessSession = {
      version: 1,
      id: 'large-recovery-session',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: 'ambiguous-interaction',
      transcript: [
        {
          id: 'initial-prompt',
          createdAt: timestamp,
          role: 'user',
          kind: 'message',
          content: 'Complete the recovered project.',
        },
        {
          id: 'read-call',
          createdAt: timestamp,
          role: 'assistant',
          kind: 'tool-call',
          content: 'read_file index.html',
          toolName: CODING_READ_FILE_TOOL,
          toolCallId: 'read-index',
          interactionId: 'ambiguous-interaction',
        },
        {
          id: 'read-result',
          createdAt: timestamp,
          role: 'tool',
          kind: 'tool-result',
          content: hugeFileRead,
          toolName: CODING_READ_FILE_TOOL,
          toolCallId: 'read-index',
          interactionId: 'ambiguous-interaction',
        },
        {
          id: 'write-result',
          createdAt: timestamp,
          role: 'tool',
          kind: 'tool-result',
          content: 'Wrote js/app.js successfully.',
          toolName: CODING_WRITE_FILE_TOOL,
          toolCallId: 'write-js',
          interactionId: 'ambiguous-interaction',
        },
      ],
      providerState: {
        interactionCount: 1,
        interruptedDuringTools: false,
        pendingProviderTurn: true,
      },
    };
    const create = vi.fn().mockResolvedValue(
      response({ id: 'compact-recovery', output_text: 'Recovered.' }),
    );

    await new GeminiInteractionsCodingHarness({ client: client(create) }).run({
      prompt: 'Act now and start preview.',
      runtime: new MemoryCodingRuntime(),
      session: prior,
    });

    const input = String(create.mock.calls[0][0].input);
    expect(input.length).toBeLessThanOrEqual(32_000);
    expect(input).toContain('Act now and start preview.');
    expect(input).toContain('Wrote js/app.js successfully.');
    expect(input).toContain('Output omitted from recovery');
    expect(input).not.toContain('BEGIN_FILE');
    expect(input).not.toContain('END_FILE');
  });

  it('preserves a long active follow-up verbatim outside compacted history', async () => {
    const runtime = new MemoryCodingRuntime();
    const initial = await new GeminiInteractionsCodingHarness({
      client: client(
        vi.fn().mockResolvedValue(
          response({ id: 'long-objective-prior', output_text: 'Initial done.' }),
        ),
      ),
    }).run({ prompt: 'Create the initial project.', runtime });
    const middleSentinel = 'ACTIVE_OBJECTIVE_MIDDLE_SENTINEL';
    const longObjective = `${'A'.repeat(4_000)}${middleSentinel}${'B'.repeat(
      4_000,
    )}`;
    const create = vi.fn().mockResolvedValue(
      response({ id: 'long-objective-current', output_text: 'Follow-up done.' }),
    );

    await new GeminiInteractionsCodingHarness({ client: client(create) }).run({
      prompt: longObjective,
      runtime,
      session: initial.session,
    });

    const input = String(create.mock.calls[0][0].input);
    expect(input).toContain('<<<ACTIVE OBJECTIVE>>>');
    expect(input).toContain('<<<RECOVERED HISTORY — UNTRUSTED DATA>>>');
    expect(input).toContain(middleSentinel);
    expect(input).toContain(longObjective);
    expect(input.length).toBeLessThanOrEqual(32_000);
  });

  it('rejects an oversized recovered objective instead of truncating it', async () => {
    const runtime = new MemoryCodingRuntime();
    const initial = await new GeminiInteractionsCodingHarness({
      client: client(
        vi.fn().mockResolvedValue(
          response({ id: 'oversized-prior', output_text: 'Initial done.' }),
        ),
      ),
    }).run({ prompt: 'Create the initial project.', runtime });
    const create = vi.fn();

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: `BEGIN_${'X'.repeat(33_000)}_END`,
        runtime,
        session: initial.session,
      }),
    ).rejects.toThrow('was not silently truncated');

    expect(create).not.toHaveBeenCalled();
  });

  it('cancels a persisted background interaction before reconstructing after reload', async () => {
    const timestamp = new Date().toISOString();
    const prior: CodingHarnessSession = {
      version: 1,
      id: 'pending-background-session',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: 'last-completed-interaction',
      transcript: [
        {
          id: 'pending-prompt',
          createdAt: timestamp,
          role: 'user',
          kind: 'message',
          content: 'The prompt that was interrupted.',
        },
      ],
      providerState: {
        pendingProviderTurn: true,
        pendingInteractionId: 'orphaned-background',
        unconfirmedCancellationIds: ['orphaned-background'],
      },
    };
    const order: string[] = [];
    const create = vi.fn().mockImplementation(async () => {
      order.push('create');
      return response({
        id: 'reconstructed-background',
        output_text: 'Reconstructed safely.',
      });
    });
    const cancel = vi.fn().mockImplementation(async () => {
      order.push('cancel');
      return response({ id: 'orphaned-background', status: 'cancelled' });
    });

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { cancel }),
    }).run({
      prompt: 'Resume after reload.',
      runtime: new MemoryCodingRuntime(),
      session: prior,
    });

    expect(order).toEqual(['cancel', 'create']);
    expect(cancel).toHaveBeenCalledWith(
      'orphaned-background',
      undefined,
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(String(create.mock.calls[0][0].input)).toContain(
      'The prompt that was interrupted.',
    );
    expect(String(create.mock.calls[0][0].input)).toContain(
      'Resume after reload.',
    );
    expect(result.session.providerState).not.toHaveProperty(
      'unconfirmedCancellationIds',
    );
  });

  it('makes exactly eight retries after a transient API failure', async () => {
    const unavailable = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = vi.fn().mockRejectedValue(unavailable);
    const events: string[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
        onEvent: (event) => events.push(event.message),
      }),
    ).rejects.toThrow('service unavailable');

    expect(GEMINI_API_MAX_RETRIES).toBe(8);
    expect(create).toHaveBeenCalledTimes(9);
    const retryEvents = events.filter((event) => event.includes('Retrying'));
    expect(retryEvents).toHaveLength(8);
    expect(retryEvents[0]).toContain('attempt 2/9');
    expect(retryEvents.at(-1)).toContain('attempt 9/9');
    for (const call of create.mock.calls) {
      expect(call[1]).toMatchObject({ maxRetries: 0 });
    }
  });

  it.each([
    [
      'connection failure',
      Object.assign(
        new Error('Unable to make request: TypeError: Failed to fetch'),
        { name: 'APIConnectionError' },
      ),
    ],
    [
      'connection timeout',
      Object.assign(new Error('Request timed out'), {
        name: 'APIConnectionTimeoutError',
      }),
    ],
  ])('retries the real SDK %s error shape exactly eight times', async (_, sdkError) => {
    const create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow(sdkError.message);

    expect(create).toHaveBeenCalledTimes(GEMINI_API_MAX_RETRIES + 1);
  });

  it('does not retry an SDK user-abort error', async () => {
    const userAbort = Object.assign(new Error('Request aborted by client'), {
      name: 'APIUserAbortError',
    });
    const create = vi.fn().mockRejectedValue(userAbort);

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('Request aborted by client');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('allows the ninth API attempt to recover after exactly eight failures', async () => {
    const unavailable = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = vi.fn();
    for (let attempt = 0; attempt < GEMINI_API_MAX_RETRIES; attempt++) {
      create.mockRejectedValueOnce(unavailable);
    }
    create.mockResolvedValueOnce(
      response({
        id: 'ninth-attempt',
        output_text: 'Recovered on the final allowed attempt.',
      }),
    );
    const events: string[] = [];

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create),
    }).run({
      prompt: 'Run a task.',
      runtime: new MemoryCodingRuntime(),
      retryBaseDelayMs: 0,
      onEvent: (event) => events.push(event.message),
    });

    expect(create).toHaveBeenCalledTimes(9);
    expect(events.filter((event) => event.includes('Retrying'))).toHaveLength(8);
    expect(result.finalText).toContain('final allowed attempt');
    expect(result.session.previousInteractionId).toBe('ninth-attempt');
  });

  it('does not retry an invalid API request', async () => {
    const invalid = Object.assign(new Error('invalid argument'), { status: 400 });
    const create = vi.fn().mockRejectedValue(invalid);

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('invalid argument');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not infer a retry from message text when a structured non-transient status is present', async () => {
    const create = vi.fn().mockRejectedValue({
      status: 400,
      message: 'invalid request; request id 500',
    });

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('request id 500');

    expect(create).toHaveBeenCalledTimes(1);
  });

  it('redacts provider errors and rejected API messages before surfacing them', async () => {
    const providerToken = 'npm_providerToken1234567890';
    const failedCreate = vi.fn().mockResolvedValue(
      response({
        id: 'failed-with-secret',
        status: 'failed',
        errors: [
          {
            message: `//registry.npmjs.org/:_authToken=${providerToken}`,
          },
        ],
      }),
    );

    let providerFailure = '';
    try {
      await new GeminiInteractionsCodingHarness({
        client: client(failedCreate),
      }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
      });
    } catch (error) {
      providerFailure = error instanceof Error ? error.message : String(error);
    }
    expect(providerFailure).toContain('[REDACTED_NPM_TOKEN]');
    expect(providerFailure).not.toContain(providerToken);

    const rejectedToken = 'npm_rejectedToken1234567890';
    const rejectedCreate = vi.fn().mockRejectedValue({
      status: 400,
      message: `invalid token ${rejectedToken}`,
    });
    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(rejectedCreate),
      }).run({
        prompt: 'Run another task.',
        runtime: new MemoryCodingRuntime(),
      }),
    ).rejects.not.toThrow(rejectedToken);
    expect(rejectedCreate).toHaveBeenCalledTimes(1);
  });

  it('applies the eight-retry policy to client-side request timeouts', async () => {
    const create = vi.fn(
      (
        _params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) =>
        new Promise<GeminiInteractionResponse>((_resolve, reject) => {
          const signal = options?.signal as AbortSignal;
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('request signal aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create),
        apiRequestTimeoutMs: 1,
      }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('timed out');

    expect(create).toHaveBeenCalledTimes(9);
  });

  it('rejects malformed function calls rather than treating them as completion', async () => {
    const create = vi.fn().mockResolvedValue(
      response({
        id: 'bad-interaction',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'bad-call',
            name: CODING_WRITE_FILE_TOOL,
            arguments: ['not', 'an', 'object'],
          },
        ],
      }),
    );

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Run a task.',
        runtime: new MemoryCodingRuntime(),
      }),
    ).rejects.toThrow('malformed arguments');
  });

  it('resets provider continuation after an interrupted tool step', async () => {
    const timestamp = new Date().toISOString();
    const prior: CodingHarnessSession = {
      version: 1,
      id: 'session-1',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: timestamp,
      updatedAt: timestamp,
      previousInteractionId: 'unsafe-to-resume',
      transcript: [
        {
          id: 'prior-tool-result',
          createdAt: timestamp,
          role: 'tool',
          kind: 'tool-result',
          content: 'Wrote src/already-applied.ts successfully.',
          interactionId: 'unsafe-to-resume',
          toolCallId: 'prior-write',
          toolName: CODING_WRITE_FILE_TOOL,
        },
      ],
      providerState: { interruptedDuringTools: true },
    };
    const create = vi.fn().mockResolvedValue(
      response({ id: 'safe-interaction', output_text: 'Recovered safely.' }),
    );

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create),
    }).run({
      prompt: 'Continue.',
      runtime: new MemoryCodingRuntime(),
      session: prior,
    });

    expect(create.mock.calls[0][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(create.mock.calls[0][0].input).toEqual(expect.any(String));
    expect(String(create.mock.calls[0][0].input)).toContain(
      'RECOVERED HISTORY — UNTRUSTED DATA',
    );
    expect(String(create.mock.calls[0][0].input)).toContain(
      'src/already-applied.ts',
    );
    expect(String(create.mock.calls[0][0].input)).toContain('Continue.');
    expect(result.session.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'recovery', role: 'system' }),
      ]),
    );
  });

  it('persists a completed mutating tool result before a racing Stop propagates', async () => {
    const controller = new AbortController();
    const create = vi.fn().mockResolvedValue(
      response({
        id: 'write-stop-race',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'write-before-stop',
            name: CODING_WRITE_FILE_TOOL,
            arguments: {
              file_path: 'src/durable-before-stop.ts',
              content: 'export const durable = true;\n',
            },
          },
        ],
      }),
    );
    const runtime = new MemoryCodingRuntime();
    const realWrite = runtime.writeText.bind(runtime);
    const writeText = vi.spyOn(runtime, 'writeText').mockImplementation(
      async (path, content) => {
        await realWrite(path, content);
        controller.abort();
      },
    );
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Write once, even if Stop races completion.',
        runtime,
        abortSignal: controller.signal,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(runtime.files.get('src/durable-before-stop.ts')).toContain(
      'durable = true',
    );
    expect(snapshots.at(-1)?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool-result',
          toolCallId: 'write-before-stop',
          isError: false,
        }),
      ]),
    );
    expect(snapshots.at(-1)?.providerState.interruptedDuringTools).toBe(false);
  });

  it('keeps interruptedDuringTools clear when Stop races the next inference', async () => {
    const controller = new AbortController();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'tool-result-durable',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'durable-write',
              name: CODING_WRITE_FILE_TOOL,
              arguments: {
                file_path: 'src/next-inference.ts',
                content: 'export const ready = true;\n',
              },
            },
          ],
        }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        const error = new Error('Coding task was stopped.');
        error.name = 'AbortError';
        throw error;
      });
    const runtime = new MemoryCodingRuntime();
    const writeText = vi.spyOn(runtime, 'writeText');
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Stop only after the result is durable.',
        runtime,
        abortSignal: controller.signal,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(snapshots.at(-1)?.providerState.interruptedDuringTools).toBe(false);
    expect(snapshots.at(-1)?.providerState.pendingProviderTurn).toBe(true);
    expect(snapshots.at(-1)?.transcript).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'tool-result',
          toolCallId: 'durable-write',
        }),
      ]),
    );
  });

  it('clears the tool interruption guard once every result is durable before the next inference', async () => {
    const unavailable = Object.assign(new Error('service unavailable'), {
      status: 503,
    });
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'tool-interaction',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'write-once',
              name: CODING_WRITE_FILE_TOOL,
              arguments: {
                file_path: 'src/write-once.ts',
                content: 'export const once = true;\n',
              },
            },
          ],
        }),
      )
      .mockRejectedValue(unavailable);
    const runtime = new MemoryCodingRuntime();
    const writeText = vi.spyOn(runtime, 'writeText');
    const snapshots: CodingHarnessSession[] = [];

    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Write the file once.',
        runtime,
        retryBaseDelayMs: 0,
        onSession: (session) => {
          snapshots.push(session);
        },
      }),
    ).rejects.toThrow('service unavailable');

    expect(create).toHaveBeenCalledTimes(GEMINI_API_MAX_RETRIES + 2);
    expect(writeText).toHaveBeenCalledTimes(1);
    const interrupted = snapshots[snapshots.length - 1];
    expect(interrupted.providerState.interruptedDuringTools).toBe(false);
    expect(interrupted.previousInteractionId).toBe('tool-interaction');

    const resumeCreate = vi.fn().mockResolvedValue(
      response({
        id: 'recovered-interaction',
        output_text: 'Recovered without replaying the write.',
      }),
    );
    const resumed = await new GeminiInteractionsCodingHarness({
      client: client(resumeCreate),
    }).run({
      prompt: 'Resume safely.',
      runtime,
      session: interrupted,
    });

    expect(resumeCreate.mock.calls[0][0]).not.toHaveProperty(
      'previous_interaction_id',
    );
    expect(resumeCreate.mock.calls[0][0].input).toEqual(expect.any(String));
    expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
      'src/write-once.ts',
    );
    expect(String(resumeCreate.mock.calls[0][0].input)).toContain(
      'Resume safely.',
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(resumed.session.providerState.interruptedDuringTools).toBe(false);
  });
});

describe('coding harness VM tools', () => {
  it('propagates cancellation into a running command and does not turn it into a tool result', async () => {
    const runtime = new MemoryCodingRuntime();
    const controller = new AbortController();
    vi.spyOn(runtime, 'runCommand').mockImplementation(
      async (_command, options) =>
        new Promise((_, reject) => {
          expect(options?.signal).toBe(controller.signal);
          options?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('command stopped');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const execution = executeCodingToolCall(
      runtime,
      {
        id: 'abort-command',
        name: CODING_RUN_COMMAND_TOOL,
        arguments: { command: 'long-running-task' },
      },
      controller.signal,
    );
    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('confines direct file tools to the durable workspace', async () => {
    expect(normalizeCodingWorkspacePath('/workspace/src/a.ts', '/workspace')).toBe(
      'src/a.ts',
    );
    expect(normalizeCodingWorkspacePath('/src/a.ts', '/')).toBe('src/a.ts');
    expect(normalizeCodingWorkspacePath('/', '/')).toBe('');
    expect(() =>
      normalizeCodingWorkspacePath('/etc/passwd', '/workspace'),
    ).toThrow('outside the workspace');
    expect(() =>
      normalizeCodingWorkspacePath('../../etc/passwd', '/workspace'),
    ).toThrow('cannot escape');
  });

  it('blocks direct secret reads and redacts common keys from command output', async () => {
    const syntheticGoogleKey = `AI${'za'}${'1'.repeat(30)}`;
    const runtime = new MemoryCodingRuntime({
      '.env': `GEMINI_API_KEY=${syntheticGoogleKey}`,
    });
    const secretRead = await executeCodingToolCall(runtime, {
      id: 'read-secret',
      name: CODING_READ_FILE_TOOL,
      arguments: { file_path: '.env' },
    });
    expect(secretRead.isError).toBe(true);
    expect(secretRead.content).not.toContain('AIza');

    runtime.runCommand = vi.fn().mockResolvedValue({
      status: 0,
      output: `token tskey-auth-abc123 and ${syntheticGoogleKey}\nCUSTOM_ACCESS_TOKEN=super-secret`,
    });
    const command = await executeCodingToolCall(runtime, {
      id: 'command-output',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: { command: 'some-tool' },
    });
    expect(command.content).not.toContain('tskey-auth');
    expect(command.content).not.toContain('AIza');
    expect(command.content).toContain('[REDACTED_TAILSCALE_KEY]');
    expect(command.content).toContain('[REDACTED_GOOGLE_KEY]');
    expect(command.content).not.toContain('super-secret');
  });

  it('redacts GitHub and Stripe tokens from shell output and activity display', async () => {
    const githubToken = `ghp_${'f'.repeat(36)}`;
    const stripeKey = `sk_live_${'9'.repeat(24)}`;
    const runtime = new MemoryCodingRuntime();
    runtime.runCommand = vi.fn().mockResolvedValue({
      status: 0,
      output: `github=${githubToken}\nAuthorization: Bearer ${stripeKey}`,
    });

    const command = await executeCodingToolCall(runtime, {
      id: 'prefixed-secret-output',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: { command: `printf '%s' ${githubToken} ${stripeKey}` },
    });

    expect(command.content).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(command.content).toContain('[REDACTED_STRIPE_KEY]');
    expect(command.content).not.toContain(githubToken);
    expect(command.content).not.toContain(stripeKey);
    expect(command.display).not.toContain(githubToken);
    expect(command.display).not.toContain(stripeKey);
  });

  it.each([
    '.npmrc',
    '.netrc',
    '.pypirc',
    '.git-credentials',
    '.envrc',
    '.aws/credentials',
    '.config/gh/hosts.yml',
    '.config/gh/hosts.yaml',
    '.docker/config.json',
    '.ssh/id_rsa',
    '.ssh/id_ed25519',
    '.ssh/work-github',
    'nested/.ssh/id_ecdsa_sk',
    'keys/id_rsa',
    'keys/id_dsa',
    'keys/id_ecdsa',
    'keys/id_ed25519',
    'keys/id_ecdsa_sk',
    'keys/id_ed25519_sk',
    'keys/id_xmss',
  ])('blocks direct reads of credential file %s', async (filePath) => {
    const runtime = new MemoryCodingRuntime({
      [filePath]: 'credential-value-that-must-not-be-returned',
    });
    const result = await executeCodingToolCall(runtime, {
      id: 'read-credential',
      name: CODING_READ_FILE_TOOL,
      arguments: { file_path: filePath },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('secret-bearing files is blocked');
    expect(result.content).not.toContain('credential-value');
  });

  it('applies the credential-path boundary to write and replace tools', async () => {
    const runtime = new MemoryCodingRuntime({
      '.config/gh/hosts.yml': 'existing credential',
    });
    const write = await executeCodingToolCall(runtime, {
      id: 'write-credential',
      name: CODING_WRITE_FILE_TOOL,
      arguments: {
        file_path: '.aws/credentials',
        content: 'new credential',
      },
    });
    const replace = await executeCodingToolCall(runtime, {
      id: 'replace-credential',
      name: CODING_REPLACE_TOOL,
      arguments: {
        file_path: '.config/gh/hosts.yml',
        old_string: 'existing',
        new_string: 'changed',
      },
    });

    expect(write.isError).toBe(true);
    expect(write.content).toContain('Writing secret-bearing files');
    expect(replace.isError).toBe(true);
    expect(replace.content).toContain('Editing secret-bearing files');
    await expect(runtime.readText('.aws/credentials')).rejects.toThrow(
      'Missing file',
    );
    await expect(runtime.readText('.config/gh/hosts.yml')).resolves.toBe(
      'existing credential',
    );
  });

  it.each([
    '.env.example',
    '.aws/credentials.md',
    '.config/gh/config.yml',
    'keys/id_rsa.pub',
    'docs/id_ed25519-format.md',
  ])('does not block a nearby non-secret path %s', async (filePath) => {
    const runtime = new MemoryCodingRuntime({ [filePath]: 'safe fixture' });
    const result = await executeCodingToolCall(runtime, {
      id: 'read-non-secret',
      name: CODING_READ_FILE_TOOL,
      arguments: { file_path: filePath },
    });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('safe fixture');
  });

  it('redacts npm registry tokens from direct reads, shell output, and activity display', async () => {
    const token = 'npm_exampleToken1234567890';
    const npmrcLine = `//registry.npmjs.org/:_authToken=${token}`;
    const runtime = new MemoryCodingRuntime({
      'logs/install.log': npmrcLine,
    });

    const read = await executeCodingToolCall(runtime, {
      id: 'read-log',
      name: CODING_READ_FILE_TOOL,
      arguments: { file_path: 'logs/install.log' },
    });
    expect(read.isError).toBe(false);
    expect(read.content).toContain('[REDACTED_NPM_TOKEN]');
    expect(read.content).not.toContain(token);

    runtime.runCommand = vi.fn().mockResolvedValue({
      status: 0,
      output: `registry response: ${npmrcLine}`,
    });
    const command = await executeCodingToolCall(runtime, {
      id: 'npm-output',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: { command: `printf '%s' ${token}` },
    });
    expect(command.content).toContain('[REDACTED_NPM_TOKEN]');
    expect(command.content).not.toContain(token);
    expect(command.display).not.toContain(token);
  });

  it('validates and reports managed preview startup', async () => {
    const runtime = new MemoryCodingRuntime();
    const preview = await executeCodingToolCall(runtime, {
      id: 'preview',
      name: CODING_START_PREVIEW_TOOL,
      arguments: {
        command: 'python3 -m http.server 8081 --bind 0.0.0.0',
        port: 8081,
        cwd: '/workspace/site',
      },
    });

    expect(preview).toMatchObject({
      isError: false,
      display: 'Preview ready at https://100.64.0.25:8081',
      changedFiles: [],
    });
    expect(preview.content).toContain('Preview process started on port 8081');
    expect(preview.content).toContain('https://100.64.0.25:8081');
    expect(runtime.previews).toEqual([
      {
        command: 'python3 -m http.server 8081 --bind 0.0.0.0',
        port: 8081,
        cwd: '/workspace/site',
      },
    ]);

    const invalidPort = await executeCodingToolCall(runtime, {
      id: 'invalid-preview-port',
      name: CODING_START_PREVIEW_TOOL,
      arguments: {
        command: 'python3 -m http.server 80',
        port: 80,
      },
    });
    expect(invalidPort.isError).toBe(true);
    expect(invalidPort.content).toContain('between 1024 and 65535');
    expect(runtime.previews).toHaveLength(1);

    runtime.startPreview = vi.fn().mockResolvedValue({
      status: 1,
      output: `GEMINI_API_KEY=${`AI${'za'}${'1'.repeat(30)}`}\nCUSTOM_ACCESS_TOKEN=preview-secret`,
      background: true,
      port: 8082,
      url: null,
    });
    const failedPreview = await executeCodingToolCall(runtime, {
      id: 'failed-preview',
      name: CODING_START_PREVIEW_TOOL,
      arguments: {
        command: 'npm run dev -- --host 0.0.0.0 --port 8082',
        port: 8082,
      },
    });
    expect(failedPreview.isError).toBe(true);
    expect(failedPreview.content).toContain('[REDACTED]');
    expect(failedPreview.content).not.toContain('AIza');
    expect(failedPreview.content).not.toContain('preview-secret');
  });

  it.each([
    'mkfs.ext4 /dev/sda',
    '/sbin/mkfs.ext4 /dev/sda',
    'wipefs --all /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    'find / -xdev -delete',
    '/usr/bin/find / -xdev -delete',
    '/bin/rm -rf --no-preserve-root /',
    'env TEST_MODE=1 /bin/rm -rf /',
    "env -S '/bin/rm -rf /'",
    '/usr/bin/env TEST_MODE=1 command /bin/rm -rf /',
    'command /usr/bin/find / -delete',
    "bash -c '/bin/rm -rf /'",
    "bash -lc 'cd /; rm -rf *'",
    'cd /; rm -rf *',
    'cd / && rm --recursive --force .',
    '(cd /; rm -rf *)',
    'env -C / rm -rf *',
    'echo $(rm -rf /)',
    'echo "$(rm -rf /*)"',
    'echo `rm -rf /`',
    'cd / && echo "$(rm -rf *)"',
  ])('blocks catastrophic full-VM command: %s', async (command) => {
    const runtime = new MemoryCodingRuntime();
    const result = await executeCodingToolCall(runtime, {
      id: 'catastrophic-command',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: { command },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('blocked');
    expect(runtime.commands).toHaveLength(0);
  });

  it.each([
    { command: 'rm -rf .', cwd: '/' },
    { command: 'rm -rf *', cwd: '/' },
    { command: 'rm -rf ./*', cwd: '/' },
    { command: 'rm --recursive --force /tmp/..', cwd: '/workspace/site' },
    { command: 'cd /definitely-missing; rm -rf *', cwd: '/' },
    { command: 'cd /definitely-missing || rm -rf *', cwd: '/' },
    { command: 'false && cd /tmp; rm -rf *', cwd: '/' },
    { command: 'true || cd /tmp; rm -rf *', cwd: '/' },
  ])(
    'blocks $command when its literal target resolves to root from $cwd',
    async ({ command, cwd }) => {
      const runtime = new MemoryCodingRuntime();
      const result = await executeCodingToolCall(runtime, {
        id: 'cwd-root-destruction',
        name: CODING_RUN_COMMAND_TOOL,
        arguments: { command, cwd },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('blocked');
      expect(runtime.commands).toHaveLength(0);
    },
  );

  it.each([
    { command: 'rm -rf .', cwd: '/workspace/site' },
    { command: 'rm -rf *', cwd: '/workspace/site' },
    { command: 'cd /tmp; rm -rf *', cwd: '/workspace/site' },
    { command: 'cd /tmp && rm -rf *', cwd: '/' },
    { command: 'cd /tmp && echo "$(rm -rf *)"', cwd: '/' },
    { command: 'cd /tmp && echo $(rm -rf *)', cwd: '/' },
    {
      command: 'cd /definitely-missing; rm -rf *',
      cwd: '/workspace/site',
    },
    {
      command: 'cd /definitely-missing && rm -rf *',
      cwd: '/',
    },
    { command: 'cd / || rm -rf *', cwd: '/workspace/site' },
    { command: 'cd / | cat; rm -rf *', cwd: '/workspace/site' },
    { command: "echo '$(rm -rf /)'", cwd: '/workspace/site' },
    { command: "printf '%s\\n' 'rm -rf /'", cwd: '/workspace/site' },
    { command: 'echo "rm -rf /"', cwd: '/workspace/site' },
    { command: "bash -c 'echo \\\"rm -rf /\\\"'", cwd: '/workspace/site' },
    { command: 'rm -rf /tmp/project', cwd: '/' },
  ])(
    'allows finite non-root command $command from $cwd',
    async ({ command, cwd }) => {
      const runtime = new MemoryCodingRuntime();
      const result = await executeCodingToolCall(runtime, {
        id: 'finite-cleanup',
        name: CODING_RUN_COMMAND_TOOL,
        arguments: { command, cwd },
      });

      expect(result.isError).toBe(false);
      expect(runtime.commands).toHaveLength(1);
      expect(runtime.commands[0].options?.cwd).toBe(cwd);
    },
  );

  it('rejects detached run_command work instead of claiming it completed', async () => {
    const runtime = new MemoryCodingRuntime();

    const result = await executeCodingToolCall(runtime, {
      id: 'detached-command',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: {
        command: 'npm test && false',
        background: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Detached run_command processes are not supported');
    expect(result.content).not.toContain('Command completed');
    expect(runtime.commands).toHaveLength(0);
  });

  it('permits full-VM commands but blocks whole-root destruction', async () => {
    const runtime = new MemoryCodingRuntime();
    const install = await executeCodingToolCall(runtime, {
      id: 'install',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: {
        command: 'apt-get update && apt-get install -y git',
        cwd: '/',
        timeout_ms: 300_000,
      },
    });
    expect(install.isError).toBe(false);
    expect(runtime.commands[0].options).toMatchObject({
      cwd: '/',
      timeoutMs: 300_000,
    });

    const destructive = await executeCodingToolCall(runtime, {
      id: 'destroy',
      name: CODING_RUN_COMMAND_TOOL,
      arguments: { command: 'rm -r -f /' },
    });
    expect(destructive.isError).toBe(true);
    expect(destructive.content).toContain('blocked');
    expect(runtime.commands).toHaveLength(1);

    const destructivePreview = await executeCodingToolCall(runtime, {
      id: 'destroy-preview',
      name: CODING_START_PREVIEW_TOOL,
      arguments: {
        command: 'rm --recursive --force *',
        port: 8081,
        cwd: '/',
      },
    });
    expect(destructivePreview.isError).toBe(true);
    expect(destructivePreview.content).toContain('blocked');
    expect(runtime.previews).toHaveLength(0);
  });
});

describe('environment instruction', () => {
  it('renders the guest toolchain facts into the system instruction', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      response({
        id: 'interaction-env-1',
        status: 'completed',
        output_text: 'Done.',
      }),
    );
    const harness = new GeminiInteractionsCodingHarness({
      client: client(create),
      environmentInstruction:
        'Guest OS: Debian 10.\nNOT installed: Node.js, npm.\nNo public internet from the guest.',
      additionalSystemInstruction: 'Keep the palette monochrome.',
    });
    await harness.run({
      prompt: 'Say done.',
      runtime: new MemoryCodingRuntime(),
    });
    const instruction = create.mock.calls[0][0].system_instruction as string;
    expect(instruction).toContain('Execution environment (authoritative');
    expect(instruction).toContain('NOT installed: Node.js, npm.');
    expect(instruction).toContain('No public internet from the guest.');
    expect(instruction).toContain('Project-specific instructions:');
    expect(instruction.indexOf('Execution environment')).toBeLessThan(
      instruction.indexOf('Project-specific instructions:'),
    );
  });
});

describe('provider execution resubmission', () => {
  const highDemand = () =>
    Object.assign(
      new Error(
        '500 The model is currently experiencing high demand, spikes in demand are usually temporary. Please try again later.',
      ),
      { status: 500 },
    );

  it('resubmits the same turn to the same model as soon as the accepted interaction dies', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 'dead-1', status: 'in_progress' }))
      .mockResolvedValueOnce(
        response({ id: 'alive-2', output_text: 'Finished after resubmission.' }),
      );
    // Measured: the first "high demand" 5xx from GET is the death notice.
    const get = vi.fn().mockRejectedValueOnce(highDemand());
    const cancel = vi.fn();
    const events: string[] = [];
    const snapshots: CodingHarnessSession[] = [];

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get, cancel }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'Build the page.',
      runtime: new MemoryCodingRuntime(),
      retryBaseDelayMs: 0,
      onEvent: (event) => events.push(event.message),
      onSession: (session) => {
        snapshots.push(session);
      },
    });

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0].model).toBe(MODEL_ID);
    expect(create.mock.calls[1][0].model).toBe(MODEL_ID);
    expect(create.mock.calls[1][0].input).toBe('Build the page.');
    // A dead interaction answers cancel with 500 forever; never demand it.
    expect(cancel).not.toHaveBeenCalled();
    expect(result.finalText).toBe('Finished after resubmission.');
    expect(result.session.model).toBe(MODEL_ID);
    expect(result.session.previousInteractionId).toBe('alive-2');
    expect(result.session.providerState.pendingInteractionId).toBeUndefined();
    expect(result.session.providerState.unconfirmedCancellationIds).toBeUndefined();
    expect(events).toContainEqual(
      expect.stringContaining('Resubmitting the same request to gemini-3.7-flash'),
    );
    expect(events).toContainEqual(
      expect.stringContaining('execution attempt 2/9'),
    );
    expect(
      snapshots.some(
        (snapshot) => snapshot.providerState.pendingInteractionId === 'dead-1',
      ),
    ).toBe(true);
  });

  it('keeps previous_interaction_id when resubmitting a tool turn whose execution died', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'turn-1',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'call-1',
              name: CODING_LIST_DIRECTORY_TOOL,
              arguments: { dir_path: '' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ id: 'turn-2-dead', status: 'in_progress' }))
      .mockResolvedValueOnce(
        response({ id: 'turn-2-resubmitted', output_text: 'Done.' }),
      );
    const get = vi.fn().mockRejectedValueOnce(highDemand());

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'List then finish.',
      runtime: new MemoryCodingRuntime({ 'index.html': '<h1>hi</h1>' }),
      retryBaseDelayMs: 0,
    });

    expect(create).toHaveBeenCalledTimes(3);
    const resubmitted = create.mock.calls.at(-1)?.[0];
    expect(resubmitted.model).toBe(MODEL_ID);
    expect(resubmitted.previous_interaction_id).toBe('turn-1');
    expect(resubmitted.input).toEqual([
      expect.objectContaining({ type: 'function_result', call_id: 'call-1' }),
    ]);
    expect(result.finalText).toBe('Done.');
  });

  it('resubmits after a terminal failed status caused by capacity', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(response({ id: 'failed-status', status: 'in_progress' }))
      .mockResolvedValueOnce(response({ id: 'ok-2', output_text: 'Recovered.' }));
    const get = vi.fn().mockResolvedValueOnce(
      response({
        id: 'failed-status',
        status: 'failed',
        errors: [{ code: 500, message: 'The model is currently experiencing high demand.' }],
      }),
    );

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'Recover from failed status.',
      runtime: new MemoryCodingRuntime(),
      retryBaseDelayMs: 0,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe('Recovered.');
  });

  it('grants the execution allowance to every turn, not once per run', async () => {
    const create = vi.fn();
    const get = vi.fn();
    // Turn 1: eight deaths, then a tool call.
    for (let death = 0; death < GEMINI_EXECUTION_RETRIES; death += 1) {
      create.mockResolvedValueOnce(response({ id: `t1-dead-${death}`, status: 'in_progress' }));
      get.mockRejectedValueOnce(highDemand());
    }
    create.mockResolvedValueOnce(
      response({
        id: 't1-ok',
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: 'call-1',
            name: CODING_LIST_DIRECTORY_TOOL,
            arguments: { dir_path: '' },
          },
        ],
      }),
    );
    // Turn 2: one more death must still be absorbed.
    create.mockResolvedValueOnce(response({ id: 't2-dead', status: 'in_progress' }));
    get.mockRejectedValueOnce(highDemand());
    create.mockResolvedValueOnce(response({ id: 't2-ok', output_text: 'Done.' }));

    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { get }),
      backgroundPollIntervalMs: 0,
    }).run({
      prompt: 'Survive deaths across turns.',
      runtime: new MemoryCodingRuntime(),
      retryBaseDelayMs: 0,
    });
    expect(result.finalText).toBe('Done.');
    expect(create).toHaveBeenCalledTimes(GEMINI_EXECUTION_RETRIES + 1 + 2);
    expect(create.mock.calls.at(-1)?.[0].previous_interaction_id).toBe('t1-ok');
  });

  it('does not resubmit when create itself exhausted its transport allowance', async () => {
    const create = vi.fn().mockRejectedValue(highDemand());
    await expect(
      new GeminiInteractionsCodingHarness({ client: client(create) }).run({
        prompt: 'Create exhaustion keeps the exact D-007 count.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('high demand');
    expect(create).toHaveBeenCalledTimes(GEMINI_API_MAX_RETRIES + 1);
  });

  it('gives up after the execution allowance and never resubmits a permanent client error', async () => {
    const create = vi.fn().mockResolvedValue(
      response({ id: 'always-dies', status: 'in_progress' }),
    );
    const get = vi.fn().mockRejectedValue(highDemand());
    const events: string[] = [];
    await expect(
      new GeminiInteractionsCodingHarness({
        client: client(create, { get }),
        backgroundPollIntervalMs: 0,
      }).run({
        prompt: 'Exhaust the execution allowance.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
        onEvent: (event) => events.push(event.message),
      }),
    ).rejects.toThrow('high demand');
    expect(GEMINI_EXECUTION_RETRIES).toBe(8);
    expect(create).toHaveBeenCalledTimes(GEMINI_EXECUTION_RETRIES + 1);
    expect(get).toHaveBeenCalledTimes(GEMINI_EXECUTION_RETRIES + 1);
    expect(events.filter((event) => event.includes('Resubmitting'))).toHaveLength(
      GEMINI_EXECUTION_RETRIES,
    );

    const badRequest = Object.assign(new Error('400 tools[0] is invalid'), {
      status: 400,
    });
    const rejecting = vi.fn().mockRejectedValueOnce(badRequest);
    await expect(
      new GeminiInteractionsCodingHarness({ client: client(rejecting) }).run({
        prompt: 'Bad request stays fatal.',
        runtime: new MemoryCodingRuntime(),
        retryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('tools[0] is invalid');
    expect(rejecting).toHaveBeenCalledTimes(1);
  });

  it('treats a 400 "Invalid interaction name" cancellation as already terminal', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      response({ id: 'fresh', output_text: 'Done.' }),
    );
    const cancel = vi.fn().mockRejectedValue(
      Object.assign(
        new Error('400 Invalid interaction name: interactions/v1_gone'),
        { status: 400 },
      ),
    );
    const prior = {
      version: 1 as const,
      id: 'session-gone',
      provider: GEMINI_INTERACTIONS_PROVIDER,
      model: MODEL_ID,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      previousInteractionId: null,
      transcript: [],
      providerState: { pendingInteractionId: 'v1_gone' },
    };
    const result = await new GeminiInteractionsCodingHarness({
      client: client(create, { cancel }),
    }).run({
      prompt: 'Continue after a forgotten interaction.',
      runtime: new MemoryCodingRuntime(),
      session: prior,
      retryBaseDelayMs: 0,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.finalText).toBe('Done.');
    expect(result.session.providerState.unconfirmedCancellationIds).toBeUndefined();
  });

  it('appends file parts in order and invalidates prior inspections', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          id: 'append-1',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'w',
              name: CODING_WRITE_FILE_TOOL,
              arguments: { file_path: 'index.html', content: '<html>\n' },
            },
            {
              type: 'function_call',
              id: 'a',
              name: CODING_APPEND_FILE_TOOL,
              arguments: { file_path: 'index.html', content: '<body></body>\n' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ id: 'append-2', output_text: 'Done.' }));
    const runtime = new MemoryCodingRuntime();
    await new GeminiInteractionsCodingHarness({ client: client(create) }).run({
      prompt: 'Write in parts.',
      runtime,
      retryBaseDelayMs: 0,
    });
    expect(runtime.files.get('index.html')).toBe('<html>\n<body></body>\n');
    expect(create.mock.calls[1][0].input).toEqual([
      expect.objectContaining({ call_id: 'w' }),
      expect.objectContaining({
        call_id: 'a',
        result: [
          expect.objectContaining({
            text: expect.stringContaining('Appended 14 characters'),
          }),
        ],
      }),
    ]);
  });
});
