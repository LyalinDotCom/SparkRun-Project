import { SERVER_COMMAND, SITE_ROOT } from './constants';
import {
  EDIT_TOOL_NAME,
  LIST_DIRECTORY_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
} from './toolSchemas';

export type ToolName =
  | typeof READ_FILE_TOOL_NAME
  | typeof WRITE_FILE_TOOL_NAME
  | typeof EDIT_TOOL_NAME
  | typeof LIST_DIRECTORY_TOOL_NAME
  | typeof SHELL_TOOL_NAME;

export interface ToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface DirectoryEntry {
  path: string;
  type: 'file' | 'directory';
  sizeBytes?: number;
}

export interface VmCommandResult {
  status: number;
  output: string;
  background?: boolean;
}

export interface VmFileBackend {
  readText(relativePath: string): Promise<string>;
  writeText(relativePath: string, content: string): Promise<void>;
  listDirectory(relativePath: string): Promise<DirectoryEntry[]>;
  runCommand(
    command: string,
    options: {
      cwd: string;
      background?: boolean;
      stream?: boolean;
      timeoutMs?: number;
    },
  ): Promise<VmCommandResult>;
}

export interface ToolExecutionResult {
  llmContent: string;
  display: string;
  changedFiles?: string[];
  error?: string;
}

const PLACEHOLDER_PATTERNS = [
  /\.\.\.\s*rest\b/i,
  /\brest of (the )?(code|file|styles|script|markup)\b/i,
  /\/\/\s*\.\.\./,
  /\/\*\s*\.\.\.\s*\*\//,
  /<\!--\s*\.\.\.\s*-->/,
];

export function normalizeSitePath(rawPath: string | undefined): string {
  const raw = (rawPath ?? '').trim().replace(/\\/g, '/');
  if (!raw) {
    return '';
  }

  let path = raw;
  if (path === SITE_ROOT) {
    return '';
  }
  if (path.startsWith(`${SITE_ROOT}/`)) {
    path = path.slice(SITE_ROOT.length + 1);
  } else if (path.startsWith('/workspace/')) {
    throw new Error(`Path is outside ${SITE_ROOT}: ${rawPath}`);
  } else {
    path = path.replace(/^\/+/, '');
  }

  const segments: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      throw new Error(`Path cannot escape ${SITE_ROOT}: ${rawPath}`);
    }
    if (part.includes('\0')) {
      throw new Error('Path cannot contain null bytes.');
    }
    segments.push(part);
  }
  return segments.join('/');
}

export function toVmPath(relativePath: string): string {
  return relativePath ? `${SITE_ROOT}/${relativePath}` : SITE_ROOT;
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing or invalid "${name}".`);
  }
  return value;
}

function expectOptionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid "${name}".`);
  }
  return value;
}

function rejectOmissions(content: string, fieldName: string): void {
  if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error(
      `"${fieldName}" contains an omission placeholder. Provide exact complete text.`,
    );
  }
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return content.split(needle).length - 1;
}

function restoreTrailingNewline(original: string, next: string): string {
  if (original.endsWith('\n') && !next.endsWith('\n')) {
    return `${next}\n`;
  }
  if (!original.endsWith('\n') && next.endsWith('\n')) {
    return next.replace(/\n$/, '');
  }
  return next;
}

function applyIndentedReplacement(
  current: string,
  oldString: string,
  newString: string,
): { next: string; occurrences: number; strategy: 'flexible' } | null {
  const oldLines = oldString.replace(/\r\n/g, '\n').split('\n');
  const newLines = newString.replace(/\r\n/g, '\n').split('\n');
  if (oldLines.length < 2) {
    return null;
  }

  const currentLines = current.match(/.*(?:\n|$)/g)?.slice(0, -1) ?? [];
  const strippedNeedle = oldLines.map((line) => line.trim());
  let occurrences = 0;
  let index = 0;

  while (index <= currentLines.length - strippedNeedle.length) {
    const window = currentLines.slice(index, index + strippedNeedle.length);
    const strippedWindow = window.map((line) => line.trim());
    const matches = strippedWindow.every(
      (line, lineIndex) => line === strippedNeedle[lineIndex],
    );

    if (!matches) {
      index++;
      continue;
    }

    occurrences++;
    const indentation = window[0].match(/^([ \t]*)/)?.[1] ?? '';
    const replacement = newLines
      .map((line, lineIndex) => {
        if (line.trim() === '') {
          return line;
        }
        return `${indentation}${line}`;
      })
      .join('\n')
      .replace(/\n?$/, '\n');
    currentLines.splice(index, oldLines.length, replacement);
    index += newLines.length;
  }

  if (occurrences === 0) {
    return null;
  }

  return {
    next: restoreTrailingNewline(current, currentLines.join('')),
    occurrences,
    strategy: 'flexible',
  };
}

