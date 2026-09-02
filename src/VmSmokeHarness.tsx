import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Play, Server, Terminal, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_WEBVM_DISK_PROFILE,
  SERVER_PORT,
  SERVER_PORT_RANGE_END,
  SITE_ROOT,
  WEBVM_CODING_CANDIDATE_PROFILE,
  WEBVM_VENDOR_ALPINE_PROFILE,
} from './lib/constants';
import { WebVmBackend, type WebVmStatus } from './lib/webvm';

type SmokeState = 'idle' | 'running' | 'passed' | 'failed';

function readStoredTailKey(): string {
  try {
    const raw = window.localStorage.getItem('sparkrun.savedKeys.v1');
    if (!raw) {
      return '';
    }
    const parsed = JSON.parse(raw) as { tailscaleAuthKey?: unknown };
    return typeof parsed.tailscaleAuthKey === 'string' ? parsed.tailscaleAuthKey : '';
  } catch {
    return '';
  }
}

function resolveTailKey(): { value: string; source: string } {
  const storedValue = readStoredTailKey().trim();
  if (storedValue) {
    return { value: storedValue, source: 'browser storage' };
  }
  return { value: '', source: '' };
}

function resolveDiskProfile() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('image') === 'vendor-alpine') {
    return WEBVM_VENDOR_ALPINE_PROFILE;
  }
  return params.get('image') === 'candidate'
    ? WEBVM_CODING_CANDIDATE_PROFILE
    : DEFAULT_WEBVM_DISK_PROFILE;
}

export function resolveSmokeDatabaseSuffix(
  search: string,
  randomId: () => string = () => globalThis.crypto.randomUUID(),
): string {
  const params = new URLSearchParams(search);
  const requested = params.get('run') ?? '';
  const safe = requested.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  // Explicit probes must never inherit a half-written IndexedDB workspace or
  // root overlay from an earlier attempt. Even an explicit run=<label> gets a
  // random suffix: labels help correlate a run, but must not turn the release
  // gate into a reusable cache name.
  if (params.has('probe')) {
    const unique = randomId().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
    if (!unique) {
      throw new Error('Could not create an isolated database name for the VM probe.');
    }
    return `${safe ? `-${safe}` : ''}-probe-${unique}`;
  }
  // Ordinary interactive smoke runs keep their stable cache unless the caller
  // deliberately supplies run=<id>.
  if (safe) {
    return `-${safe}`;
  }
  return '';
}

export type VmSmokeProbeStepId =
  | `inventory-${string}`
  | `npm-diagnostic-${string}`
  | 'node-exit'
  | 'node-exit-override'
  | 'node-processes'
  | 'npm-offline'
  | 'python-runtime'
  | 'native-c'
  | 'go-build'
  | 'runner-timeout';

export interface VmSmokeProbeStep {
  id: VmSmokeProbeStepId;
  label: string;
  command: string;
  timeoutMs: number;
  expectedStatus: number;
  expectedOutput: readonly string[];
  rejectedOutput?: readonly string[];
  fixture?: {
    url: string;
    workspacePath: string;
    byteLength: number;
    sha256: string;
  };
}

export interface VmSmokeProbe {
  label: string;
  candidateOnly: boolean;
  steps: readonly VmSmokeProbeStep[];
}

const REQUIRED_TOOL_COMMANDS = [
  ['bash', 'bash', '--version'],
  ['zsh', 'zsh', '--version'],
  ['git', 'git', '--version'],
  ['git-lfs', 'git-lfs', 'version'],
  ['ssh', 'ssh', '-V'],
  ['curl', 'curl', '--version'],
  ['wget', 'wget', '--version'],
  ['dig', 'dig', '-v'],
  ['node', 'node', '--version'],
  ['npm', 'npm', '--version'],
  ['npx', 'npx', '--version'],
  ['pnpm', 'pnpm', '--version'],
  ['yarn', 'yarn', '--version'],
  ['python', 'python3', '--version'],
  ['pip', 'pip3', '--version'],
  ['pipx', 'pipx', '--version'],
  ['go', 'go', 'version'],
  ['gcc', 'gcc', '--version'],
  ['g++', 'g++', '--version'],
  ['make', 'make', '--version'],
  ['cmake', 'cmake', '--version'],
  ['ninja', 'ninja', '--version'],
  ['gdb', 'gdb', '--version'],
  ['sqlite', 'sqlite3', '--version'],
  ['jq', 'jq', '--version'],
  ['ripgrep', 'rg', '--version'],
  ['fd', 'fd', '--version'],
  ['tmux', 'tmux', '-V'],
  ['rsync', 'rsync', '--version'],
  ['socat', 'socat', '-V'],
  ['netcat', 'nc', '-h'],
  ['lsof', 'lsof', '-v'],
] as const;

type RequiredToolName = (typeof REQUIRED_TOOL_COMMANDS)[number][0];
type RequiredToolCommand = (typeof REQUIRED_TOOL_COMMANDS)[number];

const INVENTORY_TOOL_TIMEOUT_SECONDS = 20;
const INVENTORY_RUNTIME_TIMEOUT_SECONDS = 60;

const LONG_INVENTORY_TOOL_NAMES = new Set<RequiredToolName>([
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python',
  'pip',
  'pipx',
  'go',
]);

function inventoryStepSlug(name: RequiredToolName): string {
  return name === 'g++' ? 'gpp' : name.replace(/[^a-z0-9-]/g, '-');
}

function inventoryVersionAssertions(name: RequiredToolName): readonly string[] {
  switch (name) {
    case 'node':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = v24.18.1'];
    case 'npm':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = 11.12.1'];
    case 'pnpm':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = 11.20.0'];
    case 'yarn':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = 1.22.22'];
    case 'python':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = "Python 3.14.7"'];
    case 'pip':
      return ["grep -Fq 'pip 26.1.2 ' \"$sparkrun_output\""];
    case 'pipx':
      return ['test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = 1.14.0'];
    case 'go':
      return ["grep -Fq 'go version go1.26.3 ' \"$sparkrun_output\""];
    default:
      return [];
  }
}

function createInventoryToolStep(command: RequiredToolCommand): VmSmokeProbeStep {
  const [name, executable, ...args] = command;
  const slug = inventoryStepSlug(name);
  const proof = `inventory:${name}:ok`;
  const query = [executable, ...args].map((part) => JSON.stringify(part)).join(' ');
  return {
    id: `inventory-tool-${slug}`,
    label: `Verify ${name} can report its version`,
    command: [
      'set -euo pipefail',
      `sparkrun_output="/tmp/sparkrun-inventory-${slug}-$$.out"`,
      'trap \'rm -f "$sparkrun_output"\' EXIT',
      `command -v ${JSON.stringify(executable)} >/dev/null`,
      `${query} 2>&1 | tee "$sparkrun_output"`,
      'test -s "$sparkrun_output"',
      ...inventoryVersionAssertions(name),
      `printf '${proof}\\n'`,
    ].join('\n'),
    timeoutMs: LONG_INVENTORY_TOOL_NAMES.has(name)
      ? name === 'npm'
        ? 360_000
        : INVENTORY_RUNTIME_TIMEOUT_SECONDS * 1_000
      : INVENTORY_TOOL_TIMEOUT_SECONDS * 1_000,
    expectedStatus: 0,
    expectedOutput: [proof],
  };
}

function createInventoryContractStep(options: {
  id: `inventory-${string}`;
  label: string;
  command: readonly string[];
  proof: string;
}): VmSmokeProbeStep {
  return {
    id: options.id,
    label: options.label,
    command: [...options.command, `printf '${options.proof}\\n'`].join('\n'),
    timeoutMs: INVENTORY_TOOL_TIMEOUT_SECONDS * 1_000,
    expectedStatus: 0,
    expectedOutput: [options.proof],
  };
}

export const INVENTORY_TOOL_STEPS = REQUIRED_TOOL_COMMANDS.map(
  createInventoryToolStep,
) as readonly VmSmokeProbeStep[];

const INVENTORY_PLATFORM_STEPS = [
  createInventoryContractStep({
    id: 'inventory-platform-architecture',
    label: 'Verify the candidate userspace architecture',
    command: [
      'set -euo pipefail',
      'apk --print-arch 2>&1 | tee /tmp/sparkrun-inventory-architecture.out',
      "grep -Eq '^(x86|i386)$' /tmp/sparkrun-inventory-architecture.out",
      'rm -f /tmp/sparkrun-inventory-architecture.out',
    ],
    proof: 'inventory:platform-architecture:ok',
  }),
  createInventoryContractStep({
    id: 'inventory-platform-libc',
    label: 'Verify the candidate musl libc',
    command: [
      'set -euo pipefail',
      'ldd --version 2>&1 | tee /tmp/sparkrun-inventory-libc.out',
      'grep -qi musl /tmp/sparkrun-inventory-libc.out',
      'rm -f /tmp/sparkrun-inventory-libc.out',
    ],
    proof: 'inventory:platform-libc:ok',
  }),
  createInventoryContractStep({
    id: 'inventory-platform-bash',
    label: 'Verify Bash is a 32-bit Intel executable',
    command: [
      'set -euo pipefail',
      'file -b /bin/bash 2>&1 | tee /tmp/sparkrun-inventory-bash-binary.out',
      "grep -Eqi 'ELF 32-bit.*Intel (i386|80386)' /tmp/sparkrun-inventory-bash-binary.out",
      'rm -f /tmp/sparkrun-inventory-bash-binary.out',
    ],
    proof: 'inventory:platform-bash:ok',
  }),
] as const satisfies readonly VmSmokeProbeStep[];

