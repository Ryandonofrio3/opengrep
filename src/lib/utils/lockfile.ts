import * as fs from "node:fs";
import * as path from "node:path";

const SERVER_LOCK_FILE = (cwd: string) =>
    path.join(cwd, ".osgrep", "server.json");

function getServerLockPath(cwd = process.cwd()): string {
    return SERVER_LOCK_FILE(cwd);
}

export async function writeServerLock(
    port: number,
    pid: number,
    cwd = process.cwd(),
    authToken?: string,
): Promise<void> {
    const lockPath = getServerLockPath(cwd);
    await fs.promises.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.promises.writeFile(
        lockPath,
        JSON.stringify(
            { port, pid, authToken },
            null,
            2,
        ),
        { encoding: "utf-8", mode: 0o600 },
    );
}

export async function readServerLock(
    cwd = process.cwd(),
): Promise<{ port: number; pid: number; authToken?: string } | null> {
    const lockPath = getServerLockPath(cwd);
    try {
        const content = await fs.promises.readFile(lockPath, "utf-8");
        const data = JSON.parse(content);
        if (
            data &&
            typeof data.port === "number" &&
            typeof data.pid === "number"
        ) {
            return {
                port: data.port,
                pid: data.pid,
                authToken: typeof data.authToken === "string" ? data.authToken : undefined,
            };
        }
    } catch (_err) {
        // Missing or malformed lock file -> treat as absent
    }
    return null;
}

export async function clearServerLock(
    cwd = process.cwd(),
): Promise<void> {
    const lockPath = getServerLockPath(cwd);
    try {
        await fs.promises.unlink(lockPath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
        }
    }
}
