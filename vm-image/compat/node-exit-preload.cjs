'use strict';

const { isMainThread } = require('node:worker_threads');
const { flushCompileCache } = require('node:module');

// A worker environment must tear down normally. Installing the native cleanup
// hook there would call _exit() for the whole process when that worker exits.
if (isMainThread) {
  const addonPath =
    process.env.SPARKRUN_NODE_EXIT_ADDON ||
    '/usr/local/lib/sparkrun/node-exit-addon.node';
  const addon = require(addonPath);
  const originalEmit = process.emit;

  const normalizeExitCode = (eventCode, listenerFailed) => {
    // Node reloads process.exitCode after all user "exit" listeners finish.
    // When no value was assigned, a listener exception changes a natural zero
    // exit to status 1. Explicit/deferred assignments (including zero) win.
    const assignedCode = process.exitCode;
    const rawCode = assignedCode === undefined ? eventCode ?? 0 : assignedCode;
    const numericCode = Number(rawCode);
    if (!Number.isInteger(numericCode)) {
      return 1;
    }
    return listenerFailed && assignedCode === undefined && numericCode === 0
      ? 1
      : numericCode;
  };

  const recordFinalExitCode = (eventCode, listenerFailed) => {
    addon.setExitCode(normalizeExitCode(eventCode, listenerFailed));

    // The native hook exits before Node's later platform cleanup, which also
    // bypasses its automatic compile-cache flush. Cache persistence is an
    // optimization, so a flush failure must not corrupt process semantics.
    try {
      flushCompileCache();
    } catch {
      // Deliberately ignored; normal application output/status still wins.
    }
  };

  // A preload listener would run before application listeners and could save
  // a stale code. Wrap the EventEmitter boundary instead: Node invokes every
  // user listener inside this call, then we read the same final exitCode that
  // Node itself reloads before terminating.
  process.emit = function sparkrunEmit(eventName, ...args) {
    if (eventName !== 'exit') {
      return Reflect.apply(originalEmit, this, [eventName, ...args]);
    }

    try {
      const emitted = Reflect.apply(originalEmit, this, [eventName, ...args]);
      recordFinalExitCode(args[0], false);
      return emitted;
    } catch (error) {
      recordFinalExitCode(args[0], true);
      throw error;
    }
  };
}