const INVENTORY_COMPATIBILITY_STEPS = [
  createInventoryContractStep({
    id: 'inventory-compatibility-files',
    label: 'Verify root-owned Node compatibility files',
    command: [
      'set -euo pipefail',
      'test -x /usr/local/bin/sparkrun-toolchain-check',
      'test -f /usr/local/lib/sparkrun/node-exit-preload.cjs',
      'test -f /usr/local/lib/sparkrun/node-exit-addon.node',
      'test "$(stat -c %u:%g /usr/local/lib/sparkrun/node-exit-preload.cjs)" = 0:0',
      'test "$(stat -c %u:%g /usr/local/lib/sparkrun/node-exit-addon.node)" = 0:0',
      'test "$(stat -c %a /usr/local/lib/sparkrun/node-exit-preload.cjs)" = 444',
      'test "$(stat -c %a /usr/local/lib/sparkrun/node-exit-addon.node)" = 444',
    ],
    proof: 'inventory:compatibility-files:ok',
  }),
  createInventoryContractStep({
    id: 'inventory-compatibility-environment',
    label: 'Verify Node compatibility environment wiring',
    command: [
      'set -euo pipefail',
      'test "${NODE_OPTIONS:-}" = --require=/usr/local/lib/sparkrun/node-exit-preload.cjs',
      'test "${SPARKRUN_NODE_EXIT_ADDON:-}" = /usr/local/lib/sparkrun/node-exit-addon.node',
      'test "${NODE_COMPILE_CACHE:-}" = /usr/local/lib/sparkrun/node-compile-cache',
    ],
    proof: 'inventory:compatibility-environment:ok',
  }),
  createInventoryContractStep({
    id: 'inventory-compatibility-cache',
    label: 'Verify the prewarmed root-only Node compile cache',
    command: [
      'set -euo pipefail',
      'test "$(stat -c %a "$NODE_COMPILE_CACHE")" = 700',
      'test -n "$(find "$NODE_COMPILE_CACHE" -type f -print -quit)"',
    ],
    proof: 'inventory:compatibility-cache:ok',
  }),
] as const satisfies readonly VmSmokeProbeStep[];

export const INVENTORY_PROBE_STEPS = [
  ...INVENTORY_TOOL_STEPS,
  ...INVENTORY_PLATFORM_STEPS,
  ...INVENTORY_COMPATIBILITY_STEPS,
] as const satisfies readonly VmSmokeProbeStep[];

const NPM_INVENTORY_STEP = INVENTORY_TOOL_STEPS.find(
  ({ id }) => id === 'inventory-tool-npm',
);
if (!NPM_INVENTORY_STEP) {
  throw new Error('The npm inventory step is missing.');
}

const NPM_DIAGNOSTIC_TIMEOUT_MS = 180_000;

function createNpmDiagnosticStep(options: {
  variant: string;
  label: string;
  command: readonly string[];
  expectedOutput: readonly string[];
  fixture?: VmSmokeProbeStep['fixture'];
  timeoutMs?: number;
}): VmSmokeProbeStep {
  return {
    id: `npm-diagnostic-${options.variant}`,
    label: options.label,
    command: options.command.join('\n'),
    timeoutMs: options.timeoutMs ?? NPM_DIAGNOSTIC_TIMEOUT_MS,
    expectedStatus: 0,
    expectedOutput: options.expectedOutput,
    fixture: options.fixture,
  };
}

const NPM_LIFECYCLE_SCRIPT = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const markerPath = '/tmp/sparkrun-npm-lifecycle.log';",
  'const mark = (value) => {',
  '  const line = `MARK:${value}\\n`;',
  '  fs.appendFileSync(markerPath, line);',
  '  fs.writeSync(2, line);',
  '};',
  "process.on('exit', (code) => mark(`PROCESS_EXIT:${code}`));",
  "mark('BEFORE_CLI');",
  'let returned;',
  'try {',
  "  returned = require('/usr/lib/node_modules/npm/lib/cli.js')(process);",
  '} catch (error) {',
  "  mark(`CLI_THROW:${error?.name || 'Error'}`);",
  '  throw error;',
  '}',
  'Promise.resolve(returned).then(',
  "  () => mark('CLI_PROMISE_RESOLVED'),",
  '  (error) => {',
  "    mark(`CLI_PROMISE_REJECTED:${error?.name || 'Error'}`);",
  '    process.exitCode = 1;',
  '  },',
  ');',
] as const;

function npmLifecycleScriptSetup(): readonly string[] {
  return [
    'rm -f /tmp/sparkrun-npm-lifecycle.log /tmp/sparkrun-npm-lifecycle.cjs',
    "cat >/tmp/sparkrun-npm-lifecycle.cjs <<'SPARKRUN_NPM_LIFECYCLE'",
    ...NPM_LIFECYCLE_SCRIPT,
    'SPARKRUN_NPM_LIFECYCLE',
  ];
}

const NPM_STREAM_CALLBACK_SCRIPT = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const mark = (value) => { const line = `MARK:${value}\\n`; fs.appendFileSync('/tmp/sparkrun-stream-callback.log', line); fs.writeSync(2, line); };",
  "process.on('exit', (code) => mark(`PROCESS_EXIT:${code}`));",
  "mark('BEFORE_STDERR_WRITE');",
  "process.stderr.write('', () => {",
  "  mark('STDERR_CALLBACK');",
  "  process.stdout.write('', () => {",
  "    mark('STDOUT_CALLBACK');",
  '    process.exit(0);',
  '  });',
  '});',
] as const;

const NPM_EXPLICIT_FLUSH_SCRIPT = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const { flushCompileCache } = require('node:module');",
  "const mark = (value) => { const line = `MARK:${value}\\n`; fs.appendFileSync('/tmp/sparkrun-explicit-flush.log', line); fs.writeSync(2, line); };",
  "process.on('exit', (code) => mark(`PROCESS_EXIT:${code}`));",
  '(async () => {',
  "  mark('BEFORE_NPM_LOAD');",
  "  const Npm = require('/usr/lib/node_modules/npm/lib/npm.js');",
  '  const npm = new Npm();',
  '  const loaded = await npm.load();',
  '  mark(`NPM_LOADED:exec=${String(loaded.exec)}`);',
  "  mark('BEFORE_FLUSH');",
  '  flushCompileCache();',
  "  mark('AFTER_FLUSH');",
  '  process.exit(0);',
  "})().catch((error) => { mark(`ERROR:${error?.name || 'Error'}`); process.exitCode = 1; });",
] as const;

