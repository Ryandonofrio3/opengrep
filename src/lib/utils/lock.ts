import * as fs from "node:fs";
import * as path from "node:path";

function parseLock(lockPath: string): {
  pid: number | null;
  startedAt?: string;
} {
  try {
    const contents = fs.readFileSync(lockPath, "utf-8").trim();
    const [pidLine, ts] = contents.split("\n");
    const pid = Number.parseInt(pidLine ?? "", 10);
    return { pid: Number.isFinite(pid) ? pid : null, startedAt: ts };
  } catch {
    return { pid: null };
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ESRCH: no such process. EPERM means the process exists but we lack permission.
    if (code === "ESRCH") return false;
    return true;
  }
}

async function removeLock(lockPath: string) {
  try {
    await fs.promises.unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
}

export type LockHandle = {
  release: () => Promise<void>;
};

export async function acquireWriterLock(lockDir: string): Promise<LockHandle> {
  const lockPath = path.join(lockDir, "LOCK");
  const writeLock = async () => {
    await fs.promises.writeFile(
      lockPath,
      `${process.pid}\n${new Date().toISOString()}`,
      { flag: "wx" },
    );
  };

  try {
    await writeLock();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "EEXIST") throw err;

    const { pid, startedAt } = parseLock(lockPath);
    const alive = isProcessAlive(pid);
    if (!alive) {
      await removeLock(lockPath);
      await writeLock();
    } else {
      const holderDesc = pid
        ? `${pid}${startedAt ? ` @ ${startedAt}` : ""}`
        : "unknown";
      throw new Error(
        `.osgrep lock already held (${holderDesc}). Another indexing process is running or the lock must be cleared.`,
      );
    }
  }

  return {
    release: async () => {
      try {
        await removeLock(lockPath);
      } catch (err) {
        console.warn("[lock] Failed to remove lock:", err);
      }
    },
  };
}

export async function acquireWriterLockWithRetry(
  lockDir: string,
  options?: { maxRetries?: number; retryDelayMs?: number }
): Promise<LockHandle> {
  const maxRetries = options?.maxRetries ?? 5;
  const retryDelayMs = options?.retryDelayMs ?? 1000;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await acquireWriterLock(lockDir);
    } catch (err) {
      const isLockHeld = err instanceof Error && err.message.includes("lock already held");
      if (!isLockHeld || attempt === maxRetries - 1) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
    }
  }
  throw new Error("Failed to acquire lock after retries");
}
