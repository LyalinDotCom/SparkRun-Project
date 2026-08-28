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

  // Node resolves the final status before emitting "exit". Record it here so
  // the native cleanup hook preserves natural and explicit failure statuses.
  process.on('exit', (code) => {
    // The native hook exits before Node's later platform cleanup, which also
    // bypasses its automatic compile-cache flush. Persist it explicitly while
    // the JavaScript environment is still valid.
    flushCompileCache();
    addon.setExitCode(code);
  });
}