export const NPM_DIAGNOSTIC_VARIANTS = {
  'node-script': {
    label: 'Node script control',
    step: createNpmDiagnosticStep({
      variant: 'node-script',
      label: 'Run a minimal Node script control',
      command: [
        'set -euo pipefail',
        `node -e 'console.log("MARK:NODE_SCRIPT")'`,
      ],
      expectedOutput: ['MARK:NODE_SCRIPT'],
    }),
  },
  'node-script-jitless': {
    label: 'Run a minimal Node script without V8 JIT',
    step: createNpmDiagnosticStep({
      variant: 'node-script-jitless',
      label: 'Run a minimal Node script with V8 JIT disabled',
      command: [
        'set -euo pipefail',
        `node --jitless -e 'console.log("MARK:NODE_SCRIPT_JITLESS"); process.exit(0)'`,
      ],
      timeoutMs: 120_000,
      expectedOutput: ['MARK:NODE_SCRIPT_JITLESS'],
    }),
  },
  'npm-package': {
    label: 'Read npm package metadata',
    step: createNpmDiagnosticStep({
      variant: 'npm-package',
      label: 'Read npm package metadata without loading its runtime graph',
      command: [
        'set -euo pipefail',
        `node -p 'require("/usr/lib/node_modules/npm/package.json").version'`,
      ],
      expectedOutput: ['11.12.1'],
    }),
  },
  'npm-graph': {
    label: 'Load the npm runtime graph',
    step: createNpmDiagnosticStep({
      variant: 'npm-graph',
      label: 'Load the npm runtime graph with the default compile cache',
      command: [
        'set -euo pipefail',
        `node -e 'const t=Date.now(); require("/usr/lib/node_modules/npm/lib/npm.js"); console.log("MARK:NPM_GRAPH:"+(Date.now()-t))'`,
      ],
      expectedOutput: ['MARK:NPM_GRAPH:'],
    }),
  },
  'npm-graph-no-cache': {
    label: 'Load the npm runtime graph without compile cache',
    step: createNpmDiagnosticStep({
      variant: 'npm-graph-no-cache',
      label: 'Load the npm runtime graph with the compile cache disabled',
      command: [
        'set -euo pipefail',
        `NODE_DISABLE_COMPILE_CACHE=1 node -e 'const t=Date.now(); require("/usr/lib/node_modules/npm/lib/npm.js"); console.log("MARK:NPM_GRAPH:"+(Date.now()-t))'`,
      ],
      expectedOutput: ['MARK:NPM_GRAPH:'],
    }),
  },
  'staged-archive': {
    label: 'Load npm from one staged archive',
    step: createNpmDiagnosticStep({
      variant: 'staged-archive',
      label: 'Extract the exact npm package from one clean archive',
      fixture: {
        url: 'http://127.0.0.1:4174/npm-runtime-clean.tar.gz',
        workspacePath: '.sparkrun-diagnostics/npm-runtime.tar.gz',
        byteLength: 2_210_129,
        sha256: '978dd98b052e572f2f1289ce7bdcfa36be7b9ab49a8bf4bc4013ef7e51f93c1a',
      },
      command: [
        'set -euo pipefail',
        'rm -rf /tmp/sparkrun-npm-stage',
        'mkdir -p /tmp/sparkrun-npm-stage',
        "printf 'MARK:ARCHIVE_EXTRACT_START\\n'",
        'tar -C /tmp/sparkrun-npm-stage -xzf /workspace/site/.sparkrun-diagnostics/npm-runtime.tar.gz',
        'test -f /tmp/sparkrun-npm-stage/npm/package.json',
        'test -f /tmp/sparkrun-npm-stage/npm/lib/npm.js',
        'test -f /tmp/sparkrun-npm-stage/npm/bin/npm-cli.js',
        "printf 'MARK:ARCHIVE_EXTRACTED\\n'",
      ],
      timeoutMs: 120_000,
      expectedOutput: ['MARK:ARCHIVE_EXTRACT_START', 'MARK:ARCHIVE_EXTRACTED'],
    }),
    followUpSteps: [
      createNpmDiagnosticStep({
        variant: 'staged-archive-first-cli',
        label: 'Run the first npm CLI invocation from the staged tree',
        command: [
          'set -euo pipefail',
          "printf 'MARK:STAGED_NPM_FIRST_START\\n'",
          'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node /tmp/sparkrun-npm-stage/npm/bin/npm-cli.js --version',
          "printf 'MARK:STAGED_NPM_FIRST_RETURNED\\n'",
        ],
        timeoutMs: 60_000,
        expectedOutput: [
          'MARK:STAGED_NPM_FIRST_START',
          '11.12.1',
          'MARK:STAGED_NPM_FIRST_RETURNED',
        ],
      }),
      createNpmDiagnosticStep({
        variant: 'staged-archive-second-cli',
        label: 'Run the warm npm CLI invocation from the staged tree',
        command: [
          'set -euo pipefail',
          'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node /tmp/sparkrun-npm-stage/npm/bin/npm-cli.js --version',
          "printf 'MARK:STAGED_NPM_SECOND_RETURNED\\n'",
        ],
        timeoutMs: 30_000,
        expectedOutput: ['11.12.1', 'MARK:STAGED_NPM_SECOND_RETURNED'],
      }),
    ],
  },
  'bundled-cli': {
    label: 'Run npm from one bundled JavaScript file',
    step: createNpmDiagnosticStep({
      variant: 'bundled-cli',
      label: 'Run the first npm version check from one bundled JavaScript file',
      fixture: {
        url: 'http://127.0.0.1:4174/npm-cli-static.cjs',
        workspacePath: '.sparkrun-diagnostics/npm-cli-static.cjs',
        byteLength: 3_816_642,
        sha256: '16689c3d9ea96df5137a553e948d1417579325128fdfdd6affc317d1586ded18',
      },
      command: [
        'set -euo pipefail',
        "printf 'MARK:BUNDLED_NPM_FIRST_START\\n'",
        'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node /workspace/site/.sparkrun-diagnostics/npm-cli-static.cjs --version',
        "printf 'MARK:BUNDLED_NPM_FIRST_RETURNED\\n'",
      ],
      timeoutMs: 60_000,
      expectedOutput: [
        'MARK:BUNDLED_NPM_FIRST_START',
        '11.12.1',
        'MARK:BUNDLED_NPM_FIRST_RETURNED',
      ],
    }),
    followUpSteps: [
      createNpmDiagnosticStep({
        variant: 'bundled-cli-second',
        label: 'Run the warm npm version check from the bundled JavaScript file',
        command: [
          'set -euo pipefail',
          'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node /workspace/site/.sparkrun-diagnostics/npm-cli-static.cjs --version',
          "printf 'MARK:BUNDLED_NPM_SECOND_RETURNED\\n'",
        ],
        timeoutMs: 30_000,
        expectedOutput: ['11.12.1', 'MARK:BUNDLED_NPM_SECOND_RETURNED'],
      }),
    ],
  },
  'pnpm-version': {
    label: 'Run pnpm as a package-manager control',
    step: createNpmDiagnosticStep({
      variant: 'pnpm-version',
      label: 'Run pnpm version as an independent package-manager control',
      command: [
        'set -euo pipefail',
        "printf 'MARK:PNPM_START\\n'",
        'NODE_DISABLE_COMPILE_CACHE=1 pnpm --version',
        "printf 'MARK:PNPM_RETURNED\\n'",
      ],
      timeoutMs: 120_000,
      expectedOutput: ['MARK:PNPM_START', '11.20.0', 'MARK:PNPM_RETURNED'],
    }),
    followUpSteps: [
      createNpmDiagnosticStep({
        variant: 'pnpm-version-warm',
        label: 'Run the warm pnpm version control',
        command: [
          'set -euo pipefail',
          'NODE_DISABLE_COMPILE_CACHE=1 pnpm --version',
          "printf 'MARK:PNPM_WARM_RETURNED\\n'",
        ],
        timeoutMs: 30_000,
        expectedOutput: ['11.20.0', 'MARK:PNPM_WARM_RETURNED'],
      }),
    ],
  },
  'yarn-version': {
    label: 'Run Yarn as a package-manager control',
    step: createNpmDiagnosticStep({
      variant: 'yarn-version',
      label: 'Run Yarn version as an independent package-manager control',
      command: [
        'set -euo pipefail',
        "printf 'MARK:YARN_START\\n'",
        'NODE_DISABLE_COMPILE_CACHE=1 yarn --version',
        "printf 'MARK:YARN_RETURNED\\n'",
      ],
      timeoutMs: 120_000,
      expectedOutput: ['MARK:YARN_START', '1.22.22', 'MARK:YARN_RETURNED'],
    }),
  },
  'direct-cli': {
    label: 'Invoke npm-cli.js directly',
    step: createNpmDiagnosticStep({
      variant: 'direct-cli',
      label: 'Invoke npm-cli.js directly through Node',
      command: [
        'set -euo pipefail',
        '/usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js --version',
        "printf 'MARK:DIRECT_CLI_RETURNED\\n'",
      ],
      expectedOutput: ['11.12.1', 'MARK:DIRECT_CLI_RETURNED'],
    }),
  },
  'lifecycle-marker': {
    label: 'Trace npm CLI lifecycle',
    step: createNpmDiagnosticStep({
      variant: 'lifecycle-marker',
      label: 'Trace npm CLI loading, promise resolution, and process exit',
      command: [
        'set -euo pipefail',
        ...npmLifecycleScriptSetup(),
        '/usr/bin/node /tmp/sparkrun-npm-lifecycle.cjs --version',
      ],
      expectedOutput: ['MARK:BEFORE_CLI'],
    }),
  },
  'stream-callback': {
    label: 'Trace zero-byte stream callbacks',
    step: createNpmDiagnosticStep({
      variant: 'stream-callback',
      label: 'Trace npm-style stderr and stdout completion callbacks',
      command: [
        'set -euo pipefail',
        'rm -f /tmp/sparkrun-stream-callback.log /tmp/sparkrun-stream-callback.cjs',
        "cat >/tmp/sparkrun-stream-callback.cjs <<'SPARKRUN_STREAM_CALLBACK'",
        ...NPM_STREAM_CALLBACK_SCRIPT,
        'SPARKRUN_STREAM_CALLBACK',
        '/usr/bin/node /tmp/sparkrun-stream-callback.cjs',
      ],
      expectedOutput: [
        'MARK:BEFORE_STDERR_WRITE',
        'MARK:STDERR_CALLBACK',
        'MARK:STDOUT_CALLBACK',
        'MARK:PROCESS_EXIT:0',
      ],
    }),
  },
  'cache-disabled': {
    label: 'Trace npm with compile cache disabled',
    step: createNpmDiagnosticStep({
      variant: 'cache-disabled',
      label: 'Trace npm CLI with the Node compile cache disabled',
      command: [
        'set -euo pipefail',
        ...npmLifecycleScriptSetup(),
        'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node /tmp/sparkrun-npm-lifecycle.cjs --version',
      ],
      expectedOutput: ['MARK:BEFORE_CLI'],
    }),
  },
  'volatile-cache': {
    label: 'Trace npm with a fresh writable cache',
    step: createNpmDiagnosticStep({
      variant: 'volatile-cache',
      label: 'Trace npm CLI with a fresh writable compile cache',
      command: [
        'set -euo pipefail',
        ...npmLifecycleScriptSetup(),
        'rm -rf /tmp/sparkrun-node-cache',
        'mkdir -p /tmp/sparkrun-node-cache',
        'NODE_COMPILE_CACHE=/tmp/sparkrun-node-cache /usr/bin/node /tmp/sparkrun-npm-lifecycle.cjs --version',
      ],
      expectedOutput: ['MARK:BEFORE_CLI'],
    }),
  },
  'explicit-flush': {
    label: 'Trace npm load and compile-cache flush',
    step: createNpmDiagnosticStep({
      variant: 'explicit-flush',
      label: 'Trace npm loading and an explicit Node compile-cache flush',
      command: [
        'set -euo pipefail',
        'rm -rf /tmp/sparkrun-explicit-cache',
        'rm -f /tmp/sparkrun-explicit-flush.log /tmp/sparkrun-explicit-flush.cjs',
        'mkdir -p /tmp/sparkrun-explicit-cache',
        "cat >/tmp/sparkrun-explicit-flush.cjs <<'SPARKRUN_EXPLICIT_FLUSH'",
        ...NPM_EXPLICIT_FLUSH_SCRIPT,
        'SPARKRUN_EXPLICIT_FLUSH',
        'NODE_COMPILE_CACHE=/tmp/sparkrun-explicit-cache /usr/bin/node /tmp/sparkrun-explicit-flush.cjs --version',
      ],
      expectedOutput: [
        'MARK:BEFORE_NPM_LOAD',
        'MARK:NPM_LOADED:exec=',
        'MARK:BEFORE_FLUSH',
        'MARK:AFTER_FLUSH',
        'MARK:PROCESS_EXIT:0',
      ],
    }),
  },
} as const satisfies Record<
  string,
  {
    label: string;
    step: VmSmokeProbeStep;
    followUpSteps?: readonly VmSmokeProbeStep[];
  }
