import { GoogleGenAI } from '@google/genai';
import { MODEL_ID, SERVER_COMMAND, SITE_ROOT } from './constants';
import { SHELL_TOOL_NAME, TOOL_DECLARATIONS } from './toolSchemas';
import {
  executeToolCall,
  type ToolCall,
  type ToolExecutionResult,
  type VmFileBackend,
} from './tools';

type GenAiLike = {
  interactions: {
    create(
      params: unknown,
      options?: unknown,
    ): Promise<InteractionResponse>;
  };
};

type InteractionStep = {
  type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type InteractionResponse = {
  id: string;
  status?: string;
  steps?: InteractionStep[];
  output_text?: string;
  errors?: unknown[];
};

type InteractionFunctionResult = {
  type: 'function_result';
  call_id: string;
  name: string;
  result: Array<{ type: 'text'; text: string }>;
  is_error?: boolean;
};

export interface AgentEvent {
  type: 'model' | 'tool' | 'status' | 'error' | 'done';
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
  modelRetryBaseDelayMs?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  finalText: string;
  changedFiles: string[];
  reachedTurnBudget?: boolean;
}

export const DEFAULT_AGENT_MAX_TURNS = 40;
// Gemini 3.7 Flash Interactions can legitimately take a little over a minute
// under load, especially after a function result. Leave enough headroom to
// avoid manufacturing retries while still bounding every request.
const DEFAULT_TURN_TIMEOUT_MS = 90_000;
const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 2_000;
const DEFAULT_MODEL_RETRY_MAX_DELAY_MS = 15_000;
const MODEL_REQUEST_MAX_RETRIES = 8;

const SYSTEM_PROMPT = `
You are a website-building agent running inside a browser-hosted Linux VM.

Rules:
- Use only the provided tools to inspect and write files.
- All website files must live under ${SITE_ROOT}.
- Build a static website only: index.html, style.css, and optional script.js.
- Always create ${SITE_ROOT}/index.html.
- Write complete file contents. Never use placeholders or omitted sections.
- Do not call any model other than ${MODEL_ID}.
- Request server startup with ${SERVER_COMMAND} exactly once, only after index.html and any referenced CSS/JS files exist. The host app defers the actual launch until Tailnet is connected.
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

function extractFunctionCalls(response: InteractionResponse): ToolCall[] {
  return (response.steps ?? [])
    .filter(
      (step): step is Required<
        Pick<InteractionStep, 'id' | 'name' | 'arguments'>
      > &
        InteractionStep =>
        step.type === 'function_call' &&
        typeof step.id === 'string' &&
        typeof step.name === 'string' &&
        !!step.arguments &&
        typeof step.arguments === 'object',
    )
    .map((step) => ({
      id: step.id,
      name: step.name,
      args: step.arguments,
    }));
}

function buildToolResult(
  call: ToolCall,
  result: ToolExecutionResult,
): InteractionFunctionResult {
  return {
    type: 'function_result',
    call_id: call.id ?? `${call.name}-${crypto.randomUUID()}`,
    name: call.name,
    result: [
      {
        type: 'text',
        text: result.error
          ? `Error: ${result.error}\n${result.llmContent}`
          : result.llmContent,
      },
    ],
    ...(result.error ? { is_error: true } : {}),
  };
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

function isTransientModelError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return false;
  }

  const details =
    error && typeof error === 'object'
      ? (error as { code?: unknown; status?: unknown; message?: unknown })
      : {};
  const status = details.status ?? details.code;
  if (
    status === 408 ||
    status === '408' ||
    status === 429 ||
    status === '429' ||
    (typeof status === 'number' && status >= 500 && status <= 599) ||
    (typeof status === 'string' && /^5\d\d$/.test(status)) ||
    status === 'UNAVAILABLE'
  ) {
    return true;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof details.message === 'string'
        ? details.message
        : String(error);
  return (
    /(?:"code"\s*:\s*(?:408|429|5\d\d)|\b(?:408|429|5\d\d)\b)/i.test(
      message,
    ) ||
    /\b(?:UNAVAILABLE|RESOURCE_EXHAUSTED)\b/i.test(message) ||
    /high demand|service temporarily unavailable|network error|fetch failed|load failed/i.test(
      message,
    )
  );
}

async function waitForModelRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      globalThis.clearTimeout(timeout);
      const error = new Error('Website generation was stopped.');
      error.name = 'AbortError';
      reject(error);
    };
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function withAbortableTurn<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: AgentRunOptions,
): Promise<T> {
  throwIfAborted(options.abortSignal);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timeout = globalThis.setTimeout(
    () => {
      timedOut = true;
      controller.abort();
    },
    options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
  );
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut && !options.abortSignal?.aborted) {
      const timeoutError = new Error(
        `Gemini request timed out after ${
          options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
        }ms.`,
      ) as Error & { status?: number };
      timeoutError.name = 'TimeoutError';
      timeoutError.status = 408;
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    options.abortSignal?.removeEventListener('abort', abort);
  }
}

async function createInteraction(
  ai: GenAiLike,
  params: Record<string, unknown>,
  options: AgentRunOptions,
): Promise<InteractionResponse> {
  for (let retry = 0; retry <= MODEL_REQUEST_MAX_RETRIES; retry++) {
    try {
      return await withAbortableTurn(
        (abortSignal) =>
          ai.interactions.create(params, {
            signal: abortSignal,
            timeout: options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
            // Keep retry ownership here so every request follows SparkRun's
            // visible, abortable eight-retry policy instead of stacking hidden
            // SDK retries underneath it.
            maxRetries: 0,
          }),
        options,
      );
    } catch (error) {
      if (
        !isTransientModelError(error) ||
        retry === MODEL_REQUEST_MAX_RETRIES
      ) {
        throw error;
      }

      const delayMs = Math.min(
        (options.modelRetryBaseDelayMs ?? DEFAULT_MODEL_RETRY_BASE_DELAY_MS) *
          2 ** retry,
        DEFAULT_MODEL_RETRY_MAX_DELAY_MS,
      );
      emit(options, {
        type: 'status',
        message: `Gemini is temporarily unavailable. Retrying in ${(
          delayMs / 1_000
        ).toLocaleString()}s (attempt ${retry + 2}/${MODEL_REQUEST_MAX_RETRIES + 1}).`,
      });
      await waitForModelRetry(delayMs, options.abortSignal);
    }
  }

  throw new Error('Gemini request failed after retrying.');
}

const INTERACTION_TOOLS = TOOL_DECLARATIONS.map((tool) => ({
  type: 'function' as const,
  name: tool.name,
  description: tool.description,
  parameters: tool.parametersJsonSchema,
}));

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

  const changedFiles = new Set<string>();
  const maxTurns = options.maxTurns ?? DEFAULT_AGENT_MAX_TURNS;
  let serverStartRequested = false;
  let previousInteractionId: string | undefined;
  let nextInput: string | InteractionFunctionResult[] =
    `Build this website: ${prompt}`;

  for (let turn = 1; turn <= maxTurns; turn++) {
    throwIfAborted(options.abortSignal);

    emit(options, {
      type: 'model',
      message: `Calling ${MODEL_ID}, turn ${turn}`,
    });

    const response = await createInteraction(
      ai,
      {
        model: MODEL_ID,
        input: nextInput,
        ...(previousInteractionId
          ? { previous_interaction_id: previousInteractionId }
          : {}),
        // Interactions settings are scoped to a single turn. Re-send them on
        // continuations so Gemini can make another tool call after receiving
        // function results from the previous interaction.
        system_instruction: SYSTEM_PROMPT,
        generation_config: { temperature: 0.35 },
        tools: INTERACTION_TOOLS,
      },
      options,
    );
    previousInteractionId = response.id;

    if (response.status === 'failed') {
      throw new Error(
        `Gemini interaction failed: ${JSON.stringify(response.errors ?? [])}`,
      );
    }

    const calls = extractFunctionCalls(response);
    if (calls.length === 0) {
      const finalText =
        response.output_text?.trim() || 'Website generation finished.';
      emit(options, { type: 'done', message: finalText });
      return { finalText, changedFiles: Array.from(changedFiles).sort() };
    }

    const functionResults: InteractionFunctionResult[] = [];
    for (const call of calls) {
      throwIfAborted(options.abortSignal);
      const serverStartCall = isServerStartCall(call);
      const result: ToolExecutionResult = serverStartCall
        ? {
            llmContent:
              'Server startup accepted. The host app will activate Tailnet and launch the server after website generation finishes.',
            display: 'Deferred server start until Tailnet is ready',
          }
        : await executeToolCall(options.backend, call);
      result.changedFiles?.forEach((file) => changedFiles.add(file));
      if (serverStartCall) {
        serverStartRequested = true;
      }
      emit(options, {
        type: result.error ? 'error' : 'tool',
        message: result.error
          ? `${call.name} failed: ${result.error}`
          : result.display,
      });
      functionResults.push(buildToolResult(call, result));
    }
    nextInput = functionResults;

    if (serverStartRequested && changedFiles.size > 0) {
      const finalText =
        'Website files were created. The host app is starting the VM web server.';
      emit(options, { type: 'done', message: finalText });
      return {
        finalText,
        changedFiles: Array.from(changedFiles).sort(),
      };
    }

    if (shouldNudgeToFinish(turn + 1, maxTurns)) {
      emit(options, {
        type: 'status',
        message:
          'Gemini is near the tool turn budget; serving the latest usable files if it does not finish soon.',
      });
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
