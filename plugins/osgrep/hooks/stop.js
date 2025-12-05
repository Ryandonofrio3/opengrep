const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function readPayload() {
  try {
    const raw = fs.readFileSync(0, "utf-8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function killPid(pid) {
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

function main() {
  const payload = readPayload();
  const cwd = payload.cwd || process.cwd();
  const lockPath = path.join(cwd, ".osgrep", "server.json");
  let killed = false;

  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const pid = data?.pid;
      if (typeof pid === "number") {
        killed = killPid(pid);
      }
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }

  if (!killed) {
    // Best-effort fallback without taking down unrelated processes
    spawnSync("pkill", ["-f", "osgrep serve"], { stdio: "ignore" });
  }
}

main();
