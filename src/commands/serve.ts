import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import chokidar, { type FSWatcher } from "chokidar";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import { getAutoStoreId } from "../lib/store-resolver";
import type { Store } from "../lib/store";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns"
import {
  clearServerLock,
  computeBufferHash,
  debounce,
  formatDenseSnippet,
  indexFile,
  initialSync,
  isIndexablePath,
  MetaStore,
  preparedChunksToVectors,
  readServerLock,
  writeServerLock,
} from "../utils";

type PendingAction = "upsert" | "delete";

// Global State for the Server
let indexState = {
  isIndexing: false,
  indexed: 0,
  total: 0,
};

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;

function toDenseResults(
  storeRoot: string,
  data: Array<{
    score: number;
    text?: string | null;
    metadata?: Record<string, unknown>;
    generated_metadata?: { start_line?: number | null; type?: string | null };
  }>,
) {
  const root = path.resolve(storeRoot);
  return data.map((item) => {
    const rawPath =
      typeof item.metadata?.path === "string"
        ? (item.metadata.path as string)
        : "";
    const relPath = rawPath ? path.relative(root, rawPath) || rawPath : "unknown";
    const snippet = formatDenseSnippet(item.text ?? "");
    return {
      path: relPath,
      score: Number(item.score.toFixed(3)),
      content: snippet,
      chunk_type: item.generated_metadata?.type ?? undefined,
    };
  });
}

async function createWatcher(
  store: Store,
  storeId: string,
  root: string,
  metaStore: MetaStore,
): Promise<FSWatcher> {
  const fileSystem = createFileSystem({
    ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, ".osgrep/**"],
  });

  fileSystem.loadOsgrepignore(root);

  const pending = new Map<string, PendingAction>();

  const processPending = debounce(async () => {
    const actions = Array.from(pending.entries());
    pending.clear();
    for (const [filePath, action] of actions) {
      if (action === "delete") {
        try {
          await store.deleteFile(storeId, filePath);
          metaStore.delete(filePath);
          await metaStore.save();
        } catch (err) {
          console.error("Failed to delete file from store:", err);
        }
        continue;
      }

      if (
        fileSystem.isIgnored(filePath, root) ||
        !isIndexablePath(filePath)
      ) {
        continue;
      }

      try {
        const buffer = await fs.promises.readFile(filePath);
        if (buffer.length === 0) continue;
        const hash = computeBufferHash(buffer);
        const { chunks, indexed: didIndex } = await indexFile(
          store,
          storeId,
          filePath,
          path.basename(filePath),
          metaStore,
          undefined,
          buffer,
          hash,
        );
        if (didIndex) {
          if (chunks.length > 0) {
            const vectors = await preparedChunksToVectors(chunks);
            await store.insertBatch(storeId, vectors);
          }
          metaStore.set(filePath, hash);
          await metaStore.save();
        }
      } catch (err) {
        console.error("Failed to index changed file:", err);
      }
    }
  }, 300);

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    ignored: (watchedPath) =>
      fileSystem.isIgnored(watchedPath.toString(), root) ||
      watchedPath.toString().includes(`${path.sep}.git${path.sep}`) ||
      watchedPath.toString().includes(`${path.sep}.osgrep${path.sep}`),
  });

  watcher
    .on("add", (filePath) => {
      pending.set(path.resolve(filePath), "upsert");
      processPending();
    })
    .on("change", (filePath) => {
      pending.set(path.resolve(filePath), "upsert");
      processPending();
    })
    .on("unlink", (filePath) => {
      pending.set(path.resolve(filePath), "delete");
      processPending();
    });

  return watcher;
}

