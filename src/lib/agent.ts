import { GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentResponse } from '@google/genai';
import { MODEL_ID, SERVER_COMMAND, SITE_ROOT } from './constants';
import { SHELL_TOOL_NAME, TOOL_DECLARATIONS } from './toolSchemas';
import {
  executeToolCall,
  type ToolCall,
  type ToolExecutionResult,
  type VmFileBackend,
} from './tools';

type GenAiLike = {
  models: {
    generateContent(params: unknown): Promise<GenerateContentResponse>;
  };
};

export interface AgentEvent {
  type: 'model' | 'tool' | 'error' | 'done';
  message: string;
}

export interface AgentRunOptions {
  apiKey?: string;
  prompt: string;
  backend: VmFileBackend;
  ai?: GenAiLike;
  maxTurns?: number;
  abortSignal?: AbortSignal;
  turnTimeoutMs?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  finalText: string;
  changedFiles: string[];
  reachedTurnBudget?: boolean;
}

export const DEFAULT_AGENT_MAX_TURNS = 40;
const DEFAULT_TURN_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `
You are a website-building agent running inside a browser-hosted Linux VM.

Rules:
- Use only the provided tools to inspect and write files.
- All website files must live under ${SITE_ROOT}.
- Build a static website only: index.html, style.css, and optional script.js.
- Always create ${SITE_ROOT}/index.html.
- Write complete file contents. Never use placeholders or omitted sections.
- Do not call any model other than ${MODEL_ID}.
- Start the server with ${SERVER_COMMAND} exactly once, only after index.html and any referenced CSS/JS files exist.
- Inspect files with list_directory/read_file. If you need shell inspection, only use safe commands like pwd, ls, ls -R ${SITE_ROOT}, or find . -maxdepth 2 -type f.
- Never tell the user to open localhost. The host app will provide the real Tailnet preview URL.
- Prefer write_file for complete small static files. Use replace for targeted follow-up edits.
- After the server is started, immediately return a concise final summary. Do not inspect, list files, or make cosmetic edits after starting the server.
- Finish with a concise final summary instead of continuing to polish.
- Keep the result runnable without npm install or build steps. Use browser-native HTML, CSS, and JavaScript.
`;

function emit(options: AgentRunOptions, event: AgentEvent): void {
  options.onEvent?.(event);
}

function responseText(response: GenerateContentResponse): string {
  const maybeText = (response as { text?: unknown }).text;
  return typeof maybeText === 'string' ? maybeText : '';
}

function responseContent(response: GenerateContentResponse): Content | undefined {
  const candidate = response.candidates?.[0];
  if (candidate?.content) {
    return candidate.content;
  }
  const text = responseText(response);
  if (text) {
    return { role: 'model', parts: [{ text }] };
  }
  return undefined;
}

function extractFunctionCalls(response: GenerateContentResponse): ToolCall[] {
  const calls: ToolCall[] = [];
  const directCalls = (response as { functionCalls?: unknown }).functionCalls;
  if (Array.isArray(directCalls)) {
    for (const call of directCalls) {
      if (
        call &&
        typeof call === 'object' &&
        'name' in call &&
        typeof call.name === 'string'
      ) {
        calls.push({
          id:
            'id' in call && typeof call.id === 'string' ? call.id : undefined,
          name: call.name,
          args:
            'args' in call && call.args && typeof call.args === 'object'
              ? (call.args as Record<string, unknown>)
              : {},
        });
      }
    }
  }

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const functionCall = (part as { functionCall?: unknown }).functionCall;
    if (
      functionCall &&
      typeof functionCall === 'object' &&
      'name' in functionCall &&
      typeof functionCall.name === 'string'
    ) {
      const args =
        'args' in functionCall &&
        functionCall.args &&
        typeof functionCall.args === 'object'
          ? (functionCall.args as Record<string, unknown>)
          : {};
      const id =
        'id' in functionCall && typeof functionCall.id === 'string'
          ? functionCall.id
          : undefined;
      if (!calls.some((call) => call.id === id && call.name === functionCall.name)) {
        calls.push({ id, name: functionCall.name, args });
      }
    }
  }

  return calls;
}

function buildToolResponseContent(
  call: ToolCall,
  result: ToolExecutionResult,
): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: call.name,
          response: {
            result: result.llmContent,
            error: result.error ?? null,
          },
        },
      },
    ],
  } as Content;
}

