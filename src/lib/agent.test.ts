import { describe, expect, it, vi } from 'vitest';
import { runWebsiteAgent } from './agent';
import { MODEL_ID, SERVER_COMMAND } from './constants';
import { MemoryVmFileBackend } from './tools';

type TestInteraction = {
  id: string;
  status: string;
  steps?: Array<{
    type: string;
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  output_text?: string;
};

function interaction(value: TestInteraction): TestInteraction {
  return value;
}

describe('website agent loop', () => {
  it('uses the single configured model and executes tool calls until final text', async () => {
    expect(MODEL_ID).toBe('gemini-3.7-flash');

    const backend = new MemoryVmFileBackend();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        interaction({
          id: 'int-write',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'write-index',
              name: 'write_file',
              arguments: {
                file_path: 'index.html',
                content:
                  '<!doctype html><html><body><h1>Hello world</h1></body></html>',
              },
            },
            {
              type: 'function_call',
              id: 'start-server',
              name: 'run_shell_command',
              arguments: {
                command: SERVER_COMMAND,
              },
            },
          ],
        }),
      );

    const events: string[] = [];
    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a hello world site',
      backend,
      ai: { interactions: { create } },
      onEvent: (event) => events.push(`${event.type}:${event.message}`),
    });

    expect(result).toEqual({
      finalText:
        'Website files were created. The host app is starting the VM web server.',
      changedFiles: ['index.html'],
    });
    expect(backend.snapshot()['index.html']).toContain('Hello world');
    expect(backend.commands).toHaveLength(0);
    expect(events.some((event) => event.includes('Wrote'))).toBe(true);
    expect(
      events.some((event) => event.includes('Deferred server start')),
    ).toBe(true);

    expect(create).toHaveBeenCalledTimes(1);
    for (const call of create.mock.calls) {
      expect(call[0].model).toBe(MODEL_ID);
      expect(call[0].system_instruction).toContain('website-building agent');
      expect(call[0].tools[0]).toMatchObject({
        type: 'function',
        name: 'read_file',
      });
      expect(call[1]).toMatchObject({ maxRetries: 0 });
    }
  });

  it('returns tool errors to the model so it can recover', async () => {
    const backend = new MemoryVmFileBackend();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        interaction({
          id: 'int-read-error',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'read-outside',
              name: 'read_file',
              arguments: { file_path: '../outside.txt' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        interaction({
          id: 'int-recovered',
          status: 'completed',
          output_text: 'Recovered.',
        }),
      );

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a page',
      backend,
      ai: { interactions: { create } },
    });

    expect(result.finalText).toBe('Recovered.');
    const secondRequest = create.mock.calls[1][0];
    expect(secondRequest.previous_interaction_id).toBe('int-read-error');
    expect(JSON.stringify(secondRequest.input)).toContain('function_result');
    expect(JSON.stringify(secondRequest.input)).toContain('cannot escape');
    expect(secondRequest.system_instruction).toContain(
      'website-building agent',
    );
    expect(secondRequest.tools).toEqual(expect.any(Array));
    expect(secondRequest.tools[0]).toMatchObject({
      type: 'function',
      name: 'read_file',
    });
  });

  it('retries a transient Gemini 503 response', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          '{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}',
        ),
      )
      .mockRejectedValueOnce(new TypeError('Load failed'))
      .mockResolvedValueOnce(
        interaction({
          id: 'int-retry-recovered',
          status: 'completed',
          output_text: 'Recovered after retry.',
        }),
      );
    const events: string[] = [];

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a page',
      backend: new MemoryVmFileBackend(),
      ai: { interactions: { create } },
      modelRetryBaseDelayMs: 0,
      onEvent: (event) => events.push(`${event.type}:${event.message}`),
    });

    expect(create).toHaveBeenCalledTimes(3);
    expect(result.finalText).toBe('Recovered after retry.');
    expect(events).toContainEqual(
      expect.stringContaining('status:Gemini is temporarily unavailable'),
    );
  });

  it('retries a client-side API timeout instead of treating it as Stop', async () => {
    const create = vi
      .fn()
      .mockImplementationOnce(
        (
          _params: unknown,
          requestOptions: { signal: AbortSignal },
        ) =>
          new Promise<TestInteraction>((_resolve, reject) => {
            requestOptions.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('signal is aborted without reason');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(
        interaction({
          id: 'int-timeout-recovered',
          status: 'completed',
          output_text: 'Recovered after timeout.',
        }),
      );

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a page',
      backend: new MemoryVmFileBackend(),
      ai: { interactions: { create } },
      turnTimeoutMs: 1,
      modelRetryBaseDelayMs: 0,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.finalText).toBe('Recovered after timeout.');
  });

  it('makes eight retries before surfacing a persistent API failure', async () => {
    const unavailable = new Error(
      '{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}',
    );
    const create = vi.fn().mockRejectedValue(unavailable);

    await expect(
      runWebsiteAgent({
        apiKey: 'test-key',
        prompt: 'make a page',
        backend: new MemoryVmFileBackend(),
        ai: { interactions: { create } },
        modelRetryBaseDelayMs: 0,
      }),
    ).rejects.toThrow('high demand');

    expect(create).toHaveBeenCalledTimes(9);
  });

  it('handles distinct same-name parallel function calls', async () => {
    const backend = new MemoryVmFileBackend();
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        interaction({
          id: 'int-parallel-writes',
          status: 'requires_action',
          steps: [
            {
              type: 'function_call',
              id: 'write-a',
              name: 'write_file',
              arguments: {
                file_path: 'index.html',
                content: '<h1>A</h1>',
              },
            },
            {
              type: 'function_call',
              id: 'write-b',
              name: 'write_file',
              arguments: {
                file_path: 'about.html',
                content: '<h1>B</h1>',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        interaction({
          id: 'int-parallel-done',
          status: 'completed',
          output_text: 'Done.',
        }),
      );

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make two pages',
      backend,
      ai: { interactions: { create } },
    });

    expect(result.changedFiles).toEqual(['about.html', 'index.html']);
    expect(backend.snapshot()['index.html']).toContain('A');
    expect(backend.snapshot()['about.html']).toContain('B');

    const secondRequest = create.mock.calls[1][0];
    expect(secondRequest.previous_interaction_id).toBe('int-parallel-writes');
    expect(secondRequest.input).toHaveLength(2);
    expect(
      secondRequest.input.map(
        (item: { call_id: string }) => item.call_id,
      ),
    ).toEqual(['write-a', 'write-b']);
  });

  it('requires a non-empty website prompt', async () => {
    await expect(
      runWebsiteAgent({
        apiKey: 'test-key',
        prompt: '   ',
        backend: new MemoryVmFileBackend(),
        ai: { interactions: { create: vi.fn() } },
      }),
    ).rejects.toThrow('Describe the website');
  });

  it('uses a larger default turn budget and returns a usable result if the budget is reached after edits', async () => {
    const backend = new MemoryVmFileBackend();
    let interactionNumber = 0;
    const create = vi.fn().mockImplementation(async () =>
      interaction({
        id: `int-budget-${++interactionNumber}`,
        status: 'requires_action',
        steps: [
          {
            type: 'function_call',
            id: `write-budget-${interactionNumber}`,
            name: 'write_file',
            arguments: {
              file_path: 'index.html',
              content: '<h1>Still useful</h1>',
            },
          },
        ],
      }),
    );

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a slow site',
      backend,
      ai: { interactions: { create } },
    });

    expect(create).toHaveBeenCalledTimes(40);
    expect(result.reachedTurnBudget).toBe(true);
    expect(result.changedFiles).toEqual(['index.html']);
    expect(result.finalText).toContain('Serving the latest generated version');
  });
});
