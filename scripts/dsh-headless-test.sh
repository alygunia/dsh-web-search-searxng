#!/usr/bin/env bash
#
# Isolated end-to-end test of searxng_scholar in a REAL, SEPARATE dsh process.
# POSIX counterpart of scripts/dsh-headless-test.ps1.
#
# What it does (all state lives under $DSH_HOME/profiles/headless and a scratch
# workspace -- the running web GUI, its port, and its sessions are untouched):
#   1. sanity-check the LLM API key is reachable by the child process
#   2. provision the shipped `headless` profile and link this plugin into it
#      (idempotent; re-running is a no-op)
#   3. run `dsh --profile headless "<task>"` from a scratch workspace -- a
#      one-shot process: no port, one task, prints the answer, exits
#      (exit 0 = the turn completed; the tool list is assembled at boot, so
#      this process loads the FIXED plugin code, unlike the running GUI)
#   4. validate the session log the scratch run produced through the host
#      restore gate (scripts/check-session-log.mjs)
#
# Usage:  bash scripts/dsh-headless-test.sh [--query "..."] [--workspace DIR] [--keep-workspace]
#
# Prereqs: the child process must see ZAI_CODING_CN_API_KEY -- either exported
# in your shell, or put `ZAI_CODING_CN_API_KEY=...` in $DSH_HOME/.env (the
# `user` env layer dsh loads on every boot).
set -euo pipefail

QUERY='CRISPR base editing review'
KEEP_WORKSPACE=0
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
WORKSPACE=''

while [ $# -gt 0 ]; do
  case "$1" in
    --query) QUERY="${2:?--query needs a value}"; shift 2 ;;
    --workspace) WORKSPACE="${2:?--workspace needs a value}"; shift 2 ;;
    --keep-workspace) KEEP_WORKSPACE=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -n "$WORKSPACE" ] || WORKSPACE="${TMPDIR:-/tmp}/dsh-scholar-headless-test"

command -v dsh >/dev/null 2>&1 || { echo "error: dsh is not on PATH" >&2; exit 2; }

# --- 1. API key reachability for the child process -----------------------------
ENV_FILE="$DSH_HOME_DIR/.env"
if [ -z "${ZAI_CODING_CN_API_KEY:-}" ] && ! { [ -f "$ENV_FILE" ] && grep -q 'ZAI_CODING_CN_API_KEY' "$ENV_FILE"; }; then
  echo "warning: ZAI_CODING_CN_API_KEY is neither in this shell nor in $ENV_FILE." >&2
  echo "warning: add one line to that file (ZAI_CODING_CN_API_KEY=<your key>) -- it is the 'user' env layer dsh boots with -- or export it here first." >&2
  exit 2
fi

# --- 2. headless profile + this plugin (idempotent) ---------------------------
echo "==> linking plugin into the headless profile: $PLUGIN_DIR"
dsh plugin --profile headless add "link:$PLUGIN_DIR"

MANIFEST="$DSH_HOME_DIR/profiles/headless/package.json"
node -e '
const fs = require("node:fs");
const file = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || { bundles: [] };
const bundles = manifest.dsh.profile.bundles;
if (!bundles.includes("dsh-web-search-searxng")) bundles.push("dsh-web-search-searxng");
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("bundles: " + bundles.join(", "));
' "$MANIFEST"

# --- 3. one-shot headless run from the scratch workspace ----------------------
mkdir -p "$WORKSPACE"
echo ""
echo "==> headless run in scratch workspace: $WORKSPACE"
TASK="Use ONLY the searxng_scholar tool to search the academic topic \"$QUERY\" (max_results = 3), then summarize the findings in at most three sentences. Do not use any other tool."
set +e
( cd "$WORKSPACE" && dsh --profile headless "$TASK" )
RUN_CODE=$?
set -e
echo ""
echo "==> headless exit code: $RUN_CODE"

# --- 4. restore-gate validation of the scratch session log ---------------------
# Layout: sessions/<workspace-slug>/session-<uuid>/session.v<N>.jsonl[.zstd]
# (dsh 0.1.5 writes the version-tagged generation name; version zero keeps the
# original suffix-only name, so accept both and prefer the newest generation.)
BUCKET="$(ls -dt "$DSH_HOME_DIR"/sessions/*dsh-scholar-headless-test*/ 2>/dev/null | head -1 || true)"
LOG=''
if [ -n "$BUCKET" ]; then
  SESSION_DIR="$(ls -dt "$BUCKET"session-*/ 2>/dev/null | head -1 || true)"
  if [ -n "$SESSION_DIR" ]; then
    BEST_VERSION=-1
    for candidate in "$SESSION_DIR"session*.jsonl "$SESSION_DIR"session*.jsonl.zstd; do
      [ -f "$candidate" ] || continue
      base="$(basename "$candidate")"
      version=0
      case "$base" in
        session.v*.jsonl*) version="${base#session.v}"; version="${version%%.*}" ;;
      esac
      if [ "$version" -gt "$BEST_VERSION" ]; then
        BEST_VERSION="$version"
        LOG="$candidate"
      fi
    done
  fi
fi

if [ -n "$LOG" ]; then
  echo ""
  echo "==> validating $LOG"
  set +e
  node "$SCRIPT_DIR/check-session-log.mjs" "$LOG"
  CHECK_CODE=$?
  set -e
else
  echo "warning: no session log found under ${BUCKET:-<no scratch bucket found>} -- the run may not have started a session" >&2
  CHECK_CODE=1
fi

[ "$KEEP_WORKSPACE" -eq 1 ] || rm -rf "$WORKSPACE"

[ "$RUN_CODE" -ge "$CHECK_CODE" ] && exit "$RUN_CODE"
exit "$CHECK_CODE"