async function respondJson(
  res: http.ServerResponse,
  status: number,
  payload: object,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

export const serve = new Command("serve")
  .description("Run osgrep as a background server with live indexing")
  .option("-p, --port <port>", "Port to listen on", process.env.OSGREP_PORT || "4444")
  .action(async (_args, cmd) => {
    const options: { port: string; store?: string } = cmd.optsWithGlobals();
    const port = parseInt(options.port, 10);
    const root = process.cwd();
    const authToken = randomUUID();

    let store: Store | null = null;
    let watcher: FSWatcher | null = null;
    const metaStore = new MetaStore();

    const shutdown = async () => {
      try {
        await clearServerLock(root);
      } catch (err) {
        console.error("Failed to clear server lock:", err);
      }
      try {
        await watcher?.close();
      } catch (err) {
        console.error("Failed to close watcher:", err);
      }
      if (store && typeof store.close === "function") {
        try {
          await store.close();
        } catch (err) {
          console.error("Failed to close store:", err);
        }
      }
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("exit", async () => {
      await clearServerLock(root);
    });

    try {
      await ensureSetup({ silent: true });
      await metaStore.load();
      store = await createStore();
      const storeId = options.store || getAutoStoreId(root);
      await ensureStoreExists(store, storeId);

      const empty = await isStoreEmpty(store, storeId);
      if (empty) {
        const fileSystem = createFileSystem({
          ignorePatterns: [...DEFAULT_IGNORE_PATTERNS, ".osgrep/**"],
        });
        console.log("Store empty, performing initial index (background)...");

        // Setup the Progress Callback
        const onProgress = (info: {
          processed: number;
          indexed: number;
          total: number;
        }) => {
          indexState = {
            isIndexing: info.indexed < info.total,
            indexed: info.indexed,
            total: info.total,
          };
        };

        // Trigger Sync (Non-blocking / Background)
        indexState.isIndexing = true;
        initialSync(
          store,
          fileSystem,
          storeId,
          root,
          false,
          onProgress,
          metaStore,
          undefined, // No timeout for server mode
        )
          .then(() => {
            indexState.isIndexing = false;
            console.log("Background indexing complete.");
          })
          .catch((err) => {
            indexState.isIndexing = false;
            console.error("Background index failed:", err);
          });
      } else {
        indexState.isIndexing = false;
      }

      watcher = await createWatcher(store, storeId, root, metaStore);

      const server = http.createServer(async (req, res) => {
        const rawAuth =
          typeof req.headers.authorization === "string"
            ? req.headers.authorization
            : Array.isArray(req.headers.authorization)
              ? req.headers.authorization[0]
              : undefined;
        const providedToken =
          rawAuth && rawAuth.startsWith("Bearer ")
            ? rawAuth.slice("Bearer ".length)
            : rawAuth;
        if (providedToken !== authToken) {
          return respondJson(res, 401, { error: "unauthorized" });
        }

        if (!req.url) {
          return respondJson(res, 400, { error: "Invalid request" });
        }

        const url = new URL(req.url, `http://localhost:${port}`);
        if (req.method === "GET" && url.pathname === "/health") {
          return respondJson(res, 200, { status: "ready" });
        }

        if (req.method === "POST" && url.pathname === "/search") {
          const contentLengthHeader = req.headers["content-length"];
          const declaredLength = Array.isArray(contentLengthHeader)
            ? parseInt(contentLengthHeader[0] ?? "", 10)
            : contentLengthHeader
              ? parseInt(contentLengthHeader, 10)
              : NaN;

          if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
            return respondJson(res, 413, { error: "payload_too_large" });
          }

          let receivedBytes = 0;
          let rejected = false;
          const chunks: Buffer[] = [];
          req.on("data", (c) => {
            if (rejected) return;
            receivedBytes += c.length;
            if (receivedBytes > MAX_REQUEST_BYTES) {
              rejected = true;
              respondJson(res, 413, { error: "payload_too_large" });
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on("end", async () => {
            if (rejected) return;
            try {
              const bodyRaw = Buffer.concat(chunks).toString("utf-8");
              const body = bodyRaw ? JSON.parse(bodyRaw) : {};
              const query = typeof body.query === "string" ? body.query : "";
              if (!query) {
                return respondJson(res, 400, { error: "query is required" });
              }
              const limit =
                typeof body.limit === "number" && !Number.isNaN(body.limit)
                  ? body.limit
                  : 25;
              const rerank = body.rerank === false ? false : true;

              const searchPath =
                typeof body.path === "string" && body.path.length > 0
                  ? path.normalize(
                    path.isAbsolute(body.path)
                      ? body.path
                      : path.join(root, body.path),
                  )
                  : root;

              const filters =
                body.filters && typeof body.filters === "object"
                  ? body.filters
                  : {
                    all: [
                      {
                        key: "path",
                        operator: "starts_with",
                        value: searchPath,
                      },
                    ],
                  };

              const results = await store!.search(
                storeId,
                query,
                limit,
                { rerank },
                filters,
              );
              const dense = toDenseResults(root, results.data);

              // INJECT STATUS
              const responsePayload = {
                results: dense,
                status: indexState.isIndexing ? "indexing" : "ready",
                progress: indexState.isIndexing
                  ? Math.round((indexState.indexed / indexState.total) * 100)
                  : 100,
              };

              return respondJson(res, 200, responsePayload);
            } catch (err) {
              console.error("Search handler failed:", err);
              return respondJson(res, 500, { error: "search_failed" });
            }
          });
          return;
        }

        return respondJson(res, 404, { error: "not_found" });
      });

      server.listen(port, "127.0.0.1", async () => {
        await writeServerLock(port, process.pid, root, authToken);
        const lock = await readServerLock(root);
        console.log(
          `osgrep serve listening on port ${port} (lock: ${lock?.pid ?? "n/a"})`,
        );
      });
    } catch (error) {
      console.error(
        "Failed to start osgrep server:",
        error instanceof Error ? error.message : "Unknown error",
      );
      await shutdown();
    }
  });