>;

const NODE_EXIT_STEP: VmSmokeProbeStep = {
  id: 'node-exit',
  label: 'Verify Node exit status, preload, cleanup hook, and exit handlers',
  command: [
    'set -euo pipefail',
    'sparkrun_node_log="$(mktemp)"',
    'sparkrun_exit_file="$(mktemp)"',
    'trap \'rm -f "$sparkrun_node_log" "$sparkrun_exit_file"\' EXIT',
    'sparkrun_expect_status() {',
    '  sparkrun_expected="$1"',
    '  sparkrun_label="$2"',
    '  shift 2',
    '  set +e',
    '  "$@" >"$sparkrun_node_log" 2>&1',
    '  sparkrun_actual=$?',
    '  set -e',
    '  if test "$sparkrun_actual" -ne "$sparkrun_expected"; then',
    '    printf "node-exit:%s:status=%s expected=%s\\n" "$sparkrun_label" "$sparkrun_actual" "$sparkrun_expected"',
    '    sed -n \'1,80p\' "$sparkrun_node_log"',
    '    return 1',
    '  fi',
    '  printf "node-exit:%s:ok\\n" "$sparkrun_label"',
    '}',
    "sparkrun_expect_status 0 natural node -e 'void 0'",
    "sparkrun_expect_status 7 explicit node -e 'process.exit(7)'",
    "sparkrun_expect_status 7 deferred node -e 'process.exitCode = 7'",
    "sparkrun_expect_status 7 listener node -e \"process.on('exit', () => { process.exitCode = 7; })\"",
    "sparkrun_expect_status 9 final-listener node -e \"process.on('exit', () => { process.exitCode = 7; }); process.on('exit', () => { process.exitCode = 9; })\"",
    "sparkrun_expect_status 9 nested-exit node -e \"process.on('exit', () => { process.exit(9); })\"",
    "sparkrun_expect_status 1 listener-error node -e \"process.on('exit', () => { throw new Error('expected-exit-error') })\"",
    "sparkrun_expect_status 7 cache-disabled env NODE_DISABLE_COMPILE_CACHE=1 node -e 'process.exitCode = 7'",
    "sparkrun_expect_status 1 uncaught node -e \"throw new Error('expected-conformance-error')\"",
    'sparkrun_expect_status 0 user-handler node -e "require(\'node:fs\').writeFileSync(process.argv[1], \'exit-handler-ok\'); process.on(\'exit\', () => require(\'node:fs\').appendFileSync(process.argv[1], \':ran\'))" "$sparkrun_exit_file"',
    'test "$(cat "$sparkrun_exit_file")" = exit-handler-ok:ran',
    "printf 'node-exit:user-handler-file:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: [
    'node-exit:natural:ok',
    'node-exit:explicit:ok',
    'node-exit:deferred:ok',
    'node-exit:listener:ok',
    'node-exit:final-listener:ok',
    'node-exit:nested-exit:ok',
    'node-exit:listener-error:ok',
    'node-exit:cache-disabled:ok',
    'node-exit:uncaught:ok',
    'node-exit:user-handler:ok',
    'node-exit:user-handler-file:ok',
  ],
};

/**
 * Hypothesis probe for the rc3 Node hang. `node -e 'void 0'` completes because
 * the baked cleanup hook calls _exit() during environment teardown, but
 * `process.exit()` takes Node's C++ Exit path (platform teardown, no env
 * cleanup hooks) and never returns under CheerpX. This step compiles a tiny
 * N-API addon inside the guest, overrides `process.reallyExit` with a direct
 * `_exit(code)`, and checks that explicit, deferred, nested, and uncaught exits
 * all terminate with the exact status. A pass here justifies baking the
 * override into the next image revision.
 */