function replaceContent(
  current: string,
  oldString: string,
  newString: string,
): { next: string; occurrences: number; strategy: 'exact' | 'flexible' } {
  const normalizedCurrent = current.replace(/\r\n/g, '\n');
  const normalizedOld = oldString.replace(/\r\n/g, '\n');
  const normalizedNew = newString.replace(/\r\n/g, '\n');
  const exactOccurrences = countOccurrences(normalizedCurrent, normalizedOld);
  if (exactOccurrences > 0) {
    return {
      next: restoreTrailingNewline(
        current,
        normalizedCurrent.split(normalizedOld).join(normalizedNew),
      ),
      occurrences: exactOccurrences,
      strategy: 'exact',
    };
  }

  const flexible = applyIndentedReplacement(
    normalizedCurrent,
    normalizedOld,
    normalizedNew,
  );
  if (flexible) {
    return flexible;
  }

  return {
    next: current,
    occurrences: 0,
    strategy: 'exact',
  };
}

function formatDirectory(entries: DirectoryEntry[]): string {
  if (entries.length === 0) {
    return '(empty)';
  }
  return entries
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `${entry.type === 'directory' ? 'dir' : 'file'} ${entry.path}`)
    .join('\n');
}

function readLineRange(
  content: string,
  startLine?: number,
  endLine?: number,
): string {
  if (startLine !== undefined && startLine < 1) {
    throw new Error('start_line must be at least 1.');
  }
  if (endLine !== undefined && endLine < 1) {
    throw new Error('end_line must be at least 1.');
  }
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    endLine < startLine
  ) {
    throw new Error('end_line must be greater than or equal to start_line.');
  }

  if (startLine === undefined && endLine === undefined) {
    return content;
  }

  const lines = content.split('\n');
  const startIndex = (startLine ?? 1) - 1;
  const endIndex = endLine ?? lines.length;
  return lines.slice(startIndex, endIndex).join('\n');
}

function normalizeShellCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function shellCommandForExecution(command: string): string {
  const trimmed = command.trim();
  if (/^python3 - <<'PY'\n[\s\S]*\nPY$/.test(trimmed)) {
    return trimmed;
  }
  return normalizeShellCommand(command);
}

const EXACT_SHELL_COMMANDS = new Set([
  SERVER_COMMAND,
  'pwd',
  'ls',
  'ls .',
  `ls ${SITE_ROOT}`,
  'ls -la',
  'ls -la .',
  `ls -la ${SITE_ROOT}`,
  'ls -R',
  'ls -R .',
  `ls -R ${SITE_ROOT}`,
  'find . -maxdepth 2 -type f',
  'find . -maxdepth 3 -type f',
  `find ${SITE_ROOT} -maxdepth 2 -type f`,
  `find ${SITE_ROOT} -maxdepth 3 -type f`,
  'cat .server.log',
  'cat /workspace/site/.server.log',
  'tail .server.log',
  'tail -40 .server.log',
  'tail -40 /workspace/site/.server.log',
  'cat .server.pid',
  'cat /workspace/site/.server.pid',
  'ps',
  'ps aux',
  'ps -ef',
  'netstat -ltn',
  'ss -ltn',
]);

function isAllowedShellCommand(command: string): boolean {
  const normalized = normalizeShellCommand(command);
  if (EXACT_SHELL_COMMANDS.has(normalized)) {
    return true;
  }
  return /^python3 - <<'PY'\n[\s\S]*\nPY$/.test(command.trim());
}

