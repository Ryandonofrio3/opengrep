#!/usr/bin/env bash
set -euo pipefail

# Simple indexing benchmark harness for macOS.
# - Runs osgrep indexing against a target directory with multiple env configs.
# - Wipes Lance data and meta between runs to keep results comparable.

TARGET_DIR="${TARGET_DIR:-/Users/ryandonofrio/Desktop/osgrep2/opencode/packages/opencode/src}"
OSGREP_BIN="${OSGREP_BIN:-node dist/index.js}"
LOG_DIR="${LOG_DIR:-./benchmarks}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/index-bench-$(date +%Y%m%d-%H%M%S).log}"
TIMEOUT_SEC="${TIMEOUT_SEC:-600}"

mkdir -p "${LOG_DIR}"

CONFIGS=(
  "OSGREP_THREADS=1 OSGREP_WORKER_BATCH_SIZE=8"
  "OSGREP_THREADS=1 OSGREP_WORKER_BATCH_SIZE=12"
  "OSGREP_THREADS=2 OSGREP_WORKER_BATCH_SIZE=12"
  "OSGREP_THREADS=2 OSGREP_WORKER_BATCH_SIZE=16"
)

clean_state() {
  echo "Cleaning ~/.osgrep data/meta..."
  rm -rf "${HOME}/.osgrep/data" "${HOME}/.osgrep/meta.json" "${HOME}/.osgrep/meta.json.tmp"
}

run_one() {
  local env_line="$1"
  echo "==== ${env_line} ====" | tee -a "${LOG_FILE}"
  clean_state
  SECONDS=0
  local cmd="${env_line} OSGREP_DEBUG_INDEX=1 OSGREP_PROFILE=1 OSGREP_SKIP_META_SAVE=1 ${OSGREP_BIN} index --path \"${TARGET_DIR}\" --reset"
  # /usr/bin/time -l (macOS) for resource stats; falls back to builtin time if unavailable.
  if command -v /usr/bin/time >/dev/null 2>&1; then
    cmd="/usr/bin/time -l ${cmd}"
  else
    cmd="time ${cmd}"
  fi
  # Enforce timeout (perl alarm works on macOS)
  perl -e 'alarm shift; exec @ARGV' "${TIMEOUT_SEC}" bash -lc "${cmd}" 2>&1 | tee -a "${LOG_FILE}"
  echo "Elapsed: ${SECONDS}s" | tee -a "${LOG_FILE}"
  echo | tee -a "${LOG_FILE}"
}

echo "Benchmarking ${TARGET_DIR}" | tee "${LOG_FILE}"
echo "Log: ${LOG_FILE}"
echo

for cfg in "${CONFIGS[@]}"; do
  run_one "${cfg}"
done

echo "Done. Results recorded in ${LOG_FILE}"