function shouldNudgeToFinish(turn: number, maxTurns: number): boolean {
  return turn === Math.max(2, maxTurns - 5);
}

function isServerStartCall(call: ToolCall): boolean {
  if (call.name !== SHELL_TOOL_NAME) {
    return false;
  }
  return (
    typeof call.args.command === 'string' &&
    call.args.command.trim().replace(/\s+/g, ' ') === SERVER_COMMAND
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Website generation was stopped.');
    error.name = 'AbortError';
    throw error;
  }
}

async function withAbortableTurn<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AgentRunOptions,
): Promise<T> {
  throwIfAborted(options.abortSignal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeout = globalThis.setTimeout(
    abort,
    options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  );
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    globalThis.clearTimeout(timeout);
    options.abortSignal?.removeEventListener('abort', abort);
  }
}

function summarizeToolCall(call: ToolCall): string {
  const path =
    typeof call.args.file_path === 'string'
      ? call.args.file_path
      : typeof call.args.dir_path === 'string'
        ? call.args.dir_path || SITE_ROOT
        : '';
  switch (call.name) {
    case 'write_file':
      return `write_file ${path}`;
    case 'replace':
      return `replace ${path}`;
    case 'read_file':
      return `read_file ${path}`;
    case 'list_directory':
      return `list_directory ${path || SITE_ROOT}`;
    case SHELL_TOOL_NAME:
      return `run_shell_command ${
        typeof call.args.command === 'string' ? call.args.command : ''
      }`;
    default:
      return call.name;
  }
}

export async function runWebsiteAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error('Describe the website to build first.');
  }

  const ai =
    options.ai ??
    new GoogleGenAI({
      apiKey: options.apiKey,
    });

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: `Build this website: ${prompt}`,
        },
      ],
    },
  ];
  const changedFiles = new Set<string>();
  const maxTurns = options.maxTurns ?? DEFAULT_AGENT_MAX_TURNS;
  let serverStartRequested = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    throwIfAborted(options.abortSignal);
    if (shouldNudgeToFinish(turn, maxTurns)) {
      contents.push({
        role: 'user',
        parts: [
          {
            text:
              'You are near the tool turn budget. If index.html and related assets are present and the server has been started, stop calling tools and return the final summary. Only call tools for a critical missing file or broken behavior.',
          },
        ],
      });
    }

    emit(options, {
      type: 'model',
      message: `Calling ${MODEL_ID}, turn ${turn}`,
    });

    const response = await withAbortableTurn(
      (abortSignal) =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
            temperature: 0.35,
            abortSignal,
            httpOptions: {
              timeout: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
            },
          },
        }),
      options,
    );

    const modelContent = responseContent(response);
    if (modelContent) {
      contents.push(modelContent);
    }

    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      const finalText = responseText(response) || 'Website generation finished.';
      emit(options, { type: 'done', message: finalText });
      return { finalText, changedFiles: Array.from(changedFiles).sort() };
    }

    const functionResponses: Content[] = [];
    let serverStartError: string | null = null;
    for (const call of calls) {
      throwIfAborted(options.abortSignal);
      const result = await executeToolCall(options.backend, call);
      result.changedFiles?.forEach((file) => changedFiles.add(file));
      if (isServerStartCall(call)) {
        if (result.error) {
          serverStartError = result.error;
        } else {
          serverStartRequested = true;
        }
      }
      emit(options, {
        type: result.error ? 'error' : 'tool',
        message: result.error
          ? `${call.name} failed: ${result.error}`
          : result.display,
      });
      functionResponses.push(buildToolResponseContent(call, result));
    }

    contents.push(...functionResponses);

    if (serverStartRequested && changedFiles.size > 0) {
      const finalText =
        'Website files were created and the VM web server was started.';
      emit(options, { type: 'done', message: finalText });
      return {
        finalText,
        changedFiles: Array.from(changedFiles).sort(),
      };
    }

    if (serverStartError) {
      throw new Error(`Server start failed: ${serverStartError}`);
    }
  }

  if (changedFiles.size > 0) {
    const finalText = serverStartRequested
      ? 'Reached the tool turn budget after creating files and starting the server. Serving the latest generated version.'
      : 'Reached the tool turn budget after creating files. Serving the latest generated version.';
    emit(options, { type: 'done', message: finalText });
    return {
      finalText,
      changedFiles: Array.from(changedFiles).sort(),
      reachedTurnBudget: true,
    };
  }

  throw new Error(`Model did not produce files after ${maxTurns} turns.`);
}
