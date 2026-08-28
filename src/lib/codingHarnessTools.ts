import type {
  CodingRuntime,
  CodingRuntimeDirectoryEntry,
} from './codingHarness';

export const CODING_READ_FILE_TOOL = 'read_file';
export const CODING_WRITE_FILE_TOOL = 'write_file';
export const CODING_REPLACE_TOOL = 'replace';
export const CODING_LIST_DIRECTORY_TOOL = 'list_directory';
export const CODING_RUN_COMMAND_TOOL = 'run_command';
export const CODING_START_PREVIEW_TOOL = 'start_preview';

export interface CodingToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface CodingToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CodingToolExecutionResult {
  content: string;
  display: string;
  isError: boolean;
  changedFiles: string[];
}

const DEFAULT_COMMAND_TIMEOUT_MS = 90_000;
const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;
const MAX_TOOL_OUTPUT_CHARS = 60_000;

export const CODING_TOOL_DECLARATIONS: CodingToolDeclaration[] = [
  {
    name: CODING_READ_FILE_TOOL,
    description:
      'Read a UTF-8 text file in the durable workspace. Use line ranges for large files. Secret-bearing files such as .env and private keys cannot be read.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path inside it.',
        },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
      },
      required: ['file_path'],
    },
  },
  {
    name: CODING_WRITE_FILE_TOOL,
    description:
      'Write the complete UTF-8 contents of a file in the durable workspace, creating parent directories when the runtime supports it.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path inside it.',
        },
        content: { type: 'string' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: CODING_REPLACE_TOOL,
    description:
      'Replace one exact string in a workspace text file. Set allow_multiple only when every exact match should change.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description:
            'Path relative to the workspace root, or an absolute path inside it.',
        },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        allow_multiple: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: CODING_LIST_DIRECTORY_TOOL,
    description:
      'List the immediate contents of a directory in the durable workspace.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        dir_path: {
          type: 'string',
          description:
            'Directory relative to the workspace root. Defaults to the root.',
        },
      },
    },
  },
  {
    name: CODING_RUN_COMMAND_TOOL,
    description:
      'Run a shell command inside the isolated Linux VM. The command may use the full VM filesystem and installed toolchain; it cannot access the host computer. The default working directory is the durable workspace.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: {
          type: 'string',
          description:
            'Optional absolute VM path or path relative to the workspace root.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 1_000,
          maximum: MAX_COMMAND_TIMEOUT_MS,
        },
      },
      required: ['command'],
    },
  },
  {
    name: CODING_START_PREVIEW_TOOL,
    description:
      'Start or replace the project web server under SparkRun supervision and expose it on the private preview network. Use this for web apps instead of a detached run_command. The command must bind 0.0.0.0 on the exact port supplied.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Foreground server command configured to bind 0.0.0.0 on the supplied port.',
        },
        port: {
          type: 'integer',
          minimum: 1024,
          maximum: 65535,
        },
        cwd: {
          type: 'string',
          description:
            'Optional absolute VM path or path relative to the workspace root.',
        },
      },
      required: ['command', 'port'],
    },
  },
];