const NODE_EXIT_OVERRIDE_STEP: VmSmokeProbeStep = {
  id: 'node-exit-override',
  label: 'Prove a process.reallyExit override ends explicit Node exits',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    // Sources are base64 so the command validator never sees a bare "&"
    // (C address-of) as a shell background operator.
    "printf '%s' 'I2luY2x1ZGUgPHN0ZGRlZi5oPgojaW5jbHVkZSA8c3RkaW50Lmg+CiNpbmNsdWRlIDx1bmlzdGQuaD4KdHlwZWRlZiBzdHJ1Y3QgbmFwaV9lbnZfXyAqbmFwaV9lbnY7CnR5cGVkZWYgc3RydWN0IG5hcGlfdmFsdWVfXyAqbmFwaV92YWx1ZTsKdHlwZWRlZiBzdHJ1Y3QgbmFwaV9jYWxsYmFja19pbmZvX18gKm5hcGlfY2FsbGJhY2tfaW5mbzsKdHlwZWRlZiBpbnQgbmFwaV9zdGF0dXM7CnR5cGVkZWYgbmFwaV92YWx1ZSAoKm5hcGlfY2FsbGJhY2spKG5hcGlfZW52LCBuYXBpX2NhbGxiYWNrX2luZm8pOwpleHRlcm4gbmFwaV9zdGF0dXMgbmFwaV9jcmVhdGVfZnVuY3Rpb24obmFwaV9lbnYsIGNvbnN0IGNoYXIgKiwgc2l6ZV90LCBuYXBpX2NhbGxiYWNrLCB2b2lkICosIG5hcGlfdmFsdWUgKik7CmV4dGVybiBuYXBpX3N0YXR1cyBuYXBpX2dldF9jYl9pbmZvKG5hcGlfZW52LCBuYXBpX2NhbGxiYWNrX2luZm8sIHNpemVfdCAqLCBuYXBpX3ZhbHVlICosIG5hcGlfdmFsdWUgKiwgdm9pZCAqKik7CmV4dGVybiBuYXBpX3N0YXR1cyBuYXBpX2dldF91bmRlZmluZWQobmFwaV9lbnYsIG5hcGlfdmFsdWUgKik7CmV4dGVybiBuYXBpX3N0YXR1cyBuYXBpX2dldF92YWx1ZV9pbnQzMihuYXBpX2VudiwgbmFwaV92YWx1ZSwgaW50MzJfdCAqKTsKZXh0ZXJuIG5hcGlfc3RhdHVzIG5hcGlfc2V0X25hbWVkX3Byb3BlcnR5KG5hcGlfZW52LCBuYXBpX3ZhbHVlLCBjb25zdCBjaGFyICosIG5hcGlfdmFsdWUpOwpzdGF0aWMgbmFwaV92YWx1ZSBleGl0X25vdyhuYXBpX2VudiBlbnYsIG5hcGlfY2FsbGJhY2tfaW5mbyBpbmZvKSB7CiAgc2l6ZV90IGFyZ2MgPSAxOyBuYXBpX3ZhbHVlIGFyZ3ZbMV07IG5hcGlfdmFsdWUgcmVzdWx0OyBpbnQzMl90IGNvZGUgPSAwOwogIGlmIChuYXBpX2dldF9jYl9pbmZvKGVudiwgaW5mbywgJmFyZ2MsIGFyZ3YsIE5VTEwsIE5VTEwpID09IDAgJiYgYXJnYyA9PSAxKSBuYXBpX2dldF92YWx1ZV9pbnQzMihlbnYsIGFyZ3ZbMF0sICZjb2RlKTsKICBfZXhpdChjb2RlKTsKICBuYXBpX2dldF91bmRlZmluZWQoZW52LCAmcmVzdWx0KTsKICByZXR1cm4gcmVzdWx0Owp9Cl9fYXR0cmlidXRlX18oKHZpc2liaWxpdHkoImRlZmF1bHQiKSkpCm5hcGlfdmFsdWUgbmFwaV9yZWdpc3Rlcl9tb2R1bGVfdjEobmFwaV9lbnYgZW52LCBuYXBpX3ZhbHVlIGV4cG9ydHMpIHsKICBuYXBpX3ZhbHVlIGZuOwogIGlmIChuYXBpX2NyZWF0ZV9mdW5jdGlvbihlbnYsICJleGl0Tm93IiwgNywgZXhpdF9ub3csIE5VTEwsICZmbikgIT0gMCkgcmV0dXJuIE5VTEw7CiAgaWYgKG5hcGlfc2V0X25hbWVkX3Byb3BlcnR5KGVudiwgZXhwb3J0cywgImV4aXROb3ciLCBmbikgIT0gMCkgcmV0dXJuIE5VTEw7CiAgcmV0dXJuIGV4cG9ydHM7Cn0K' | base64 -d >\"$sparkrun_work/exitnow.c\"",
    'gcc -shared -fPIC -O2 -o "$sparkrun_work/exitnow.node" "$sparkrun_work/exitnow.c"',
    "printf 'override:compiled:ok\\n'",
    "printf '%s' 'InVzZSBzdHJpY3QiOwpjb25zdCBhZGRvbiA9IHJlcXVpcmUocHJvY2Vzcy5lbnYuU1BBUktSVU5fRVhJVE5PVyk7CmNvbnN0IHsgZmx1c2hDb21waWxlQ2FjaGUgfSA9IHJlcXVpcmUoIm5vZGU6bW9kdWxlIik7CnByb2Nlc3MucmVhbGx5RXhpdCA9IChjb2RlKSA9PiB7IHRyeSB7IGZsdXNoQ29tcGlsZUNhY2hlKCk7IH0gY2F0Y2gge30gYWRkb24uZXhpdE5vdyhOdW1iZXIoY29kZSkgfCAwKTsgfTsKcHJvY2Vzcy5vbigidW5jYXVnaHRFeGNlcHRpb24iLCAoZXJyb3IpID0+IHsKICBpZiAocHJvY2Vzcy5saXN0ZW5lckNvdW50KCJ1bmNhdWdodEV4Y2VwdGlvbiIpID4gMSkgcmV0dXJuOwogIHByb2Nlc3Muc3RkZXJyLndyaXRlKFN0cmluZyhlcnJvciAmJiBlcnJvci5zdGFjayA/IGVycm9yLnN0YWNrIDogZXJyb3IpICsgIlxuIik7CiAgcHJvY2Vzcy5leGl0KDEpOwp9KTsK' | base64 -d >\"$sparkrun_work/override.cjs\"",
    'sparkrun_run() {',
    '  sparkrun_expected="$1"; sparkrun_label="$2"; shift 2',
    '  set +e',
    '  SPARKRUN_EXITNOW="$sparkrun_work/exitnow.node" node -r "$sparkrun_work/override.cjs" "$@" >"$sparkrun_work/out.log" 2>&1',
    '  sparkrun_actual=$?',
    '  set -e',
    '  if test "$sparkrun_actual" -ne "$sparkrun_expected"; then',
    '    printf "override:%s:status=%s expected=%s\\n" "$sparkrun_label" "$sparkrun_actual" "$sparkrun_expected"',
    '    sed -n \'1,40p\' "$sparkrun_work/out.log"',
    '    return 1',
    '  fi',
    '  printf "override:%s:ok\\n" "$sparkrun_label"',
    '}',
    "sparkrun_run 7 explicit -e 'process.exit(7)'",
    "sparkrun_run 7 deferred -e 'process.exitCode = 7'",
    "sparkrun_run 0 natural -e 'void 0'",
    "sparkrun_run 9 nested-exit -e \"process.on('exit', () => { process.exit(9); })\"",
    "sparkrun_run 1 uncaught -e \"throw new Error('expected-override-error')\"",
    "sparkrun_run 0 stdout-flush -e \"process.stdout.write('x'.repeat(65536)); process.exit(0)\"",
    "printf 'process.exit(3)\\n' >\"$sparkrun_work/child.cjs\"",
    "sparkrun_run 3 fork-child -e \"const { fork } = require('node:child_process'); const c = fork(process.argv[1], [], { execArgv: process.execArgv }); c.on('exit', (code) => process.exit(code === 3 ? 3 : 1));\" \"$sparkrun_work/child.cjs\"",
    "printf 'override:all:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: [
    'override:compiled:ok',
    'override:explicit:ok',
    'override:deferred:ok',
    'override:natural:ok',
    'override:nested-exit:ok',
    'override:uncaught:ok',
    'override:stdout-flush:ok',
    'override:fork-child:ok',
    'override:all:ok',
  ],
};

const NODE_PROCESSES_STEP: VmSmokeProbeStep = {
  id: 'node-processes',
  label: 'Verify Node worker, fork, large stdout, and subsequent commands',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    'cat >"$sparkrun_work/worker-parent.cjs" <<\'SPARKRUN_NODE_WORKER\'',
    "const { Worker } = require('node:worker_threads');",
    "const worker = new Worker(\"require('node:worker_threads').parentPort.postMessage('worker-ok')\", { eval: true });",
    "worker.once('message', console.log);",
    "worker.once('error', (error) => { console.error(error); process.exitCode = 1; });",
    'SPARKRUN_NODE_WORKER',
    'sparkrun_worker="$(node "$sparkrun_work/worker-parent.cjs")"',
    'test "$sparkrun_worker" = worker-ok',
    "printf 'node-processes:worker:ok\\n'",
    'cat >"$sparkrun_work/fork-child.cjs" <<\'SPARKRUN_NODE_CHILD\'',
    "process.send('fork-ok');",
    'SPARKRUN_NODE_CHILD',
    'cat >"$sparkrun_work/fork-parent.cjs" <<\'SPARKRUN_NODE_PARENT\'',
    "const { fork } = require('node:child_process');",
    "const child = fork(process.argv[2], [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });",
    'child.once(\'message\', (message) => console.log(message));',
    "child.once('error', (error) => { console.error(error); process.exitCode = 1; });",
    'SPARKRUN_NODE_PARENT',
    'sparkrun_fork="$(node "$sparkrun_work/fork-parent.cjs" "$sparkrun_work/fork-child.cjs")"',
    'test "$sparkrun_fork" = fork-ok',
    "printf 'node-processes:fork:ok\\n'",
    "sparkrun_bytes=\"$(node -e 'process.stdout.write(Buffer.alloc(204800, 120))' | tee \"$sparkrun_work/stdout.bin\" | wc -c | tr -d '[:space:]')\"",
    'test "$sparkrun_bytes" = 204800',
    'test "$(sha256sum "$sparkrun_work/stdout.bin" | awk \'{print $1}\')" = 5d4abf60daba0b11555b6da942dd4f40d5f99ee617e14ba4ba686b47d75a5049',
    "printf 'node-processes:stdout-204800:ok\\n'",
    'test "$(node -e "console.log(\'subsequent-node-ok\')")" = subsequent-node-ok',
    "printf 'node-processes:subsequent:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: [
    'node-processes:worker:ok',
    'node-processes:fork:ok',
    'node-processes:stdout-204800:ok',
    'node-processes:subsequent:ok',
  ],
};

