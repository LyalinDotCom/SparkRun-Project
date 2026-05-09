# SparkRun

SparkRun is an experiment in what becomes possible when an AI coding agent gets
its own real computer inside the browser.

It proves a strange and powerful loop can work entirely from a web page: boot a
Debian micro-VM in WebAssembly, ask Gemini to write a website, let the model use
real files and shell commands, start a server inside that VM, and publish the
result on a private Tailscale URL you can open like any other site. No remote
build box, no local dev environment, no separate preview service. The browser is
the workspace, the runtime, the file system, the terminal, and the preview host.

The bigger idea is that AI-assisted software creation does not have to be a
chatbot that merely suggests code. It can be a live, inspectable build system
where the model edits files, runs commands, serves the result, preserves project
state, and lets the human jump in through diagnostics or a terminal whenever the
system needs steering.

This repository is not an official product or supported project. It is a
personal exploration and a rough prototype. Use it at your own risk, especially
around API keys, Tailscale auth keys, generated code, browser storage, and
anything connected to your own tailnet.

## How It Works

SparkRun is a hosted React app, but the interesting part is that the browser app
owns the entire build loop:

1. The user enters a Google AI Studio API key and a Tailscale auth key.
2. SparkRun boots CheerpX with a Debian disk image, an IndexedDB-backed root
   cache, an IndexedDB-backed `/workspace`, and an in-memory `/data` staging
   device.
3. Gemini is called through `@google/genai` with tool declarations for reading,
   writing, replacing, listing, and running commands in `/workspace/site`.
4. File writes are staged through CheerpX's `DataDevice` and copied into the VM
   workspace.
5. After generated files exist, SparkRun activates CheerpX's userspace
   Tailscale integration.
6. SparkRun writes a small Python static server script, launches it in the VM,
   waits for server state files under `/tmp/sparkrun`, and checks health.
7. The UI surfaces the Tailnet preview URL, generated files, command log, and
   terminal.

SparkRun currently targets static sites. The agent prompt intentionally asks for
browser-native HTML, CSS, and JavaScript with no install or build step inside the
generated project.

## Try The Live Prototype

The hosted prototype is deployed on Firebase Hosting:

```text
https://spark-run-poc.web.app/
```

To use it, open the live site and provide:

- A Google AI Studio API key that can call the configured Gemini model.
- A Tailscale auth key that is reusable, ephemeral, and pre-approved.
- A browser with IndexedDB enabled.
- A host machine that can reach the same tailnet if you want the browser tab to
  open the VM's `100.x.x.x` preview URL.

From there, describe the website you want. SparkRun will boot the VM, let Gemini
write the site into `/workspace/site`, start the in-VM server, and show the
Tailnet preview URL when it is reachable.

The setup screen can optionally remember keys in browser storage. Leave that off
if you do not want keys persisted in this browser.

## What You Can Build

SparkRun is best suited for small static web projects that can run directly in a
browser:

- Landing pages and product pages.
- Personal sites, portfolios, and one-page demos.
- Static app mockups with HTML, CSS, and browser-native JavaScript.
- Interactive prototypes that do not require a package install or backend.
- Quick visual explorations where seeing the result live matters more than
  producing a production-ready codebase.

It can create and update `index.html`, `style.css`, optional `script.js`, and
nested static assets. It can also run real shell commands in the VM, inspect the
generated files, show diagnostics, and expose an interactive terminal for manual
debugging.

## What The UI Gives You

- A setup screen for project name, model, keys, saved projects, local folder
  attachment, and diagnostics.
- A build screen with a live timeline of model actions, file edits, shell
  commands, health checks, and errors.
- A generated files drawer with file counts and sizes.
- A diagnostics log drawer with VM commands, Tailnet state, server logs, and
  build metadata.
- An interactive VM terminal rooted in `/workspace/site`.
- A retry flow for cases where files were generated but Tailnet did not produce
  an address.
- Reset controls for the in-browser workspace cache and full VM disk cache.

## Current Limitations

- This is a prototype. Keys are entered client-side and are only suitable for
  local or controlled testing. A production version should move provider calls
  behind a server-side flow.
- Generated projects are static websites only.
- Tailnet preview requires a valid Tailscale auth key and browser/host network
  conditions that can reach the VM's tailnet address.
- CheerpX 1.3.1 can emit noisy worker errors related to network events. They
  are captured in diagnostics but are not treated as app failures.
- The generated website workspace is stored in browser IndexedDB, so reset tools
  are part of the normal recovery path.

# Local Setup For Debugging

Most people should use the hosted Firebase build. Local setup is mainly for
debugging SparkRun itself, changing the UI, testing CheerpX behavior, or working
on the VM/Tailnet flow.

Install dependencies:

```sh
npm install
```

Run locally:

```sh
npm run dev
```

Open the Vite URL printed by the dev server.

The active model is configured in `src/lib/constants.ts`:

```ts
export const MODEL_ID = 'gemini-3-flash-preview';
```