function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Missing or invalid "${name}".`);
  }
  return value;
}

function expectOptionalLine(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`"${name}" must be a positive integer.`);
  }
  return Number(value);
}

function normalizeAbsolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    if (part.includes('\0')) throw new Error('Paths cannot contain null bytes.');
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export function normalizeCodingWorkspacePath(
  rawPath: string | undefined,
  workspaceRoot: string,
): string {
  const root = normalizeAbsolutePath(workspaceRoot);
  const raw = (rawPath ?? '').trim();
  if (raw.includes('\0')) throw new Error('Paths cannot contain null bytes.');

  if (raw.startsWith('/')) {
    const absolute = normalizeAbsolutePath(raw);
    if (absolute === root) return '';
    const rootPrefix = root === '/' ? '/' : `${root}/`;
    if (!absolute.startsWith(rootPrefix)) {
      throw new Error(`File path is outside the workspace ${root}: ${rawPath}`);
    }
    return absolute.slice(rootPrefix.length);
  }

  const parts: string[] = [];
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) {
        throw new Error(`File path cannot escape the workspace: ${rawPath}`);
      }
      parts.pop();
      continue;
    }
    if (part.includes('\0')) throw new Error('Paths cannot contain null bytes.');
    parts.push(part);
  }
  return parts.join('/');
}

export function resolveCodingVmCwd(
  rawCwd: string | undefined,
  workspaceRoot: string,
): string {
  const root = normalizeAbsolutePath(workspaceRoot);
  const raw = rawCwd?.trim();
  if (!raw) return root;
  if (raw.includes('\0')) throw new Error('Working directory cannot contain null bytes.');
  return normalizeAbsolutePath(raw.startsWith('/') ? raw : `${root}/${raw}`);
}

function absoluteWorkspacePath(runtime: CodingRuntime, relativePath: string): string {
  const root = normalizeAbsolutePath(runtime.workspaceRoot);
  return relativePath ? `${root}/${relativePath}` : root;
}

function isSensitiveFile(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
  const segments = normalizedPath.split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const parent = segments.at(-2) ?? '';
  const isConventionalPrivateSshKey =
    /^id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk|xmss)$/.test(name);
  const isPublicSshFile =
    name.endsWith('.pub') ||
    name === 'authorized_keys' ||
    name === 'known_hosts' ||
    name === 'known_hosts.old' ||
    name === 'config';
  return (
    name === '.env' ||
    (name.startsWith('.env.') && name !== '.env.example') ||
    name === '.envrc' ||
    name === '.npmrc' ||
    name === '.netrc' ||
    name === '.pypirc' ||
    name === '.git-credentials' ||
    (parent === '.aws' && name === 'credentials') ||
    (segments.includes('.config') &&
      parent === 'gh' &&
      (name === 'hosts.yml' || name === 'hosts.yaml')) ||
    (parent === '.docker' && name === 'config.json') ||
    (segments.includes('.ssh') && !isPublicSshFile) ||
    isConventionalPrivateSshKey ||
    name === 'credentials.json' ||
    name === 'service-account.json' ||
    name.endsWith('.pem') ||
    name.endsWith('.p12') ||
    name.endsWith('.pfx') ||
    name.endsWith('.key')
  );
}

const SENSITIVE_ASSIGNMENT_COMPONENTS = new Set([
  'KEY',
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASS',
  'CRED',
  'CREDS',
  'CREDENTIAL',
  'CREDENTIALS',
]);

function isSensitiveAssignmentName(name: string): boolean {
  const upper = name.toUpperCase();
  const components = upper.split(/[_-]+/).filter(Boolean);
  if (
    components.some((component) =>
      SENSITIVE_ASSIGNMENT_COMPONENTS.has(component),
    )
  ) {
    return true;
  }

  const compact = components.join('');
  return (
    /(?:SECRET|TOKEN|PASSWORD|CREDENTIALS?)$/.test(compact) ||
    /(?:API|AUTH|ACCESS|PRIVATE|SECRET|SIGNING|ENCRYPTION)KEY$/.test(
      compact,
    )
  );
}

function formatRedactedAssignment(
  prefix: string,
  marker: string,
  doubleQuotedValue: string | undefined,
  singleQuotedValue: string | undefined,
): string {
  if (doubleQuotedValue !== undefined) return `${prefix}"${marker}"`;
  if (singleQuotedValue !== undefined) return `${prefix}'${marker}'`;
  return `${prefix}${marker}`;
}

function redactNamedSecretAssignments(value: string): string {
  const redactIfSensitive = (
    match: string,
    prefix: string,
    name: string,
    doubleQuotedValue: string | undefined,
    singleQuotedValue: string | undefined,
  ): string => {
    if (match.includes('[REDACTED')) return match;
    return isSensitiveAssignmentName(name)
      ? formatRedactedAssignment(
          prefix,
          '[REDACTED]',
          doubleQuotedValue,
          singleQuotedValue,
        )
      : match;
  };

  return value
    .replace(
      /((?:^|\n)[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=[ \t]*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n]*))/g,
      redactIfSensitive,
    )
    .replace(
      /(["']?\b([A-Za-z_][A-Za-z0-9_-]*)\b["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,{}"'\r\n]+))/g,
      redactIfSensitive,
    );
}

/** Redact common API and auth-key forms before model output is persisted. */
export function redactCodingSecrets(value: string): string {
  const redacted = value
    .replace(
      /-----BEGIN ([^-\r\n]*(?:PRIVATE|SECRET)[^-\r\n]* KEY)-----[\s\S]*?-----END \1-----/gi,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(
      /((?:^|\n)[ \t]*[^\r\n=]*?_authToken\s*=\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\r\n]+))/gi,
      (_match, prefix, doubleQuotedValue, singleQuotedValue) =>
        formatRedactedAssignment(
          prefix,
          '[REDACTED_NPM_TOKEN]',
          doubleQuotedValue,
          singleQuotedValue,
        ),
    )
    .replace(
      /((?:["']?_authToken["']?)\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}\r\n]+))/gi,
      (_match, prefix, doubleQuotedValue, singleQuotedValue) =>
        formatRedactedAssignment(
          prefix,
          '[REDACTED_NPM_TOKEN]',
          doubleQuotedValue,
          singleQuotedValue,
        ),
    )
    .replace(/\bnpm_[0-9A-Za-z_-]{8,}\b/g, '[REDACTED_NPM_TOKEN]')
    .replace(/AIza[0-9A-Za-z_-]{24,}/g, '[REDACTED_GOOGLE_KEY]')
    .replace(
      /(^|[^0-9A-Za-z_.-])(AQ\.[0-9A-Za-z_.-]{17,197})(?![0-9A-Za-z_.-])/g,
      '$1[REDACTED_GOOGLE_KEY]',
    )
    .replace(
      /(^|[^0-9A-Za-z_.-])(ya29\.[0-9A-Za-z_.-]{10,})(?![0-9A-Za-z_.-])/g,
      '$1[REDACTED_GOOGLE_OAUTH_TOKEN]',
    )
    .replace(/tskey-[0-9A-Za-z_-]+/gi, '[REDACTED_TAILSCALE_KEY]')
    .replace(
      /\b(?:gh[pousr]_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{20,})\b/g,
      '[REDACTED_GITHUB_TOKEN]',
    )
    .replace(
      /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
      '[REDACTED_AWS_ACCESS_KEY_ID]',
    )
    .replace(
      /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
      '[REDACTED_STRIPE_KEY]',
    )
    .replace(/\bsk-[0-9A-Za-z_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
      '$1[REDACTED_CREDENTIALS]@',
    )
    .replace(
      /(\b(?:Proxy-)?Authorization["']?\s*:\s*["']?(?:Bearer|Basic)\s+)([^\s,"'\r\n]+)/gi,
      (match, prefix, credential) =>
        String(credential).startsWith('[REDACTED')
          ? match
          : `${prefix}[REDACTED_AUTHORIZATION]`,
    )
    .replace(
      /(["']?\b[A-Za-z0-9_]*(?:DATABASE_URL|DATABASE_URI|DB_URL|REDIS_URL|MONGO(?:DB)?_URI|AMQP_URL|BROKER_URL|CONNECTION_STRING|DSN)[A-Za-z0-9_]*\b["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}\r\n]+))/gi,
      (_match, prefix, doubleQuotedValue, singleQuotedValue) =>
        formatRedactedAssignment(
          prefix,
          '[REDACTED]',
          doubleQuotedValue,
          singleQuotedValue,
        ),
    );

  return redactNamedSecretAssignments(redacted);
}

function truncateToolOutput(value: string): string {
  const redacted = redactCodingSecrets(value);
  if (redacted.length <= MAX_TOOL_OUTPUT_CHARS) return redacted;
  const side = Math.floor((MAX_TOOL_OUTPUT_CHARS - 160) / 2);
  return `${redacted.slice(0, side)}\n\n[... ${(
    redacted.length - side * 2
  ).toLocaleString()} characters omitted ...]\n\n${redacted.slice(-side)}`;
}

function selectLineRange(
  content: string,
  startLine?: number,
  endLine?: number,
): string {
  if (
    startLine !== undefined &&
    endLine !== undefined &&
    endLine < startLine
  ) {
    throw new Error('"end_line" must be greater than or equal to "start_line".');
  }
  if (startLine === undefined && endLine === undefined) return content;
  const lines = content.split('\n');
  return lines
    .slice((startLine ?? 1) - 1, endLine ?? lines.length)
    .join('\n');
}

function formatDirectory(entries: CodingRuntimeDirectoryEntry[]): string {
  if (entries.length === 0) return '(empty)';
  return [...entries]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => {
      const size = entry.sizeBytes === undefined ? '' : ` ${entry.sizeBytes} bytes`;
      return `${entry.type} ${entry.path}${size}`;
    })
    .join('\n');
}

type ShellClauseSeparator =
  | ';'
  | '\n'
  | '|'
  | '||'
  | '&'
  | '&&'
  | '('
  | ')'
  | null;

type ShellScanEvent =
  | {
      type: 'clause';
      text: string;
      following: ShellClauseSeparator;
    }
  | { type: 'group-start' }
  | { type: 'group-end' };

/**
 * Split obvious shell structure without pretending to be a POSIX shell parser.
 * Quote contents stay opaque. Parentheses become scoped cwd groups so a
 * literal `cd` inside a subshell cannot leak into the following outer clause.
 */
function scanShellStructure(command: string): ShellScanEvent[] {
  const events: ShellScanEvent[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const finish = (following: ShellClauseSeparator) => {
    if (current.trim()) {
      events.push({ type: 'clause', text: current, following });
    }
    current = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (
      character === '$' &&
      command[index + 1] === '(' &&
      command[index + 2] !== '('
    ) {
      const end = findCommandSubstitutionEnd(command, index + 2);
      if (end !== null) {
        current += command.slice(index, end + 1);
        index = end;
        continue;
      }
    }
    if (character === ';' || character === '\n') {
      finish(character);
      continue;
    }
    if (character === '|' || character === '&') {
      const doubled = command[index + 1] === character;
      const separator = doubled
        ? (`${character}${character}` as '||' | '&&')
        : character;
      finish(separator);
      if (doubled) index += 1;
      continue;
    }
    if (character === '(') {
      finish('(');
      events.push({ type: 'group-start' });
      continue;
    }
    if (character === ')') {
      finish(')');
      events.push({ type: 'group-end' });
      continue;
    }
    current += character;
  }
  finish(null);
  return events;
}

function findCommandSubstitutionEnd(
  command: string,
  contentStart: number,
): number | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = contentStart; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

/** Return only command text that the shell obviously executes as substitution. */
function extractCommandSubstitutions(command: string): string[] {
  const fragments: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (character === "'" && quote !== '"') {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (
      character === '$' &&
      command[index + 1] === '(' &&
      command[index + 2] !== '('
    ) {
      const contentStart = index + 2;
      const end = findCommandSubstitutionEnd(command, contentStart);
      if (end !== null) {
        fragments.push(command.slice(contentStart, end));
        index = end;
      }
      continue;
    }
    if (character === '`') {
      let end = index + 1;
      let backtickEscaped = false;
      for (; end < command.length; end += 1) {
        const nestedCharacter = command[end];
        if (backtickEscaped) {
          backtickEscaped = false;
          continue;
        }
        if (nestedCharacter === '\\') {
          backtickEscaped = true;
          continue;
        }
        if (nestedCharacter === '`') break;
      }
      if (end < command.length) {
        fragments.push(command.slice(index + 1, end));
        index = end;
      }
    }
  }

  return fragments;
}