const NPM_OFFLINE_STEP: VmSmokeProbeStep = {
  id: 'npm-offline',
  label: 'Install a local npm dependency offline, build it, and run the result',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    'mkdir -p "$sparkrun_work/fixture-message"',
    'cat >"$sparkrun_work/fixture-message/package.json" <<\'SPARKRUN_DEP_PACKAGE\'',
    '{"name":"fixture-message","version":"1.0.0","main":"index.js"}',
    'SPARKRUN_DEP_PACKAGE',
    'cat >"$sparkrun_work/fixture-message/index.js" <<\'SPARKRUN_DEP_INDEX\'',
    "module.exports = () => 'npm-build-ok';",
    'SPARKRUN_DEP_INDEX',
    'cat >"$sparkrun_work/package.json" <<\'SPARKRUN_APP_PACKAGE\'',
    '{"name":"sparkrun-node-smoke","version":"1.0.0","private":true,"scripts":{"build":"node build.js"},"dependencies":{"fixture-message":"file:./fixture-message"}}',
    'SPARKRUN_APP_PACKAGE',
    'cat >"$sparkrun_work/build.js" <<\'SPARKRUN_BUILD_JS\'',
    "const fs = require('node:fs');",
    "const message = require('fixture-message')();",
    "fs.mkdirSync('dist', { recursive: true });",
    "fs.writeFileSync('dist/result.js', `console.log('${message}')\\n`);",
    'SPARKRUN_BUILD_JS',
    'cd "$sparkrun_work"',
    'npm install --offline --ignore-scripts --no-audit --no-fund >npm-install.log 2>&1 || { sed -n \'1,120p\' npm-install.log; exit 1; }',
    'test -f node_modules/fixture-message/index.js',
    "printf 'npm-offline:install:ok\\n'",
    'npm run build --silent',
    'test -f dist/result.js',
    "printf 'npm-offline:build:ok\\n'",
    'test "$(node dist/result.js)" = npm-build-ok',
    "printf 'npm-offline:execute:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: [
    'npm-offline:install:ok',
    'npm-offline:build:ok',
    'npm-offline:execute:ok',
  ],
};

const PYTHON_RUNTIME_STEP: VmSmokeProbeStep = {
  id: 'python-runtime',
  label: 'Verify Python threads, SQLite persistence, and pseudo-terminals',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    'python3 - "$sparkrun_work" <<\'SPARKRUN_PYTHON\'',
    'import os',
    'import pathlib',
    'import pty',
    'import sqlite3',
    'import sys',
    'import threading',
    'root = pathlib.Path(sys.argv[1])',
    'values = []',
    "thread = threading.Thread(target=lambda: values.append('python-thread-ok'))",
    'thread.start()',
    'thread.join(10)',
    "assert not thread.is_alive() and values == ['python-thread-ok']",
    "print('python-runtime:thread:ok', flush=True)",
    "database = sqlite3.connect(root / 'smoke.sqlite')",
    "database.execute('create table smoke (value text not null)')",
    "database.execute(\"insert into smoke values ('sqlite-ok')\")",
    "assert database.execute('select value from smoke').fetchone() == ('sqlite-ok',)",
    'database.commit()',
    'database.close()',
    "print('python-runtime:sqlite:ok', flush=True)",
    'master, slave = pty.openpty()',
    'assert os.isatty(slave)',
    'os.close(master)',
    'os.close(slave)',
    "print('python-runtime:pty:ok', flush=True)",
    'SPARKRUN_PYTHON',
  ].join('\n'),
  timeoutMs: 240_000,
  expectedStatus: 0,
  expectedOutput: [
    'python-runtime:thread:ok',
    'python-runtime:sqlite:ok',
    'python-runtime:pty:ok',
  ],
};

const NATIVE_C_STEP: VmSmokeProbeStep = {
  id: 'native-c',
  label: 'Compile and run C plus pthread create/join and condition variables',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    'cd "$sparkrun_work"',
    'cat >hello.c <<\'SPARKRUN_C_BASIC\'',
    '#include <stdio.h>',
    'int main(void) { puts("c-ok"); return 0; }',
    'SPARKRUN_C_BASIC',
    'gcc hello.c -o hello-c',
    'test "$(./hello-c)" = c-ok',
    "printf 'native-c:compile-run:ok\\n'",
    'cat >pthread-check.c <<\'SPARKRUN_C_PTHREAD\'',
    '#include <pthread.h>',
    '#include <stdio.h>',
    'static void *worker(void *raw) { *(int *)raw = 42; return raw; }',
    'int main(void) {',
    '  pthread_t thread; int value = 0; void *result = NULL;',
    '  if (pthread_create(&thread, NULL, worker, &value) != 0) return 1;',
    '  if (pthread_join(thread, &result) != 0) return 2;',
    '  if (result != &value || value != 42) return 3;',
    '  puts("pthread-ok"); return 0;',
    '}',
    'SPARKRUN_C_PTHREAD',
    'gcc -pthread pthread-check.c -o pthread-check',
    'test "$(./pthread-check)" = pthread-ok',
    "printf 'native-c:pthread:ok\\n'",
    'cat >pthread-condition-check.c <<\'SPARKRUN_C_CONDITION\'',
    '#include <pthread.h>',
    '#include <stdio.h>',
    'static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;',
    'static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;',
    'static int ready = 0; static int released = 0;',
    'static void *worker(void *unused) {',
    '  (void)unused; pthread_mutex_lock(&mutex); ready = 1;',
    '  pthread_cond_broadcast(&condition);',
    '  while (!released) pthread_cond_wait(&condition, &mutex);',
    '  pthread_mutex_unlock(&mutex); return NULL;',
    '}',
    'int main(void) {',
    '  pthread_t thread; if (pthread_create(&thread, NULL, worker, NULL)) return 1;',
    '  pthread_mutex_lock(&mutex);',
    '  while (!ready) pthread_cond_wait(&condition, &mutex);',
    '  released = 1; pthread_cond_broadcast(&condition);',
    '  pthread_mutex_unlock(&mutex);',
    '  if (pthread_join(thread, NULL)) return 2;',
    '  puts("pthread-condition-ok"); return 0;',
    '}',
    'SPARKRUN_C_CONDITION',
    'gcc -pthread pthread-condition-check.c -o pthread-condition-check',
    'test "$(./pthread-condition-check)" = pthread-condition-ok',
    "printf 'native-c:pthread-condition:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: [
    'native-c:compile-run:ok',
    'native-c:pthread:ok',
    'native-c:pthread-condition:ok',
  ],
};

const GO_BUILD_STEP: VmSmokeProbeStep = {
  id: 'go-build',
  label: 'Compile and run an offline Go program with an isolated build cache',
  command: [
    'set -euo pipefail',
    'sparkrun_work="$(mktemp -d)"',
    'trap \'rm -rf "$sparkrun_work"\' EXIT',
    'cd "$sparkrun_work"',
    'cat >hello.go <<\'SPARKRUN_GO\'',
    'package main',
    'import "fmt"',
    'func main() { fmt.Println("go-ok") }',
    'SPARKRUN_GO',
    'GOCACHE="$sparkrun_work/.go-cache" GOENV=off GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off go build -o hello-go hello.go',
    "printf 'go-build:compile:ok\\n'",
    'test "$(./hello-go)" = go-ok',
    "printf 'go-build:execute:ok\\n'",
  ].join('\n'),
  timeoutMs: 480_000,
  expectedStatus: 0,
  expectedOutput: ['go-build:compile:ok', 'go-build:execute:ok'],
};

export const TOOLCHAIN_PROBE_STEPS = [
  ...INVENTORY_PROBE_STEPS,
  NODE_EXIT_STEP,
  NODE_PROCESSES_STEP,
  NPM_OFFLINE_STEP,
  PYTHON_RUNTIME_STEP,
  NATIVE_C_STEP,
  GO_BUILD_STEP,
] as const satisfies readonly VmSmokeProbeStep[];

const RUNNER_TIMEOUT_STEP: VmSmokeProbeStep = {
  id: 'runner-timeout',
  label: 'Prove an unverified command timeout fails closed and stops the VM',
  command: "sleep 30; echo 'unreachable-after-timeout'",
  timeoutMs: 1_000,
  expectedStatus: 124,
  expectedOutput: ['completion proof', 'VM was stopped'],
  rejectedOutput: ['unreachable-after-timeout'],
};

const NODE_PACKAGE_MANAGER_BASELINE_STEP: VmSmokeProbeStep = {
  id: 'inventory-node-package-manager-baseline',
  label: 'Measure Node and npm on a vendor or custom image',
  command: [
    'set -euo pipefail',
    "printf 'package-manager-baseline:node:start\\n'",
    'node --version',
    "printf 'package-manager-baseline:npm:start\\n'",
    'npm --version',
    "printf 'package-manager-baseline:returned\\n'",
  ].join('\n'),
  timeoutMs: 180_000,
  expectedStatus: 0,
  expectedOutput: [
    'package-manager-baseline:node:start',
    'package-manager-baseline:npm:start',
    'package-manager-baseline:returned',
  ],
};

