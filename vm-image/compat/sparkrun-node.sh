# SparkRun login-shell defaults. Explicit caller values always win.
if [ -z "${NODE_OPTIONS+x}" ]; then
  export NODE_OPTIONS="--require=/usr/local/lib/sparkrun/node-exit-preload.cjs"
fi

if [ -z "${NODE_COMPILE_CACHE+x}" ]; then
  export NODE_COMPILE_CACHE="/usr/local/lib/sparkrun/node-compile-cache"
fi
