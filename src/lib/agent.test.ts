import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { runWebsiteAgent } from './agent';
import { MODEL_ID, SERVER_COMMAND } from './constants';
import { MemoryVmFileBackend } from './tools';

function response(value: unknown): GenerateContentResponse {
  return value as GenerateContentResponse;
}

describe('website agent loop', () => {
  it('uses the single configured model and executes tool calls until final text', async () => {
    const backend = new MemoryVmFileBackend();
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'write-index',
                      name: 'write_file',
                      args: {
                        file_path: 'index.html',
                        content:
                          '<!doctype html><html><body><h1>Hello world</h1></body></html>',
                      },
                    },
                  },
                  {
                    functionCall: {
                      id: 'start-server',
                      name: 'run_shell_command',
                      args: {
                        command: SERVER_COMMAND,
                      },
                    },
                  },
                ],
              },
            },
          ],
          functionCalls: [
            {
              id: 'write-index',
              name: 'write_file',
              args: {
                file_path: 'index.html',
                content:
                  '<!doctype html><html><body><h1>Hello world</h1></body></html>',
              },
            },
            {
              id: 'start-server',
              name: 'run_shell_command',
              args: {
                command: SERVER_COMMAND,
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          text: 'Done.',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Done.' }],
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
      ai: { models: { generateContent } },
      onEvent: (event) => events.push(`${event.type}:${event.message}`),
    });

    expect(result).toEqual({
      finalText: 'Website files were created and the VM web server was started.',
      changedFiles: ['index.html'],
    });
    expect(backend.snapshot()['index.html']).toContain('Hello world');
    expect(backend.commands[0]).toMatchObject({
      command: SERVER_COMMAND,
      background: true,
    });
    expect(events.some((event) => event.includes('Wrote'))).toBe(true);

    expect(generateContent).toHaveBeenCalledTimes(1);
    for (const call of generateContent.mock.calls) {
      expect(call[0].model).toBe(MODEL_ID);
    }
  });

  it('returns tool errors to the model so it can recover', async () => {
    const backend = new MemoryVmFileBackend();
    const generateContent = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          functionCalls: [
            {
              name: 'read_file',
              args: { file_path: '../outside.txt' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          text: 'Recovered.',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Recovered.' }],
              },
            },
          ],
        }),
      );

    const result = await runWebsiteAgent({
      apiKey: 'test-key',
      prompt: 'make a page',
      backend,
      ai: { models: { generateContent } },
    });

    expect(result.finalText).toBe('Recovered.');
    const secondTurnContents = generateContent.mock.calls[1][0].contents;
    expect(JSON.stringify(secondTurnContents)).toContain('functionResponse');
    expect(JSON.stringify(secondTurnContents)).toContain('cannot escape');
  });

  it('requires a non-empty website prompt', async () => {
    await expect(
      runWebsiteAgent({
        apiKey: 'test-key',
        prompt: '   ',
        backend: new MemoryVmFileBackend(),
        ai: { models: { generateContent: vi.fn() } },
      }),
    ).rejects.toThrow('Describe the website');
  });

  it('uses a larger default turn budget and returns a usable result if the budget is reached after edits', async () => {
    const backend = new MemoryVmFileBackend();
    const generateContent = vi.fn().mockImplementation(async () =>
      response({
        functionCalls: [
          {
            name: 'write_file',
            args: {
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
      ai: { models: { generateContent } },
    });

    expect(generateContent).toHaveBeenCalledTimes(40);
    expect(result.reachedTurnBudget).toBe(true);
    expect(result.changedFiles).toEqual(['index.html']);
    expect(result.finalText).toContain('Serving the latest generated version');
  });
});