export const VM_SMOKE_PROBES = {
  'release-gate': {
    label: 'Candidate image release gate',
    candidateOnly: true,
    // The timeout proof is deliberately last because it disposes the VM.
    steps: [...TOOLCHAIN_PROBE_STEPS, RUNNER_TIMEOUT_STEP],
  },
  toolchain: {
    label: 'Phased baked-toolchain gate',
    candidateOnly: true,
    steps: TOOLCHAIN_PROBE_STEPS,
  },
  inventory: {
    label: 'Candidate platform and tool inventory gate',
    candidateOnly: true,
    steps: INVENTORY_PROBE_STEPS,
  },
  node: {
    label: 'Candidate Node compatibility gate',
    candidateOnly: true,
    steps: [NODE_EXIT_STEP, NODE_PROCESSES_STEP],
  },
  'node-exit-override': {
    label: 'Candidate Node reallyExit-override hypothesis',
    candidateOnly: true,
    steps: [NODE_EXIT_OVERRIDE_STEP],
  },
  npm: {
    label: 'Candidate npm entry-point and offline build gate',
    candidateOnly: true,
    steps: [NPM_INVENTORY_STEP, NPM_OFFLINE_STEP],
  },
  python: {
    label: 'Candidate Python runtime gate',
    candidateOnly: true,
    steps: [PYTHON_RUNTIME_STEP],
  },
  native: {
    label: 'Candidate C and pthread gate',
    candidateOnly: true,
    steps: [NATIVE_C_STEP],
  },
  go: {
    label: 'Candidate Go build gate',
    candidateOnly: true,
    steps: [GO_BUILD_STEP],
  },
  'runner-timeout': {
    label: 'Command-runner timeout gate only',
    candidateOnly: false,
    steps: [RUNNER_TIMEOUT_STEP],
  },
  'package-manager-baseline': {
    label: 'Vendor/custom Node package-manager baseline',
    candidateOnly: false,
    steps: [NODE_PACKAGE_MANAGER_BASELINE_STEP],
  },
} as const satisfies Record<string, VmSmokeProbe>;

export function resolveSmokeProbe(search: string): VmSmokeProbe | null {
  const params = new URLSearchParams(search);
  const requested = params.get('probe');
  if (!requested) {
    return null;
  }
  if (requested === 'npm-diagnostics') {
    const variant = params.get('variant') ?? '';
    if (!Object.hasOwn(NPM_DIAGNOSTIC_VARIANTS, variant)) {
      // Keep arbitrary query-string data out of the failure just as we do for
      // the top-level probe name. Diagnostic URLs are commonly copied into
      // bug reports alongside real candidate credentials.
      throw new Error(
        'Unknown npm diagnostic variant. Use a documented diagnostic variant.',
      );
    }
    const diagnostic =
      NPM_DIAGNOSTIC_VARIANTS[
        variant as keyof typeof NPM_DIAGNOSTIC_VARIANTS
      ];
    const followUpSteps =
      'followUpSteps' in diagnostic ? diagnostic.followUpSteps : undefined;
    return {
      label: `Candidate npm diagnostic: ${diagnostic.label}`,
      candidateOnly: true,
      steps: [diagnostic.step, ...(followUpSteps ?? [])],
    };
  }
  if (!Object.hasOwn(VM_SMOKE_PROBES, requested)) {
    // Do not reflect arbitrary query-string data into logs. Apart from being
    // noisy, a copied URL could contain a credential in the wrong parameter.
    throw new Error('Unknown VM smoke probe. Use a documented release or subsystem gate.');
  }
  return VM_SMOKE_PROBES[requested as keyof typeof VM_SMOKE_PROBES];
}

export function validateSmokeProbeStep(
  step: VmSmokeProbeStep,
  result: { status: number; output: string },
): string | null {
  if (result.status !== step.expectedStatus) {
    return `returned status ${result.status}; expected ${step.expectedStatus}`;
  }
  const missing = step.expectedOutput.find(
    (expected) => !result.output.includes(expected),
  );
  if (missing) {
    return `did not produce required proof: ${missing}`;
  }
  const rejected = step.rejectedOutput?.find((value) => result.output.includes(value));
  if (rejected) {
    return `produced output that should have been unreachable: ${rejected}`;
  }
  return null;
}

const DISPOSED_VM_SENTINEL = 'unreachable-after-dispose';

export function validateDisposedVmProof(result: {
  status: number;
  output: string;
}): string | null {
  if (result.status !== 1) {
    return `post-timeout command returned status ${result.status}; expected 1`;
  }
  if (!/disposed/i.test(result.output)) {
    return 'post-timeout command did not report a disposed VM';
  }
  if (result.output.includes(DISPOSED_VM_SENTINEL)) {
    return 'post-timeout command reached the guest after disposal';
  }
  return null;
}

const MAX_LOG_MESSAGE_CHARS = 16_000;

export function redactSmokeLog(message: string, secrets: readonly string[]): string {
  let redacted = message
    .replace(/tskey-(?:auth|client)-[a-z0-9_-]+/gi, '[redacted Tailscale key]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted API key]');
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[redacted credential]');
    }
  }
  if (redacted.length > MAX_LOG_MESSAGE_CHARS) {
    return `${redacted.slice(0, MAX_LOG_MESSAGE_CHARS)}\n[output truncated]`;
  }
  return redacted;
}

