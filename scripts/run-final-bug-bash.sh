#!/usr/bin/env bash
set -uo pipefail

PROJECT_DIR="${1:-$(pwd)}"
OUT_DIR="${2:-$PROJECT_DIR/docs/bug-bash/2026-08-28-release-candidate}"
RUN_MODE="${3:-all}"
SKIP_CLAUDE="${SPARKRUN_SKIP_CLAUDE:-0}"

if [[ ! -d "$PROJECT_DIR" ]]; then
  echo "Project directory does not exist: $PROJECT_DIR" >&2
  exit 2
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
mkdir -p "$OUT_DIR/logs" "$OUT_DIR/status"

common_prompt="Use $PROJECT_DIR as the only target project. This is a read-only release review: do not edit files, change git state, install anything, read .env files, or reveal credentials. Ignore .git, node_modules, dist, generated VM images, screenshots, binary files, and $OUT_DIR. Inspect the current working tree, including uncommitted source. Work directly in this process: do not load or invoke a review skill, workflow, subagent, or delegation mechanism. Use no more than 12 focused source-inspection or test calls, then stop inspecting and write the report. Do not narrate a plan or progress. Your stdout is the retained artifact: include the complete report inline and do not write or link to an external report. Distinguish verified bugs from uncertainty. Do not restate documented upstream limitations or accepted product boundaries unless current code mishandles them. In particular, the guest-root shell is intentionally general; do not call its mere ability to read a secret filename a sandbox bypass, but do report a concrete secret that survives the documented redaction/persistence boundary. The explicit initial-plus-eight policy includes interactions.create; the API surface used here has no pre-response ID or idempotency key, so its documented ambiguous-response quota risk is accepted unless you find local tool replay or a new reconciliation mechanism. A mismatched workspace cache is intentionally untrusted and the verified Browser Vault archive remains recoverable; report restore behavior only when it loses trusted-lineage data, invents success, or destroys the verified archive. Return one final Markdown report only. For every actionable finding include severity, file and line, failure mechanism, a concrete reproduction or counterexample, and the smallest credible fix. If no actionable bug is found, say so explicitly."

generic_prompt="$common_prompt

Round 1 — broad independent bug hunt. Audit for release-blocking correctness failures, async races, data loss, false success, security boundary mistakes, API contract errors, and missing tests across the complete SparkRun product. Prefer a few high-confidence findings over generic advice."

mechanism_prompt="$common_prompt

Round 2 — guided mechanism audit. Trace the hard paths end to end: Gemini Interactions background create/get/cancel, exactly eight retries, fresh provider context across user requests and stateful tool continuation within one request, Stop/checkpoint admission ordering, Browser Vault atomicity and restore, project leases/transitions, terminal checkpoint timers, CheerpX command completion and disposal, Tailscale activation, server bind readiness, and outer-Chrome preview truth. Look specifically for callbacks or timers that can cross a teardown boundary, replay non-idempotent work, lose a completed tool result, or report a live server without evidence."

release_prompt="$common_prompt

Round 3 — guided UI, security, and release audit. Review the Codex-inspired workbench for state clarity, keyboard/accessibility regressions, responsive panel behavior, terminal/files/activity correctness, and Stop/retry feedback. Review secret redaction and browser/VM trust boundaries. Then audit tests, build metadata, Firebase headers/deploy scripts, documentation claims, screenshot evidence, and GitHub release hygiene for any path that can ship stale or misleading artifacts."

run_one() {
  local label="$1"
  local agent="$2"
  local model="$3"
  local effort="$4"
  local prompt="$5"
  shift 5
  local report="$OUT_DIR/$label.md"
  local log="$OUT_DIR/logs/$label.log"
  local status_file="$OUT_DIR/status/$label.status"

  if [[ "$RUN_MODE" == "--failed-only" && -f "$status_file" && "$(<"$status_file")" == "captured" ]]; then
    return
  fi
  if [[ -f "$status_file" ]]; then
    [[ -f "$report" ]] && cp "$report" "$OUT_DIR/logs/$label.report-attempt-1.log"
    [[ -f "$log" ]] && cp "$log" "$OUT_DIR/logs/$label.attempt-1.log"
  fi

  echo "[$label] $agent / $model / $effort"
  if "$@" >"$report" 2>"$log"; then
    if [[ -s "$report" ]]; then
      # This proves only that the CLI exited and returned nonempty stdout.
      # Model output is untrusted review input; the human/primary-agent
      # disposition belongs in the curated checkpoint report.
      printf 'captured\n' >"$status_file"
    else
      printf 'failed: empty report\n' >"$status_file"
    fi
  else
    printf 'failed: exit %s\n' "$?" >"$status_file"
  fi
}

