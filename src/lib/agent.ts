import { GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentResponse } from '@google/genai';
import { MODEL_ID, SERVER_COMMAND, SITE_ROOT } from './constants';
import { TOOL_DECLARATIONS } from './toolSchemas';
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
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  finalText: string;
  changedFiles: string[];
}

const SYSTEM_PROMPT = `
You are a website-building agent running inside a browser-hosted Linux VM.

Rules:
- Use only the provided tools to inspect and write files.
- All website files must live under ${SITE_ROOT}.
- Build a static website only: index.html, style.css, and optional script.js.
- Always create ${SITE_ROOT}/index.html.
- Write complete file contents. Never use placeholders or omitted sections.
- Do not call any model other than ${MODEL_ID}.
- When the site files are ready, you may start the server with: ${SERVER_COMMAND}
- Keep the result simple and runnable without npm install or build steps.
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
  const maxTurns = options.maxTurns ?? 8;

  for (let turn = 1; turn <= maxTurns; turn++) {
    emit(options, {
      type: 'model',
      message: `Calling ${MODEL_ID}, turn ${turn}`,
    });

    const response = await ai.models.generateContent({
      model: MODEL_ID,
      contents,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        temperature: 0.35,
      },
    });

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
    for (const call of calls) {
      emit(options, {
        type: 'tool',
        message: `${call.name} ${JSON.stringify(call.args)}`,
      });
      const result = await executeToolCall(options.backend, call);
      result.changedFiles?.forEach((file) => changedFiles.add(file));
      emit(options, {
        type: result.error ? 'error' : 'tool',
        message: result.error
          ? `${call.name} failed: ${result.error}`
          : result.display,
      });
      functionResponses.push(buildToolResponseContent(call, result));
    }

    contents.push(...functionResponses);
  }

  throw new Error(`Model did not finish after ${maxTurns} turns.`);
}