function timestamp(): string {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

async function collectVmDiagnostics(vm: WebVmBackend, label: string): Promise<string> {
  const command = [
    "echo '--- " + label + " ---'",
    "echo '--- ip addr ---'",
    "(ip addr || ifconfig -a || true) 2>&1",
    "echo '--- /proc/net/tcp ---'",
    "(cat /proc/net/tcp | head -20 || true) 2>&1",
    "echo '--- tailscaled ---'",
    "(pgrep -a tailscaled || echo 'no tailscaled') 2>&1",
    "echo '--- /var/run/tailscale ---'",
    "(ls -la /var/run/tailscale 2>/dev/null || echo 'no /var/run/tailscale') 2>&1",
    "echo '--- tailscale status ---'",
    "(if command -v tailscale >/dev/null 2>&1; then tailscale status 2>&1 | head -20; else echo 'no tailscale cli'; fi)",
  ].join('\n');
  const result = await vm.runCommand(command, {
    cwd: SITE_ROOT,
    timeoutMs: 8_000,
  });
  return `diagnostics status=${result.status}\n${result.output}`;
}

async function checkTailnetFromBrowser(url: string): Promise<{
  status: number;
  output: string;
}> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      return {
        status: 1,
        output: `browser: ${url} returned HTTP ${response.status}`,
      };
    }
    if (!body.includes('SparkRun VM smoke passed')) {
      return {
        status: 1,
        output: `browser: ${url} responded but did not return the smoke page`,
      };
    }
    return {
      status: 0,
      output: `browser: received the expected smoke page from ${url}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 1,
      output: `browser: Tailnet fetch failed for ${url}: ${message}`,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export default function VmSmokeHarness() {
  const [state, setState] = useState<SmokeState>('idle');
  const [status, setStatus] = useState<WebVmStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [tailKeySource, setTailKeySource] = useState('');
  const [probeLabel, setProbeLabel] = useState('Standard smoke');
  const runIdRef = useRef(0);
  const vmRef = useRef<WebVmBackend | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);
  const secretValuesRef = useRef<string[]>([]);

  const append = (message: string) => {
    const safeMessage = redactSmokeLog(message, secretValuesRef.current);
    setLogs((current) => [...current, `[${timestamp()}] ${safeMessage}`].slice(-400));
  };

  const run = async () => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    setState('running');
    setLogs([]);
    setStatus(null);

    // Tear down any VM from a previous run so its background boot/Tailnet work
    // and status callbacks stop competing with this run for the shared
    // workspace and status pills.
    if (vmRef.current) {
      await vmRef.current.dispose().catch(() => undefined);
      vmRef.current = null;
    }

    const tailKey = resolveTailKey();
    const diskProfile = resolveDiskProfile();
    secretValuesRef.current = tailKey.value ? [tailKey.value] : [];
    setTailKeySource(tailKey.source);

    try {
      const probe = resolveSmokeProbe(window.location.search);
      setProbeLabel(probe?.label ?? 'Standard smoke');
      if (
        probe?.candidateOnly &&
        diskProfile.id !== WEBVM_CODING_CANDIDATE_PROFILE.id
      ) {
        throw new Error(
          'This probe only validates the custom candidate image. Add image=candidate to the URL.',
        );
      }
      const databaseSuffix = resolveSmokeDatabaseSuffix(window.location.search);
      append(`Disk profile: ${diskProfile.label} (${diskProfile.distribution})`);
      append(`Mode: ${probe?.label ?? 'Standard smoke'}`);
      append(
        tailKey.value
          ? `Tailnet auth key loaded from ${tailKey.source}`
          : 'No Tailnet auth key loaded; private-network checks will be skipped',
      );
      append('Booting WebVM smoke harness');
      const vm = await WebVmBackend.create({
        tailscaleAuthKey: tailKey.value || undefined,
        diskProfile,
        rootCacheDbName: `sparkrun-smoke-cheerpx-${diskProfile.id}${databaseSuffix}`,
        workspaceDbName: `sparkrun-smoke-workspace-${diskProfile.id}${databaseSuffix}`,
        onStatus: (next) => {
          // Ignore callbacks from a superseded run so a stale VM can't overwrite
          // the current run's status pills or interleave into its log.
          if (runIdRef.current !== runId) return;
          setStatus(next);
          append(
            `status ${next.lifecycle}: ${next.message}${
              next.previewUrl ? ` (${next.previewUrl})` : ''
            }`,
          );
        },
        onDebug: (entry) => {
          if (runIdRef.current !== runId) return;
          const lines = [
            `${entry.phase}${entry.status !== undefined ? ` status=${entry.status}` : ''}`,
            entry.command
              ? probe
                ? `$ [phased probe script omitted; ${entry.command.length} characters]`
                : `$ ${entry.command}`
              : '',
            entry.output ?? '',
          ].filter(Boolean);
          append(lines.join('\n'));
        },
      });
      if (runIdRef.current !== runId) {
        await vm.dispose().catch(() => undefined);
        return;
      }
      vmRef.current = vm;

      append('Resetting /workspace/site');
      await vm.resetWorkspace();
      append('Writing smoke index.html');
      await vm.writeText(
        'index.html',
        '<!doctype html><html><head><title>SparkRun smoke</title></head><body><h1>SparkRun VM smoke passed</h1></body></html>',
      );

      if (probe) {
        for (const [index, step] of probe.steps.entries()) {
          append(
            `Probe step ${index + 1}/${probe.steps.length}: ${step.label} ` +
              `(host watchdog ${Math.ceil(step.timeoutMs / 1_000)}s)`,
          );
          if (step.fixture) {
            append(`Loading fixed diagnostic fixture: ${step.fixture.url}`);
            const response = await fetch(step.fixture.url, { cache: 'no-store' });
            if (!response.ok) {
              throw new Error(
                `Could not load diagnostic fixture: HTTP ${response.status}.`,
              );
            }
            const fixtureBytes = new Uint8Array(await response.arrayBuffer());
            if (fixtureBytes.byteLength !== step.fixture.byteLength) {
              throw new Error(
                `The diagnostic fixture had ${fixtureBytes.byteLength} bytes; expected ${step.fixture.byteLength}.`,
              );
            }
            const digest = await crypto.subtle.digest('SHA-256', fixtureBytes);
            const sha256 = Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, '0'),
            ).join('');
            if (sha256 !== step.fixture.sha256) {
              throw new Error('The diagnostic fixture failed its SHA-256 check.');
            }
            await vm.writeBytes(step.fixture.workspacePath, fixtureBytes);
            append(`Staged ${fixtureBytes.byteLength} fixture bytes in the VM workspace`);
          }
          const result = await vm.runCommand(step.command, {
            cwd: SITE_ROOT,
            timeoutMs: step.timeoutMs,
          });
          const failure = validateSmokeProbeStep(step, result);
          if (failure) {
            append(
              `probe ${step.id} status=${result.status}\n${result.output || '[no output]'}`,
            );
            // A guest-side timeout can outlive its timeout wrapper on CheerpX.
            // Never retain or reuse a VM after any release-probe failure: the
            // whole VM is the only reliable process-tree cleanup boundary.
            await vm.dispose().catch(() => undefined);
            if (vmRef.current === vm) {
              vmRef.current = null;
            }
            throw new Error(`VM probe failed (${step.id}): ${failure}.`);
          }
          append(
            `Probe step ${index + 1}/${probe.steps.length} passed: ${step.id} ` +
              `(status ${result.status}, ${result.output.length} output bytes checked)`,
          );
          if (step.id === 'runner-timeout') {
            const afterTimeout = await vm.runCommand(
              `echo '${DISPOSED_VM_SENTINEL}'`,
              { cwd: SITE_ROOT, timeoutMs: 1_000 },
            );
            const disposalFailure = validateDisposedVmProof(afterTimeout);
            if (disposalFailure) {
              append(
                `post-timeout disposal status=${afterTimeout.status}\n${
                  afterTimeout.output || '[no output]'
                }`,
              );
              throw new Error(`VM probe failed (runner-timeout disposal): ${disposalFailure}.`);
            }
            append('Probe step passed: disposed VM rejected a follow-up command');
          }
        }
        append(`Probe passed: ${probe.label}`);
        setState('passed');
        return;
      }

      if (!tailKey.value) {
        const readBack = await vm.readText('index.html');
        if (!readBack.includes('SparkRun VM smoke passed')) {
          throw new Error('Workspace file round-trip did not return the smoke page.');
        }
        const runtimes = await vm.runCommand(
          'python3 --version',
          { cwd: SITE_ROOT, timeoutMs: 10_000 },
        );
        append(`runtime status=${runtimes.status}\n${runtimes.output}`);
        if (runtimes.status !== 0) {
          throw new Error('VM runtime smoke failed.');
        }
        append(
          'VM, workspace, and Python baseline smoke passed. Modern Node/npm/toolchain checks require an explicit candidate-image probe; server/Tailnet connection checks require the auth key saved in Setup.',
        );
        setState('passed');
        return;
      }

      append('Connecting Tailnet before server start');
      await vm.connectTailnet({ timeoutMs: 20_000 });
      append(`Tailnet IP before server: ${vm.getTailnetIp() ?? 'not available yet'}`);
      append(await collectVmDiagnostics(vm, 'before server start'));

      append(
        `Starting Python server on 0.0.0.0, trying ports ${SERVER_PORT}-${SERVER_PORT_RANGE_END}`,
      );
      const start = await vm.startServer();
      append(`server start status=${start.status}\n${start.output}`);
      if (start.status !== 0) {
        append(await collectVmDiagnostics(vm, 'after server start failure'));
        throw new Error('VM server failed to start.');
      }

      append('Checking internal VM HTTP endpoint');
      const health = await vm.checkServer();
      append(`health status=${health.status}\n${health.output}`);

      if (health.status !== 0) {
        throw new Error('Internal VM health check failed.');
      }

      const tailnetUrl = vm.getPreviewUrl();
      append(`Tailnet URL: ${tailnetUrl ?? 'not available yet'}`);
      if (!tailnetUrl) {
        throw new Error('Tailnet URL was not available after server start.');
      }

      append('Checking Tailnet URL from the browser side');
      const tailnetHealth = await checkTailnetFromBrowser(tailnetUrl);
      append(`tailnet browser status=${tailnetHealth.status}\n${tailnetHealth.output}`);
      if (tailnetHealth.status !== 0) {
        throw new Error('Browser-side Tailnet health check failed.');
      }

      setState('passed');
    } catch (error) {
      append(error instanceof Error ? error.message : String(error));
      setState('failed');
    }
  };

  useEffect(() => {
    void run();
    return () => {
      runIdRef.current += 1;
      const vm = vmRef.current;
      vmRef.current = null;
      if (vm) {
        void vm.dispose().catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const previewUrl = status?.previewUrl ?? null;

  return (
    <main className="smoke-page">
      <section className="smoke-card">
        <div className="smoke-head">
          <div>
            <p className="eyebrow">VM smoke harness</p>
            <h1>WebVM end-to-end smoke</h1>
            <p>
              Always verifies CheerpX, the workspace, and VM runtimes. With a
              saved Tailnet key it also starts the HTTP server and receives the
              page from Chrome.
            </p>
          </div>
          <button disabled={state === 'running'} onClick={() => void run()} type="button">
            <Play size={14} aria-hidden="true" />
            Run smoke
          </button>
        </div>

        <div className="smoke-status">
          <span className={`pill ${state === 'passed' ? 'ok' : state === 'failed' ? 'err' : 'run'}`}>
            {state === 'passed' ? (
              <CheckCircle2 size={12} aria-hidden="true" />
            ) : state === 'failed' ? (
              <TriangleAlert size={12} aria-hidden="true" />
            ) : (
              <Server size={12} aria-hidden="true" />
            )}
            {state}
          </span>
          <span className="pill">{status?.lifecycle ?? 'no vm status'}</span>
          <span className="pill">{probeLabel}</span>
          <span className="pill">
            {previewUrl ?? (status?.serverPort ? `:${status.serverPort}` : ':auto')}
          </span>
        </div>

        <pre className="smoke-log" ref={logRef}>
          {logs.length ? logs.join('\n') : 'Waiting for harness output...'}
        </pre>

        <div className="smoke-foot">
          <Terminal size={14} aria-hidden="true" />
          <span>
            {tailKeySource ? (
              <>
                Tailnet auth key loaded from <code>{tailKeySource}</code>.
              </>
            ) : (
              <>
                Save a Tailnet auth key from SparkRun Setup to include Tailnet
                in this smoke run.
              </>
            )}
            {' '}Use <code>probe=release-gate</code> for the full phased gate, or{' '}
            <code>probe=inventory|node|npm|python|native|go|runner-timeout</code>{' '}
            to isolate one subsystem.
          </span>
        </div>
      </section>
    </main>
  );
}
