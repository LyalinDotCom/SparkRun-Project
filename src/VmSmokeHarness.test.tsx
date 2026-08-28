import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_PROBE_STEPS,
  INVENTORY_TOOL_STEPS,
  NPM_DIAGNOSTIC_VARIANTS,
  TOOLCHAIN_PROBE_STEPS,
  VM_SMOKE_PROBES,
  redactSmokeLog,
  resolveSmokeDatabaseSuffix,
  resolveSmokeProbe,
  validateDisposedVmProof,
  validateSmokeProbeStep,
} from './VmSmokeHarness';

describe('VM smoke probe selection', () => {
  it('keeps the ordinary smoke path probe-free', () => {
    expect(resolveSmokeProbe('?vm-smoke&image=candidate')).toBeNull();
  });

  it('exposes a phased candidate gate and focused subsystem gates', () => {
    expect(resolveSmokeProbe('?vm-smoke&probe=release-gate')).toBe(
      VM_SMOKE_PROBES['release-gate'],
    );
    expect(
      VM_SMOKE_PROBES['release-gate'].steps.slice(0, INVENTORY_PROBE_STEPS.length),
    ).toEqual(INVENTORY_PROBE_STEPS);
    expect(
      VM_SMOKE_PROBES['release-gate'].steps
        .slice(INVENTORY_PROBE_STEPS.length)
        .map((step) => step.id),
    ).toEqual([
      'node-exit',
      'node-processes',
      'npm-offline',
      'python-runtime',
      'native-c',
      'go-build',
      'runner-timeout',
    ]);
    expect(VM_SMOKE_PROBES.toolchain.steps).toEqual(TOOLCHAIN_PROBE_STEPS);
    expect(VM_SMOKE_PROBES.inventory.steps).toEqual(INVENTORY_PROBE_STEPS);
    expect(VM_SMOKE_PROBES.node.steps.map((step) => step.id)).toEqual([
      'node-exit',
      'node-processes',
    ]);
    expect(VM_SMOKE_PROBES.python.steps[0]?.id).toBe('python-runtime');
    expect(VM_SMOKE_PROBES.native.steps[0]?.id).toBe('native-c');
    expect(VM_SMOKE_PROBES.go.steps[0]?.id).toBe('go-build');
    expect(resolveSmokeProbe('?probe=runner-timeout')).toBe(
      VM_SMOKE_PROBES['runner-timeout'],
    );
  });

  it('keeps every toolchain subsystem candidate-only and independently bounded', () => {
    for (const name of ['toolchain', 'inventory', 'node', 'npm', 'python', 'native', 'go'] as const) {
      expect(VM_SMOKE_PROBES[name].candidateOnly).toBe(true);
    }
    for (const step of TOOLCHAIN_PROBE_STEPS) {
      expect(step.timeoutMs).toBeGreaterThan(0);
      expect(step.timeoutMs).toBeLessThanOrEqual(480_000);
      expect(step.expectedOutput.length).toBeGreaterThan(0);
      expect(step.command).not.toContain('sparkrun-toolchain-check --json --smoke');
    }
  });

  it('keeps every generated guest script valid Bash', () => {
    const diagnosticSteps = Object.values(NPM_DIAGNOSTIC_VARIANTS).map(
      ({ step }) => step,
    );
    const steps = [
      ...VM_SMOKE_PROBES['release-gate'].steps,
      ...diagnosticSteps,
    ];
    const checked = spawnSync('bash', ['-n'], {
      encoding: 'utf8',
      input: steps
        .map((step) => `# SparkRun syntax probe: ${step.id}\n${step.command}\n`)
        .join('\n'),
    });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('rejects an unknown probe without reflecting its query value', () => {
    const leakedValue = ['tskey', 'auth', 'should-never-be-reflected'].join('-');
    expect(() => resolveSmokeProbe(`?probe=${leakedValue}`)).toThrow(
      'Unknown VM smoke probe',
    );
    try {
      resolveSmokeProbe(`?probe=${leakedValue}`);
    } catch (error) {
      expect(String(error)).not.toContain(leakedValue);
    }
  });

  it('allowlists one candidate-only npm diagnostic step per page run', () => {
    expect(Object.keys(NPM_DIAGNOSTIC_VARIANTS).sort()).toEqual([
      'bundled-cli',
      'cache-disabled',
      'direct-cli',
      'explicit-flush',
      'lifecycle-marker',
      'node-script',
      'node-script-jitless',
      'npm-graph',
      'npm-graph-no-cache',
      'npm-package',
      'pnpm-version',
      'staged-archive',
      'stream-callback',
      'volatile-cache',
      'yarn-version',
    ]);
    for (const [variant, diagnostic] of Object.entries(
      NPM_DIAGNOSTIC_VARIANTS,
    )) {
      const { step } = diagnostic;
      const probe = resolveSmokeProbe(
        `?vm-smoke&probe=npm-diagnostics&variant=${variant}`,
      );
      expect(probe?.candidateOnly).toBe(true);
      const expectedSteps =
        'followUpSteps' in diagnostic
          ? [step, ...diagnostic.followUpSteps]
          : [step];
      expect(probe?.steps).toEqual(expectedSteps);
      expect(step.id).toBe(`npm-diagnostic-${variant}`);
      expect(step.timeoutMs).toBe(
        variant === 'staged-archive' || variant === 'node-script-jitless'
          ? 120_000
          : variant === 'bundled-cli'
            ? 60_000
            : variant === 'pnpm-version' || variant === 'yarn-version'
              ? 120_000
            : 180_000,
      );
      expect(step.command).not.toContain('/usr/bin/timeout');
      expect(step.command).not.toContain('/usr/bin/setsid');
    }
  });

  it('rejects missing or unknown npm diagnostic variants without reflection', () => {
    expect(() => resolveSmokeProbe('?probe=npm-diagnostics')).toThrow(
      'Unknown npm diagnostic variant',
    );
    const leakedValue = 'tskey-auth-diagnostic-secret';
    expect(() =>
      resolveSmokeProbe(
        `?probe=npm-diagnostics&variant=${encodeURIComponent(leakedValue)}`,
      ),
    ).toThrow('Unknown npm diagnostic variant');
    try {
      resolveSmokeProbe(
        `?probe=npm-diagnostics&variant=${encodeURIComponent(leakedValue)}`,
      );
    } catch (error) {
      expect(String(error)).not.toContain(leakedValue);
    }
  });

  it('keeps cheap npm phase controls and lifecycle diagnostics observable', () => {
    expect(NPM_DIAGNOSTIC_VARIANTS['node-script'].step.command).toContain(
      `node -e 'console.log("MARK:NODE_SCRIPT")'`,
    );
    expect(NPM_DIAGNOSTIC_VARIANTS['npm-package'].step.command).toContain(
      `node -p 'require("/usr/lib/node_modules/npm/package.json").version'`,
    );
    expect(NPM_DIAGNOSTIC_VARIANTS['npm-graph'].step.command).toContain(
      'require("/usr/lib/node_modules/npm/lib/npm.js")',
    );
    expect(
      NPM_DIAGNOSTIC_VARIANTS['npm-graph-no-cache'].step.command,
    ).toContain('NODE_DISABLE_COMPILE_CACHE=1 node -e');
    const staged = NPM_DIAGNOSTIC_VARIANTS['staged-archive'].step;
    expect(staged.fixture).toEqual({
      url: 'http://127.0.0.1:4174/npm-runtime-clean.tar.gz',
      workspacePath: '.sparkrun-diagnostics/npm-runtime.tar.gz',
      byteLength: 2_210_129,
      sha256: '978dd98b052e572f2f1289ce7bdcfa36be7b9ab49a8bf4bc4013ef7e51f93c1a',
    });
    expect(staged.command).toContain('/tmp/sparkrun-npm-stage/npm/lib/npm.js');
    expect(staged.expectedOutput).toContain('MARK:ARCHIVE_EXTRACTED');
    const stagedFollowUps =
      NPM_DIAGNOSTIC_VARIANTS['staged-archive'].followUpSteps;
    expect(stagedFollowUps).toHaveLength(2);
    expect(stagedFollowUps[0].timeoutMs).toBe(60_000);
    expect(stagedFollowUps[0].expectedOutput).toContain(
      'MARK:STAGED_NPM_FIRST_RETURNED',
    );
    expect(stagedFollowUps[1].timeoutMs).toBe(30_000);
    expect(stagedFollowUps[1].expectedOutput).toContain(
      'MARK:STAGED_NPM_SECOND_RETURNED',
    );
    const bundled = NPM_DIAGNOSTIC_VARIANTS['bundled-cli'];
    expect(bundled.step.fixture).toEqual({
      url: 'http://127.0.0.1:4174/npm-cli-static.cjs',
      workspacePath: '.sparkrun-diagnostics/npm-cli-static.cjs',
      byteLength: 3_816_642,
      sha256: '16689c3d9ea96df5137a553e948d1417579325128fdfdd6affc317d1586ded18',
    });
    expect(bundled.step.expectedOutput).toContain(
      'MARK:BUNDLED_NPM_FIRST_RETURNED',
    );
    expect(bundled.followUpSteps[0].timeoutMs).toBe(30_000);
    expect(NPM_DIAGNOSTIC_VARIANTS['pnpm-version'].step.command).toContain(
      'pnpm --version',
    );
    expect(
      NPM_DIAGNOSTIC_VARIANTS['pnpm-version'].followUpSteps[0].timeoutMs,
    ).toBe(30_000);
    expect(NPM_DIAGNOSTIC_VARIANTS['yarn-version'].step.command).toContain(
      'yarn --version',
    );

    const lifecycle = NPM_DIAGNOSTIC_VARIANTS['lifecycle-marker'].step.command;
    expect(lifecycle).toContain("mark('BEFORE_CLI')");
    expect(lifecycle).toContain("mark('CLI_PROMISE_RESOLVED')");
    expect(lifecycle).toContain('PROCESS_EXIT:${code}');
    expect(lifecycle).toContain(
      '/usr/bin/node /tmp/sparkrun-npm-lifecycle.cjs --version',
    );
    expect(NPM_DIAGNOSTIC_VARIANTS['stream-callback'].step.command).toContain(
      "process.stderr.write('', () => {",
    );
    expect(NPM_DIAGNOSTIC_VARIANTS['cache-disabled'].step.command).toContain(
      'NODE_DISABLE_COMPILE_CACHE=1 /usr/bin/node',
    );
    expect(NPM_DIAGNOSTIC_VARIANTS['volatile-cache'].step.command).toContain(
      'NODE_COMPILE_CACHE=/tmp/sparkrun-node-cache /usr/bin/node',
    );
    const explicit = NPM_DIAGNOSTIC_VARIANTS['explicit-flush'].step.command;
    expect(explicit).toContain('const { flushCompileCache }');
    expect(explicit).toContain("mark('BEFORE_NPM_LOAD')");
    expect(explicit).toContain('mark(`NPM_LOADED:exec=${String(loaded.exec)}`)');
    expect(explicit).toContain("mark('AFTER_FLUSH')");
  });

  it('allows a bounded package-manager comparison on vendor images', () => {
    const probe = resolveSmokeProbe('?probe=package-manager-baseline');
    expect(probe?.candidateOnly).toBe(false);
    expect(probe?.steps).toHaveLength(1);
    expect(probe?.steps[0].timeoutMs).toBe(180_000);
    expect(probe?.steps[0].command).toContain('npm --version');
    expect(probe?.steps[0].expectedOutput).toContain(
      'package-manager-baseline:returned',
    );
  });
});

describe('VM smoke probe proof validation', () => {
  it('requires every proof emitted by a successful phased step', () => {
    for (const step of TOOLCHAIN_PROBE_STEPS) {
      const output = step.expectedOutput.join('\n');
      expect(
        validateSmokeProbeStep(step, {
          status: step.expectedStatus,
          output,
        }),
      ).toBeNull();
    }
  });

  it('rejects a zero status when even one internal proof is absent', () => {
    const step = TOOLCHAIN_PROBE_STEPS.find(({ id }) => id === 'python-runtime');
    expect(step).toBeDefined();
    const output = step!.expectedOutput.slice(0, -1).join('\n');
    expect(
      validateSmokeProbeStep(step!, {
        status: 0,
        output,
      }),
    ).toContain('python-runtime:pty:ok');
  });

  it('keeps exact versions, compatibility files, and all promised tools in the inventory gate', () => {
    const inventoryProofs = INVENTORY_PROBE_STEPS.flatMap(
      ({ expectedOutput }) => expectedOutput,
    );
    const inventoryCommands = INVENTORY_PROBE_STEPS.map(({ command }) => command).join('\n');
    for (const proof of [
      'inventory:bash:ok',
      'inventory:node:ok',
      'inventory:npm:ok',
      'inventory:python:ok',
      'inventory:go:ok',
      'inventory:gcc:ok',
      'inventory:netcat:ok',
      'inventory:platform-architecture:ok',
      'inventory:compatibility-files:ok',
      'inventory:compatibility-environment:ok',
      'inventory:compatibility-cache:ok',
    ]) {
      expect(inventoryProofs).toContain(proof);
    }
    expect(inventoryCommands).toContain(
      'test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = v24.18.1',
    );
    expect(inventoryCommands).toContain(
      'test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = "Python 3.14.7"',
    );
    expect(inventoryCommands).toContain('node-exit-preload.cjs');
    expect(inventoryCommands).toContain('node-exit-addon.node');
    expect(inventoryCommands).toContain('stat -c %a "$NODE_COMPILE_CACHE"');
  });

  it('uses one outer-harness step per tool without nested guest timeouts', () => {
    expect(INVENTORY_TOOL_STEPS).toHaveLength(32);
    expect(new Set(INVENTORY_TOOL_STEPS.map(({ id }) => id)).size).toBe(32);
    for (const step of INVENTORY_TOOL_STEPS) {
      expect([20_000, 60_000, 360_000]).toContain(step.timeoutMs);
      expect(step.command).not.toContain('/usr/bin/timeout');
      expect(step.command).not.toContain('/usr/bin/setsid');
      expect(step.command).toContain('2>&1 | tee "$sparkrun_output"');
      expect(step.command).toContain('test -s "$sparkrun_output"');
      expect(step.expectedOutput).toHaveLength(1);
    }
  });

  it('runs and identifies the observed npm blocker before the offline npm probe', () => {
    const npm = INVENTORY_TOOL_STEPS.find(
      ({ id }) => id === 'inventory-tool-npm',
    );
    expect(npm).toBeDefined();
    expect(npm!.timeoutMs).toBe(360_000);
    expect(npm!.command).toContain('"npm" "--version" 2>&1 | tee');
    expect(npm!.command).toContain(
      'test "$(sed -n \'1p\' "$sparkrun_output" | tr -d \'\\r\')" = 11.12.1',
    );
    expect(npm!.expectedOutput).toContain('inventory:npm:ok');
    expect(VM_SMOKE_PROBES.npm.steps[0]).toBe(npm);
    expect(VM_SMOKE_PROBES.npm.steps[1]?.id).toBe('npm-offline');
  });

  it('retains each high-risk conformance mechanism as a separate proof', () => {
    const byId = Object.fromEntries(
      TOOLCHAIN_PROBE_STEPS.map((step) => [step.id, step.expectedOutput]),
    );
    expect(byId['node-exit']).toEqual(expect.arrayContaining([
      'node-exit:final-listener:ok',
      'node-exit:nested-exit:ok',
      'node-exit:cache-disabled:ok',
      'node-exit:user-handler-file:ok',
    ]));
    expect(byId['node-processes']).toEqual(expect.arrayContaining([
      'node-processes:worker:ok',
      'node-processes:fork:ok',
      'node-processes:stdout-204800:ok',
      'node-processes:subsequent:ok',
    ]));
    expect(byId['npm-offline']).toEqual(expect.arrayContaining([
      'npm-offline:install:ok',
      'npm-offline:build:ok',
      'npm-offline:execute:ok',
    ]));
    expect(byId['python-runtime']).toEqual(expect.arrayContaining([
      'python-runtime:thread:ok',
      'python-runtime:sqlite:ok',
      'python-runtime:pty:ok',
    ]));
    expect(byId['native-c']).toEqual(expect.arrayContaining([
      'native-c:pthread:ok',
      'native-c:pthread-condition:ok',
    ]));
    expect(byId['go-build']).toEqual(expect.arrayContaining([
      'go-build:compile:ok',
      'go-build:execute:ok',
    ]));
  });

  it('accepts the fail-closed runner timeout proof', () => {
    const step = VM_SMOKE_PROBES['runner-timeout'].steps[0];
    expect(
      validateSmokeProbeStep(step, {
        status: 124,
        output:
          'Command did not produce its completion proof. The VM was stopped to prevent false success.',
      }),
    ).toBeNull();
  });

  it('rejects false success and output after the timeout boundary', () => {
    const step = VM_SMOKE_PROBES['runner-timeout'].steps[0];
    expect(
      validateSmokeProbeStep(step, {
        status: 0,
        output: 'unreachable-after-timeout',
      }),
    ).toContain('expected 124');
    expect(
      validateSmokeProbeStep(step, {
        status: 124,
        output:
          'completion proof missing; VM was stopped; unreachable-after-timeout',
      }),
    ).toContain('should have been unreachable');
  });

  it('requires the timed-out backend to reject a follow-up command as disposed', () => {
    expect(
      validateDisposedVmProof({
        status: 1,
        output: 'The VM has been disposed. Start a fresh VM before running commands.',
      }),
    ).toBeNull();
    expect(
      validateDisposedVmProof({ status: 0, output: 'unreachable-after-dispose' }),
    ).toContain('expected 1');
    expect(validateDisposedVmProof({ status: 1, output: 'generic failure' })).toContain(
      'disposed VM',
    );
  });
});

describe('VM smoke database isolation', () => {
  it('keeps ordinary smoke caches stable unless a run id is supplied', () => {
    expect(resolveSmokeDatabaseSuffix('?vm-smoke', () => 'unused')).toBe('');
    expect(resolveSmokeDatabaseSuffix('?vm-smoke&run=Gate_123', () => 'unused')).toBe(
      '-gate123',
    );
  });

  it('automatically isolates every explicit probe run', () => {
    expect(resolveSmokeDatabaseSuffix('?vm-smoke&probe=release-gate', () => 'ABC-123')).toBe(
      '-probe-abc123',
    );
    expect(
      resolveSmokeDatabaseSuffix(
        '?vm-smoke&probe=release-gate&run=RC3_Final',
        () => 'ABC-123',
      ),
    ).toBe('-rc3final-probe-abc123');
  });

  it('fails closed if a unique probe id cannot be generated', () => {
    expect(() =>
      resolveSmokeDatabaseSuffix('?vm-smoke&probe=release-gate&run=rc3', () => '---'),
    ).toThrow('isolated database name');
  });
});

describe('VM smoke log redaction', () => {
  it('removes known credential shapes and exact runtime secrets', () => {
    const exactSecret = 'opaque-runtime-secret';
    const output = redactSmokeLog(
      `tskey-auth-example_value AIzaabcdefghijklmnopqrstuvwxyz123 ${exactSecret}`,
      [exactSecret],
    );
    expect(output).not.toContain('tskey-auth-example_value');
    expect(output).not.toContain('AIzaabcdefghijklmnopqrstuvwxyz123');
    expect(output).not.toContain(exactSecret);
    expect(output).toContain('[redacted Tailscale key]');
    expect(output).toContain('[redacted API key]');
    expect(output).toContain('[redacted credential]');
  });
});