function tokenizeShellClause(clause: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const finish = () => {
    if (started) tokens.push(current);
    current = '';
    started = false;
  };

  for (const character of clause) {
    if (escaped) {
      current += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      finish();
      continue;
    }
    current += character;
    started = true;
  }
  if (escaped) current += '\\';
  finish();
  return tokens;
}

function shellExecutableBasename(token: string | undefined): string {
  return (
    (token ?? '').replace(/\/+$/, '').split('/').at(-1)?.toLowerCase() ?? ''
  );
}

function isShellAssignment(token: string | undefined): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token ?? '');
}

interface ShellInvocation {
  executable: string;
  args: string[];
  cwd: string;
}

function resolveLiteralShellPath(
  rawPath: string | undefined,
  cwd: string,
): string | null {
  if (
    !rawPath ||
    rawPath === '-' ||
    /[$`~*?\[\]{}]/.test(rawPath)
  ) {
    return null;
  }
  return normalizeAbsolutePath(
    rawPath.startsWith('/') ? rawPath : `${cwd}/${rawPath}`,
  );
}

function unwrapShellInvocation(
  tokens: string[],
  cwd: string,
): ShellInvocation | null {
  tokens = [...tokens];
  let invocationCwd = cwd;
  let index = 0;
  while (isShellAssignment(tokens[index])) index += 1;

  // Normalize well-known command wrappers by basename, including absolute
  // paths such as /usr/bin/env and /bin/command.
  for (let wrappers = 0; wrappers < 8 && index < tokens.length; wrappers++) {
    const wrapper = shellExecutableBasename(tokens[index]);
    if (wrapper === 'env') {
      index += 1;
      while (index < tokens.length) {
        const token = tokens[index];
        if (token === '--') {
          index += 1;
          break;
        }
        if (isShellAssignment(token)) {
          index += 1;
          continue;
        }
        if (token === '-S' || token === '--split-string') {
          const splitString = tokens[index + 1];
          tokens.splice(
            index,
            2,
            ...(splitString ? tokenizeShellClause(splitString) : []),
          );
          continue;
        }
        if (
          token === '-u' ||
          token === '--unset'
        ) {
          index += 2;
          continue;
        }
        if (token === '-C' || token === '--chdir') {
          const nextCwd = resolveLiteralShellPath(
            tokens[index + 1],
            invocationCwd,
          );
          if (nextCwd) invocationCwd = nextCwd;
          index += 2;
          continue;
        }
        if (token.startsWith('--chdir=')) {
          const nextCwd = resolveLiteralShellPath(
            token.slice('--chdir='.length),
            invocationCwd,
          );
          if (nextCwd) invocationCwd = nextCwd;
          index += 1;
          continue;
        }
        if (token.startsWith('-')) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (wrapper === 'command' || wrapper === 'exec' || wrapper === 'nohup') {
      index += 1;
      while (tokens[index]?.startsWith('-')) {
        const isTerminator = tokens[index] === '--';
        index += 1;
        if (isTerminator) break;
      }
      continue;
    }
    break;
  }

  if (index >= tokens.length) return null;
  return {
    executable: shellExecutableBasename(tokens[index]),
    args: tokens.slice(index + 1),
    cwd: invocationCwd,
  };
}

function removalTargetResolvesToRoot(
  target: string,
  cwd: string,
): boolean {
  const slashNormalized = target.replace(/\\/g, '/');
  const wildcardCount = [...slashNormalized].filter(
    (character) => character === '*',
  ).length;

  // A single trailing star means "the contents of this literal directory".
  // Resolve that directory so `*`, `./*`, and `/*` are judged against cwd.
  if (wildcardCount === 1 && slashNormalized.endsWith('*')) {
    const rawDirectory = slashNormalized.slice(0, -1);
    const directory =
      rawDirectory === '' ? '.' : rawDirectory.replace(/\/+$/, '') || '/';
    return resolveLiteralShellPath(directory, cwd) === '/';
  }
  if (wildcardCount > 0) return false;
  return resolveLiteralShellPath(slashNormalized, cwd) === '/';
}

function literalCdTarget(
  invocation: ShellInvocation,
): string | null {
  if (invocation.executable !== 'cd') return null;
  let index = 0;
  while (invocation.args[index]?.startsWith('-')) {
    if (invocation.args[index] === '--') {
      index += 1;
      break;
    }
    index += 1;
  }
  return resolveLiteralShellPath(invocation.args[index], invocation.cwd);
}

type ShellOutcomeStatus = 'success' | 'failure';

interface ShellOutcome {
  cwd: string;
  status: ShellOutcomeStatus;
}

function uniqueShellOutcomes(outcomes: ShellOutcome[]): ShellOutcome[] {
  const seen = new Set<string>();
  return outcomes.filter((outcome) => {
    const key = `${outcome.status}\0${outcome.cwd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function shellInvocationOutcomes(
  invocation: ShellInvocation,
  shellCwd: string,
): ShellOutcome[] {
  const nextCwd = literalCdTarget(invocation);
  if (nextCwd) {
    // We do not know whether an arbitrary literal directory exists. Preserve
    // both the successful cwd and the old cwd on failure; && / || select the
    // branch that can actually execute the following clause.
    return uniqueShellOutcomes([
      { cwd: nextCwd, status: 'success' },
      { cwd: shellCwd, status: 'failure' },
    ]);
  }
  if (invocation.executable === 'true') {
    return [{ cwd: shellCwd, status: 'success' }];
  }
  if (invocation.executable === 'false') {
    return [{ cwd: shellCwd, status: 'failure' }];
  }
  return [
    { cwd: shellCwd, status: 'success' },
    { cwd: shellCwd, status: 'failure' },
  ];
}

function isCatastrophicInvocation(
  invocation: ShellInvocation,
  depth: number,
): boolean {
  const { executable, args, cwd } = invocation;
  if (executable === 'rm') {
    const recursive = args.some(
      (arg) => arg === '--recursive' || /^-[^-]*[rR]/.test(arg),
    );
    const forced = args.some(
      (arg) => arg === '--force' || /^-[^-]*f/.test(arg),
    );
    const targetsRoot = args.some((arg) =>
      removalTargetResolvesToRoot(arg, cwd),
    );
    if (recursive && forced && targetsRoot) return true;
  }
  if (/^mkfs(?:\.[a-z0-9]+)?$/i.test(executable) || executable === 'wipefs') {
    return true;
  }
  if (executable === 'dd' && args.some((arg) => /^of=\/dev\//i.test(arg))) {
    return true;
  }
  if (
    executable === 'find' &&
    args.some((arg) => removalTargetResolvesToRoot(arg, cwd)) &&
    args.includes('-delete')
  ) {
    return true;
  }
  if (
    depth < 3 &&
    /^(?:a|ba|da|z|k)?sh$/.test(executable)
  ) {
    const commandIndex = args.findIndex(
      (arg) => arg === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(arg),
    );
    if (commandIndex >= 0 && args[commandIndex + 1]) {
      return isCatastrophicVmCommand(
        args[commandIndex + 1],
        cwd,
        depth + 1,
      );
    }
  }
  return false;
}

/**
 * Fail closed for mechanically recognizable whole-root destruction only.
 * This deliberately does not expand variables, aliases, functions, eval, or
 * generated shell programs; the replaceable guest remains the real boundary.
 */
function isCatastrophicVmCommand(
  command: string,
  initialCwd: string,
  depth = 0,
): boolean {
  interface ShellFlow {
    activeCwds: string[];
    bypassedOutcomes: ShellOutcome[];
  }

  const normalizedInitialCwd = normalizeAbsolutePath(initialCwd);
  const flowStack: ShellFlow[] = [
    { activeCwds: [normalizedInitialCwd], bypassedOutcomes: [] },
  ];
  for (const event of scanShellStructure(command)) {
    if (event.type === 'group-start') {
      const parent = flowStack.at(-1);
      flowStack.push({
        activeCwds: [...(parent?.activeCwds ?? [normalizedInitialCwd])],
        bypassedOutcomes: [],
      });
      continue;
    }
    if (event.type === 'group-end') {
      if (flowStack.length > 1) flowStack.pop();
      continue;
    }

    const flow = flowStack.at(-1);
    if (!flow) continue;
    const inputCwds = [...flow.activeCwds];
    const outcomes: ShellOutcome[] = [];
    for (const currentCwd of inputCwds) {
      if (
        depth < 4 &&
        extractCommandSubstitutions(event.text).some((fragment) =>
          isCatastrophicVmCommand(fragment, currentCwd, depth + 1),
        )
      ) {
        return true;
      }
      const invocation = unwrapShellInvocation(
        tokenizeShellClause(event.text),
        currentCwd,
      );
      if (!invocation) continue;
      if (isCatastrophicInvocation(invocation, depth)) return true;
      outcomes.push(...shellInvocationOutcomes(invocation, currentCwd));
    }

    const aggregate = uniqueShellOutcomes([
      ...flow.bypassedOutcomes,
      ...outcomes,
    ]);
    if (event.following === '&&') {
      flow.activeCwds = aggregate
        .filter((outcome) => outcome.status === 'success')
        .map((outcome) => outcome.cwd);
      flow.bypassedOutcomes = aggregate.filter(
        (outcome) => outcome.status === 'failure',
      );
      continue;
    }
    if (event.following === '||') {
      flow.activeCwds = aggregate
        .filter((outcome) => outcome.status === 'failure')
        .map((outcome) => outcome.cwd);
      flow.bypassedOutcomes = aggregate.filter(
        (outcome) => outcome.status === 'success',
      );
      continue;
    }
    if (event.following === '|' || event.following === '&') {
      flow.activeCwds = [...new Set(inputCwds)];
      flow.bypassedOutcomes = [];
      continue;
    }
    flow.activeCwds = [...new Set(aggregate.map((outcome) => outcome.cwd))];
    flow.bypassedOutcomes = [];
  }
  return false;
}

function commandTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(value) || Number(value) < 1_000) {
    throw new Error('"timeout_ms" must be an integer of at least 1000.');
  }
  return Math.min(Number(value), MAX_COMMAND_TIMEOUT_MS);
}

function throwIfToolAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Coding tool execution was stopped.');
  error.name = 'AbortError';
  throw error;
}

