import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { cancel, confirm, isCancel } from "@clack/prompts";
import type { Mixedbread } from "@mixedbread/sdk";
import pLimit from "p-limit";
import { loginAction } from "./login";
import { getStoredToken } from "./token";
import type { FileMetadata } from "./types";

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function computeFileHash(
  filePath: string,
  readFileSyncFn: (p: string) => Buffer,
): string {
  const buffer = readFileSyncFn(filePath);
  return computeBufferHash(buffer);
}

export function getGitRepoFiles(repoRoot: string): string[] {
  const run = (args: string[]) => {
    const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" });
    if (res.error) return "";
    return res.stdout as string;
  };

  // Tracked files
  const tracked = run(["ls-files", "-z"]).split("\u0000").filter(Boolean);

  // Untracked but not ignored
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\u0000")
    .filter(Boolean);

  const allRel = Array.from(new Set([...tracked, ...untracked]));
  return allRel.map((rel) => path.join(repoRoot, rel));
}

export function isIgnoredByGit(filePath: string, repoRoot: string): boolean {
  try {
    const result = spawnSync("git", ["check-ignore", "-q", "--", filePath], {
      cwd: repoRoot,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function isDevelopment(): boolean {
  // Check if running from node_modules (published package)
  if (__dirname.includes("node_modules")) {
    return false;
  }

  // Check if NODE_ENV is set to development
  if (process.env.NODE_ENV === "development") {
    return true;
  }

  // Default to local if we can't determine
  return true;
}

export async function listStoreFileHashes(
  client: Mixedbread,
  store: string,
): Promise<Map<string, string | undefined>> {
  const byExternalId = new Map<string, string | undefined>();
  let after: string | null | undefined;
  do {
    const resp = await client.stores.files.list(store, { limit: 100, after });
    for (const f of resp.data) {
      const externalId = f.external_id ?? undefined;
      if (!externalId) continue;
      const metadata = (f.metadata || {}) as FileMetadata;
      const hash: string | undefined =
        typeof metadata?.hash === "string" ? metadata.hash : undefined;
      byExternalId.set(externalId, hash);
    }
    after = resp.pagination?.has_more
      ? (resp.pagination?.last_cursor ?? undefined)
      : undefined;
  } while (after);
  return byExternalId;
}

export function filterRepoFiles(files: string[], repoRoot: string): string[] {
  const filtered: string[] = [];
  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    if (isIgnoredByGit(filePath, repoRoot)) continue;
    filtered.push(filePath);
  }
  return filtered;
}

export async function ensureAuthenticated(): Promise<void> {
  const token = await getStoredToken();
  if (token) {
    return;
  }

  const shouldLogin = await confirm({
    message: "You are not logged in. Would you like to login now?",
    initialValue: true,
  });

  if (isCancel(shouldLogin) || !shouldLogin) {
    cancel("Operation cancelled");
    process.exit(0);
  }

  await loginAction();
}

export async function uploadFile(
  client: Mixedbread,
  store: string,
  filePath: string,
  fileName: string,
): Promise<boolean> {
  const buffer = await fs.promises.readFile(filePath);
  if (buffer.length === 0) {
    return false;
  }
  const hash = computeBufferHash(buffer);
  try {
    await client.stores.files.upload(store, fs.createReadStream(filePath), {
      external_id: filePath,
      overwrite: true,
      metadata: {
        path: filePath,
        hash,
      },
    });
  } catch (_err) {
    await client.stores.files.upload(
      store,
      new File([buffer], fileName, { type: "text/plain" }),
      {
        external_id: filePath,
        overwrite: true,
        metadata: {
          path: filePath,
          hash,
        },
      },
    );
  }
  return true;
}

export async function initialSync(
  client: Mixedbread,
  store: string,
  repoRoot: string,
  onProgress?: (info: {
    processed: number;
    uploaded: number;
    total: number;
    filePath?: string;
  }) => void,
): Promise<{ processed: number; uploaded: number; total: number }> {
  const storeHashes = await listStoreFileHashes(client, store);
  const repoFiles = filterRepoFiles(getGitRepoFiles(repoRoot), repoRoot);
  const total = repoFiles.length;
  let processed = 0;
  let uploaded = 0;

  const concurrency = 100;
  const limit = pLimit(concurrency);

  await Promise.all(
    repoFiles.map((filePath) =>
      limit(async () => {
        try {
          const buffer = await fs.promises.readFile(filePath);
          const hash = computeBufferHash(buffer);
          const existingHash = storeHashes.get(filePath);
          processed += 1;
          if (!existingHash || existingHash !== hash) {
            const didUpload = await uploadFile(
              client,
              store,
              filePath,
              path.basename(filePath),
            );
            if (didUpload) {
              uploaded += 1;
            }
          }
          onProgress?.({ processed, uploaded, total, filePath });
        } catch (_err) {
          onProgress?.({ processed, uploaded, total, filePath });
        }
      }),
    ),
  );
  return { processed, uploaded, total };
}