export async function executeToolCall(
  backend: VmFileBackend,
  call: ToolCall,
): Promise<ToolExecutionResult> {
  try {
    switch (call.name) {
      case READ_FILE_TOOL_NAME: {
        const relativePath = normalizeSitePath(
          expectString(call.args.file_path, 'file_path'),
        );
        if (!relativePath) {
          throw new Error('read_file requires a file path.');
        }
        const startLine = expectOptionalNumber(call.args.start_line, 'start_line');
        const endLine = expectOptionalNumber(call.args.end_line, 'end_line');
        const content = await backend.readText(relativePath);
        const ranged = readLineRange(content, startLine, endLine);
        return {
          llmContent: `Read ${toVmPath(relativePath)}:\n${ranged}`,
          display: `Read ${toVmPath(relativePath)}`,
        };
      }

      case WRITE_FILE_TOOL_NAME: {
        const relativePath = normalizeSitePath(
          expectString(call.args.file_path, 'file_path'),
        );
        if (!relativePath) {
          throw new Error('write_file requires a file path.');
        }
        const content = expectString(call.args.content, 'content');
        rejectOmissions(content, 'content');
        await backend.writeText(relativePath, content);
        return {
          llmContent: `Wrote ${content.split('\n').length} lines to ${toVmPath(
            relativePath,
          )}.`,
          display: `Wrote ${toVmPath(relativePath)}`,
          changedFiles: [relativePath],
        };
      }

      case EDIT_TOOL_NAME: {
        const relativePath = normalizeSitePath(
          expectString(call.args.file_path, 'file_path'),
        );
        if (!relativePath) {
          throw new Error('replace requires a file path.');
        }
        const oldString = expectString(call.args.old_string, 'old_string');
        const newString = expectString(call.args.new_string, 'new_string');
        const allowMultiple = call.args.allow_multiple === true;
        rejectOmissions(newString, 'new_string');

        let current = '';
        let exists = true;
        try {
          current = await backend.readText(relativePath);
        } catch {
          exists = false;
        }

        if (!oldString) {
          if (exists) {
            throw new Error(
              'old_string is empty, but the target file already exists.',
            );
          }
          await backend.writeText(relativePath, newString);
          return {
            llmContent: `Created ${toVmPath(relativePath)} by replace.`,
            display: `Created ${toVmPath(relativePath)}`,
            changedFiles: [relativePath],
          };
        }

        if (!exists) {
          throw new Error('File not found. Use write_file to create it.');
        }

        const replacement = replaceContent(current, oldString, newString);
        const occurrences = replacement.occurrences;
        if (occurrences === 0) {
          throw new Error('Could not find old_string in the target file.');
        }
        if (!allowMultiple && occurrences !== 1) {
          throw new Error(
            `old_string matched ${occurrences} times. Set allow_multiple to true or provide a more specific old_string.`,
          );
        }

        await backend.writeText(relativePath, replacement.next);
        return {
          llmContent: `Replaced ${allowMultiple ? occurrences : 1} occurrence${
            occurrences === 1 ? '' : 's'
          } in ${toVmPath(relativePath)} using ${replacement.strategy} matching.`,
          display: `Edited ${toVmPath(relativePath)}`,
          changedFiles: [relativePath],
        };
      }

      case LIST_DIRECTORY_TOOL_NAME: {
        const relativePath = normalizeSitePath(
          typeof call.args.dir_path === 'string' ? call.args.dir_path : '',
        );
        const entries = await backend.listDirectory(relativePath);
        const listing = formatDirectory(entries);
        return {
          llmContent: `Listing ${toVmPath(relativePath)}:\n${listing}`,
          display: `Listed ${toVmPath(relativePath)}`,
        };
      }

      case SHELL_TOOL_NAME: {
        const command = expectString(call.args.command, 'command');
        if (!isAllowedShellCommand(command)) {
          throw new Error(
            `Command is not allowed in this prototype: ${command}`,
          );
        }
        const relativeCwd = normalizeSitePath(
          typeof call.args.dir_path === 'string' ? call.args.dir_path : '',
        );
        const normalizedCommand = normalizeShellCommand(command);
        const commandToRun = shellCommandForExecution(command);
        const result = await backend.runCommand(commandToRun, {
          cwd: toVmPath(relativeCwd),
          background: normalizedCommand === SERVER_COMMAND,
        });
        if (result.status !== 0) {
          throw new Error(
            `Command failed with status ${result.status}: ${result.output}`,
          );
        }
        return {
          llmContent: `Command completed: ${commandToRun}\n${result.output}`,
          display: result.background
            ? `Started ${normalizedCommand}`
            : `Ran ${normalizedCommand}`,
        };
      }

      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      llmContent: `Tool ${call.name} failed: ${message}`,
      display: `Failed ${call.name}`,
      error: message,
    };
  }
}

export class MemoryVmFileBackend implements VmFileBackend {
  private readonly files = new Map<string, string>();
  readonly commands: Array<{
    command: string;
    cwd: string;
    background?: boolean;
    stream?: boolean;
    timeoutMs?: number;
  }> = [];

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.files.set(normalizeSitePath(path), content);
    }
  }

  async readText(relativePath: string): Promise<string> {
    const normalized = normalizeSitePath(relativePath);
    const content = this.files.get(normalized);
    if (content === undefined) {
      throw new Error(`File not found: ${toVmPath(normalized)}`);
    }
    return content;
  }

  async writeText(relativePath: string, content: string): Promise<void> {
    this.files.set(normalizeSitePath(relativePath), content);
  }

  async listDirectory(relativePath: string): Promise<DirectoryEntry[]> {
    const normalized = normalizeSitePath(relativePath);
    const prefix = normalized ? `${normalized}/` : '';
    const seen = new Map<string, DirectoryEntry>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) {
        continue;
      }
      const rest = path.slice(prefix.length);
      if (!rest) {
        continue;
      }
      const [first, ...remaining] = rest.split('/');
      const entryPath = prefix + first;
      const type = remaining.length > 0 ? 'directory' : 'file';
      const existing = seen.get(entryPath);
      if (!existing || existing.type !== 'directory') {
        seen.set(entryPath, { path: entryPath, type });
      }
    }
    return Array.from(seen.values());
  }

  async runCommand(
    command: string,
    options: {
      cwd: string;
      background?: boolean;
      stream?: boolean;
      timeoutMs?: number;
    },
  ): Promise<VmCommandResult> {
    this.commands.push({ command, ...options });
    return {
      status: 0,
      output: options.background ? 'started in background' : 'ok',
      background: options.background,
    };
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files.entries());
  }
}