export async function executeCodingToolCall(
  runtime: CodingRuntime,
  call: CodingToolCall,
  abortSignal?: AbortSignal,
): Promise<CodingToolExecutionResult> {
  // Once a mutating runtime operation resolves, its result must be returned
  // even if Stop raced with that resolution. The harness durably records the
  // result before observing the abort on the next boundary; throwing here
  // would lose the acknowledgement and could replay a non-idempotent tool.
  let completedMutation = false;
  try {
    throwIfToolAborted(abortSignal);
    switch (call.name) {
      case CODING_READ_FILE_TOOL: {
        const path = normalizeCodingWorkspacePath(
          expectString(call.arguments.file_path, 'file_path'),
          runtime.workspaceRoot,
        );
        if (!path) throw new Error('read_file requires a file path.');
        if (isSensitiveFile(path)) {
          throw new Error(
            'Reading secret-bearing files is blocked. Use the host credential settings instead.',
          );
        }
        const startLine = expectOptionalLine(call.arguments.start_line, 'start_line');
        const endLine = expectOptionalLine(call.arguments.end_line, 'end_line');
        const rawContent = await runtime.readText(path);
        throwIfToolAborted(abortSignal);
        const content = selectLineRange(rawContent, startLine, endLine);
        const absolute = absoluteWorkspacePath(runtime, path);
        return {
          content: truncateToolOutput(`Read ${absolute}:\n${content}`),
          display: redactCodingSecrets(`Read ${absolute}`),
          isError: false,
          changedFiles: [],
        };
      }

      case CODING_WRITE_FILE_TOOL: {
        const path = normalizeCodingWorkspacePath(
          expectString(call.arguments.file_path, 'file_path'),
          runtime.workspaceRoot,
        );
        if (!path) throw new Error('write_file requires a file path.');
        if (isSensitiveFile(path)) {
          throw new Error(
            'Writing secret-bearing files through the model is blocked. Use the host credential settings instead.',
          );
        }
        const content = expectString(call.arguments.content, 'content');
        await runtime.writeText(path, content);
        completedMutation = true;
        const absolute = absoluteWorkspacePath(runtime, path);
        return {
          content: redactCodingSecrets(
            `Wrote ${content.length.toLocaleString()} characters to ${absolute}.`,
          ),
          display: redactCodingSecrets(`Wrote ${absolute}`),
          isError: false,
          changedFiles: [path],
        };
      }

      case CODING_REPLACE_TOOL: {
        const path = normalizeCodingWorkspacePath(
          expectString(call.arguments.file_path, 'file_path'),
          runtime.workspaceRoot,
        );
        if (!path) throw new Error('replace requires a file path.');
        if (isSensitiveFile(path)) {
          throw new Error('Editing secret-bearing files through the model is blocked.');
        }
        const oldString = expectString(call.arguments.old_string, 'old_string');
        const newString = expectString(call.arguments.new_string, 'new_string');
        if (!oldString) throw new Error('"old_string" cannot be empty.');
        const current = await runtime.readText(path);
        throwIfToolAborted(abortSignal);
        const matches = current.split(oldString).length - 1;
        if (matches === 0) throw new Error('Could not find old_string in the file.');
        if (matches > 1 && call.arguments.allow_multiple !== true) {
          throw new Error(
            `old_string matched ${matches} times. Provide more context or set allow_multiple to true.`,
          );
        }
        const next =
          call.arguments.allow_multiple === true
            ? current.split(oldString).join(newString)
            : current.replace(oldString, newString);
        await runtime.writeText(path, next);
        completedMutation = true;
        const absolute = absoluteWorkspacePath(runtime, path);
        return {
          content: redactCodingSecrets(
            `Replaced ${matches} occurrence${matches === 1 ? '' : 's'} in ${absolute}.`,
          ),
          display: redactCodingSecrets(`Edited ${absolute}`),
          isError: false,
          changedFiles: [path],
        };
      }

      case CODING_LIST_DIRECTORY_TOOL: {
        const path = normalizeCodingWorkspacePath(
          typeof call.arguments.dir_path === 'string'
            ? call.arguments.dir_path
            : '',
          runtime.workspaceRoot,
        );
        const absolute = absoluteWorkspacePath(runtime, path);
        const entries = await runtime.listDirectory(path);
        throwIfToolAborted(abortSignal);
        const listing = formatDirectory(entries);
        return {
          content: truncateToolOutput(`Listing ${absolute}:\n${listing}`),
          display: redactCodingSecrets(`Listed ${absolute}`),
          isError: false,
          changedFiles: [],
        };
      }

      case CODING_RUN_COMMAND_TOOL: {
        const command = expectString(call.arguments.command, 'command').trim();
        if (!command) throw new Error('run_command requires a command.');
        if (command.includes('\0')) throw new Error('Commands cannot contain null bytes.');
        const cwd = resolveCodingVmCwd(
          typeof call.arguments.cwd === 'string' ? call.arguments.cwd : undefined,
          runtime.workspaceRoot,
        );
        if (isCatastrophicVmCommand(command, cwd)) {
          throw new Error(
            'A whole-VM destructive command was blocked. Reset the environment through the host UI instead.',
          );
        }
        if (call.arguments.background === true) {
          throw new Error(
            'Detached run_command processes are not supported because their success cannot be verified. Run finite commands in the foreground, or use start_preview for a supervised web server.',
          );
        }
        const result = await runtime.runCommand(command, {
          cwd,
          background: false,
          timeoutMs: commandTimeout(call.arguments.timeout_ms),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        completedMutation = true;
        const output = result.output || '(no output)';
        if (result.status !== 0) {
          throw new Error(`Command exited with status ${result.status}:\n${output}`);
        }
        return {
          content: truncateToolOutput(`Command completed in ${cwd}:\n${output}`),
          display: redactCodingSecrets(
            result.background
              ? `Started ${command.split('\n', 1)[0]}`
              : `Ran ${command.split('\n', 1)[0]}`,
          ),
          isError: false,
          // Shell commands can change arbitrary files. The checkpoint layer is
          // authoritative; an empty list means "changes not individually known".
          changedFiles: [],
        };
      }

      case CODING_START_PREVIEW_TOOL: {
        if (!runtime.startPreview) {
          throw new Error('This runtime does not support managed web previews.');
        }
        const command = expectString(call.arguments.command, 'command').trim();
        if (!command) throw new Error('start_preview requires a command.');
        if (command.includes('\0')) throw new Error('Commands cannot contain null bytes.');
        const port = Number(call.arguments.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new Error('"port" must be an integer between 1024 and 65535.');
        }
        const cwd = resolveCodingVmCwd(
          typeof call.arguments.cwd === 'string' ? call.arguments.cwd : undefined,
          runtime.workspaceRoot,
        );
        if (isCatastrophicVmCommand(command, cwd)) {
          throw new Error('A destructive preview command was blocked.');
        }
        const result = await runtime.startPreview({
          command,
          port,
          cwd,
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        completedMutation = true;
        const output = result.output || '(no output)';
        if (result.status !== 0) {
          throw new Error(`Preview failed with status ${result.status}:\n${output}`);
        }
        return {
          content: truncateToolOutput(
            [
              `Preview process started on port ${result.port}.`,
              result.url ? `Private preview URL: ${result.url}` : 'The private preview URL is still being assigned.',
              output,
            ].join('\n'),
          ),
          display: redactCodingSecrets(
            result.url
              ? `Preview ready at ${result.url}`
              : `Preview started on port ${result.port}`,
          ),
          isError: false,
          changedFiles: [],
        };
      }

      default:
        throw new Error(`Unknown coding tool: ${call.name}`);
    }
  } catch (error) {
    if (
      (abortSignal?.aborted && !completedMutation) ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      throw error;
    }
    const message = redactCodingSecrets(
      error instanceof Error ? error.message : String(error),
    );
    return {
      // Failure output gets the same size cap as success output: a failing
      // build can emit megabytes that would otherwise be persisted per event
      // and replayed to the provider on every subsequent request.
      content: truncateToolOutput(`Tool ${call.name} failed: ${message}`),
      display: redactCodingSecrets(`Failed ${call.name}`),
      isError: true,
      changedFiles: [],
    };
  }
}