The CheerpX package is pinned in `package.json`. Do not change it to `latest`.
The setup screen displays both the installed CheerpX version and the runtime
version parsed from the loaded CheerpX resource URL.

## Development Commands

```sh
npm run dev       # Start Vite on 127.0.0.1
npm run build     # Type-check and build production assets
npm run test      # Run Vitest tests
npm run preview   # Serve the built app locally with Vite preview
```

## Runtime Architecture

The VM workspace is deliberately reset at boot with:

```sh
rm -rf /workspace/site && mkdir -p /workspace/site
```

Generated projects are preserved separately in `localStorage` and restored after
boot. This avoids a known IndexedDB directory corruption mode in CheerpX 1.3.1
where a stale `/workspace/site` inode can appear writable but fail later writes
with `Read-only file system`.

The VM mount layout is:

```text
/           Debian disk image over sparkrun-root-cache IndexedDB
/workspace  sparkrun-workspace IndexedDB
/data       in-memory staging device
/dev        device nodes
/dev/pts    pseudo-terminal support
/proc       process filesystem
/sys        system filesystem
```

Server state is written under `/tmp/sparkrun`, not `/workspace/site`, so the
server can continue to start even if the workspace device becomes read-only
after Tailnet activation.

The app requires cross-origin isolation headers because CheerpX depends on
browser capabilities gated behind COOP/COEP:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite sets these headers in development and preview. Firebase Hosting sets the
same headers in production.

There is also a VM smoke harness available through the main app entry point:

```text
/?vm-smoke
```

The smoke harness boots the VM, writes a minimal HTML file, connects Tailnet,
starts the Python server, checks internal VM HTTP health, and checks the Tailnet
URL from the browser side. It can read a Tailnet key from:

- `?tailkey=...`
- `VITE_TAILSCALE_AUTH_KEY`
- saved browser keys

## Diagnostics

The setup screen includes a Diagnostics card with:

- SparkRun build SHA and timestamp.
- CheerpX version pinned by npm.
- CheerpX version loaded at runtime.
- Workspace reset and full cache reset actions.

The chat screen exposes:

- High-level build timeline.
- Generated files drawer.
- Detailed diagnostics log drawer.
- Interactive VM terminal.
- Tailnet retry flow when the VM has generated files but no Tailnet IP.

A standalone CheerpX diagnostics page is also shipped at:

```text
/diag.html
```

Use it to isolate VM, filesystem, and Tailnet behavior outside the React app.

## Deployment

Build and deploy to Firebase Hosting:

```sh
rm -rf dist
npm run build
firebase deploy --only hosting
```

Always rebuild before deploying. Firebase serves `dist/`, so deploying without a
fresh build can publish stale JavaScript.

After deploying, verify that the live bundle exists in the local build output
and still contains the expected CheerpX version:

```sh
LIVE=$(curl -s https://spark-run-poc.web.app/ | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)
ls dist/assets/$LIVE
curl -s "https://spark-run-poc.web.app/assets/$LIVE" | grep -oE '1\.3\.[0-9]'
```

## Key Files

- `src/App.tsx` - main UI, project state, build orchestration, drawers, and
  diagnostics.
- `src/lib/agent.ts` - Gemini agent loop and function-calling conversation.
- `src/lib/toolSchemas.ts` - tool declarations exposed to Gemini.
- `src/lib/tools.ts` - path normalization, tool execution, and in-memory test
  backend.
- `src/lib/webvm.ts` - CheerpX VM creation, filesystem bridge, Tailscale
  connection, server lifecycle, terminal, and cache reset helpers.
- `src/lib/projects.ts` - saved project persistence.
- `src/lib/localFolder.ts` - File System Access API integration.
- `public/diag.html` - standalone CheerpX diagnostics harness.
- `vite.config.ts` - React/Vite config, cross-origin isolation headers, and
  build metadata injection.
- `firebase.json` - Firebase Hosting configuration and required headers.

## Dependency Credits

SparkRun is built on these projects and services:

- [React](https://react.dev/) and [React DOM](https://react.dev/) for the UI.
- [Vite](https://vite.dev/) and `@vitejs/plugin-react` for local development and
  production builds.
- [TypeScript](https://www.typescriptlang.org/) for typed application code.
- [CheerpX](https://cheerpx.io/) by Leaning Technologies for the browser-hosted
  Debian micro-VM.
- [Google Gen AI SDK](https://github.com/googleapis/js-genai) for Gemini model
  calls and function calling.
- [Tailscale](https://tailscale.com/) for stable private-network preview URLs.
- [lucide-react](https://lucide.dev/) for interface icons.
- [react-markdown](https://github.com/remarkjs/react-markdown) and
  [remark-gfm](https://github.com/remarkjs/remark-gfm) for rendering build
  summaries and log messages.
- [Vitest](https://vitest.dev/), [Testing Library](https://testing-library.com/),
  and [jsdom](https://github.com/jsdom/jsdom) for tests.
- [Firebase Hosting](https://firebase.google.com/docs/hosting) for deployment.
- Python's standard-library `http.server` inside the VM for static file serving.