run_agy() {
  local label="$1"
  local model="$2"
  local prompt="$3"
  run_one "$label" "agy" "$model" "high" "$prompt" \
    agy \
      --print="$prompt" \
      --model "$model" \
      --effort high \
      --mode plan \
      --add-dir "$PROJECT_DIR" \
      --output-format text \
      --print-timeout 20m
}

run_claude() {
  local label="$1"
  local prompt="$2"
  run_one "$label" "claude" "claude-fable-5" "medium" "$prompt" \
    claude --print \
      --model claude-fable-5 \
      --effort medium \
      --permission-mode plan \
      --allowedTools Read,Grep,Glob,LS \
      --no-session-persistence \
      --output-format text \
      "$prompt"
}

run_grok() {
  local label="$1"
  local prompt="$2"
  run_one "$label" "grok" "grok-4.6" "high" "$prompt" \
    grok --single "$prompt" \
      --cwd "$PROJECT_DIR" \
      --model grok-4.6 \
      --reasoning-effort high \
      --permission-mode plan \
      --output-format plain \
      --disable-web-search \
      --no-subagents \
      --max-turns 50
}

run_agy agy-pro-01-generic gemini-3.1-pro-high "$generic_prompt" &
run_agy agy-pro-02-mechanism gemini-3.1-pro-high "$mechanism_prompt" &
run_agy agy-pro-03-ui-security-release gemini-3.1-pro-high "$release_prompt" &

run_agy agy-flash-01-generic gemini-3.7-flash-high "$generic_prompt" &
run_agy agy-flash-02-mechanism gemini-3.7-flash-high "$mechanism_prompt" &
run_agy agy-flash-03-ui-security-release gemini-3.7-flash-high "$release_prompt" &

if [[ "$SKIP_CLAUDE" != "1" ]]; then
  run_claude claude-fable-01-generic "$generic_prompt" &
  run_claude claude-fable-02-mechanism "$mechanism_prompt" &
fi

run_grok grok-01-generic "$generic_prompt" &
run_grok grok-02-mechanism "$mechanism_prompt" &
run_grok grok-03-ui-security-release "$release_prompt" &

wait

manifest="$OUT_DIR/manifest.md"
{
  echo '# Final multi-model bug bash'
  echo
  echo "- Project: \`$PROJECT_DIR\`"
  echo '- Access: read-only / plan mode'
  if [[ "$SKIP_CLAUDE" == "1" ]]; then
    echo '- Matrix: AGY 3.1 Pro High ×3, AGY 3.7 Flash High ×3, Grok 4.6 High ×3'
    echo '- Claude Fable 5 Medium was intentionally not rerun; preserve the two prior exact attempts as the quota-blocked Claude record.'
  else
    echo '- Matrix: AGY 3.1 Pro High ×3, AGY 3.7 Flash High ×3, Claude Fable 5 Medium ×2, Grok 4.6 High ×3'
  fi
  echo '- Rounds: broad; guided core mechanisms; guided UI/security/release (Claude runs the first two)'
  echo '- Status semantics: `captured` means the CLI exited successfully and wrote nonempty stdout. It does not mean the report is complete, correct, or approved.'
  echo
  echo '## Reports'
  echo
  for status_file in "$OUT_DIR"/status/*.status; do
    label="$(basename "$status_file" .status)"
    status="$(<"$status_file")"
    echo "- $label — $status — [$label.md]($label.md)"
  done
  echo
  echo 'Logs are retained under `logs/` for failed-run diagnosis and are not review findings.'
} >"$manifest"

failed=0
for status_file in "$OUT_DIR"/status/*.status; do
  if [[ "$(<"$status_file")" != "captured" ]]; then
    failed=1
  fi
done

echo "Manifest: $manifest"
exit "$failed"
