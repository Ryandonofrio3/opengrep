const fs = require("node:fs");
const _path = require("node:path");
const { spawn } = require("node:child_process");

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();
  const logPath = "/tmp/osgrep.log";
  const out = fs.openSync(logPath, "a");

  const child = spawn("osgrep", ["serve"], {
    cwd,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();

  const response = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        'osgrep serve started; prefer `osgrep "<complete question>"` over grep (plain output is agent-friendly).',
    },
  };
  process.stdout.write(JSON.stringify(response));
}

main();
