import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pLimit from "p-limit";
import type { RepositoryScanner } from "./scanner";
import type {
    PreparedChunk,
    Store,
    VectorRecord,
} from "../store/store";
import type {
    InitialSyncProgress,
    InitialSyncResult,
} from "./sync-helpers";
import { workerManager } from "../workers/worker-manager";
import { MetaStore } from "../store/meta-store";
import { computeBufferHash, isIndexableFile } from "../utils/file-utils";

// Re-export these for convenience if needed by other modules, 
// though ideally they should import from file-utils directly.
// export { indexFile, preparedChunksToVectors };

const PROFILE_ENABLED =
    process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";
const SKIP_META_SAVE =
    process.env.OSGREP_SKIP_META_SAVE === "1" ||
    process.env.OSGREP_SKIP_META_SAVE === "true";
const DEFAULT_EMBED_BATCH_SIZE = 24;
const META_FILE = path.join(os.homedir(), ".osgrep", "meta.json");

export interface IndexingProfile {
    sections: Record<string, number>;
    metaFileSize?: number;
    metaSaveCount: number;
    metaSaveSkipped: boolean;
    processed: number;
    indexed: number;
}

type IndexCandidate = {
    filePath: string;
    hash: string;
};

export type IndexFileResult = {
    chunks: PreparedChunk[];
    indexed: boolean;
};

function now(): bigint {
    return process.hrtime.bigint();
}

function toMs(start: bigint, end?: bigint): number {
    return Number((end ?? now()) - start) / 1_000_000;
}

function resolveEmbedBatchSize(): number {
    const fromEnv = Number.parseInt(process.env.OSGREP_BATCH_SIZE ?? "", 10);
    if (Number.isFinite(fromEnv) && fromEnv > 0) {
        return Math.min(fromEnv, 96);
    }
    if (process.env.OSGREP_LOW_IMPACT === "1") return 24;
    if (process.env.OSGREP_FAST === "1") return 48;
    return DEFAULT_EMBED_BATCH_SIZE;
}

export async function initialSync(
    store: Store,
    fileSystem: RepositoryScanner,
    storeId: string,
    repoRoot: string,
    dryRun?: boolean,
    onProgress?: (info: InitialSyncProgress) => void,
    metaStore?: MetaStore,
    signal?: AbortSignal,
): Promise<InitialSyncResult> {
    if (metaStore) {
        await metaStore.load();
    }

    const EMBED_BATCH_SIZE = resolveEmbedBatchSize();
    const profile: IndexingProfile | undefined = PROFILE_ENABLED
        ? {
            sections: {},
            metaSaveCount: 0,
            metaSaveSkipped: SKIP_META_SAVE,
            metaFileSize: undefined,
            processed: 0,
            indexed: 0,
        }
        : undefined;

    const totalStart = PROFILE_ENABLED ? now() : null;

    // 1. Scan existing store to find what we already have
    const dbPaths = new Set<string>();
    let storeIsEmpty = false;
    let storeHashes: Map<string, string | undefined> = new Map();
    let initialDbCount = 0;
    const storeScanStart = PROFILE_ENABLED ? now() : null;

    try {
        for await (const file of store.listFiles(storeId)) {
            const externalId = file.external_id ?? undefined;
            if (!externalId) continue;
            dbPaths.add(externalId);
            if (!metaStore) {
                const metadata = file.metadata;
                const hash: string | undefined =
                    metadata && typeof metadata.hash === "string"
                        ? metadata.hash
                        : undefined;
                storeHashes.set(externalId, hash);
            }
        }
        initialDbCount = dbPaths.size;
        storeIsEmpty = dbPaths.size === 0;
    } catch (_err) {
        storeIsEmpty = true;
    }

    if (PROFILE_ENABLED && storeScanStart && profile) {
        profile.sections.storeScan =
            (profile.sections.storeScan ?? 0) + toMs(storeScanStart);
    }

    if (metaStore && storeHashes.size === 0) {
        storeHashes = new Map();
    }

    // 2. Walk file system and apply the VELVET ROPE filter
    const fileWalkStart = PROFILE_ENABLED ? now() : null;

    // Files on disk that are not gitignored.
    const allFiles: string[] = [];
    for await (const file of fileSystem.getFiles(repoRoot)) {
        allFiles.push(file);
    }
    const aliveFiles = allFiles.filter(
        (filePath) => !fileSystem.isIgnored(filePath, repoRoot)
    );

    if (PROFILE_ENABLED && fileWalkStart && profile) {
        profile.sections.fileWalk =
            (profile.sections.fileWalk ?? 0) + toMs(fileWalkStart);
    }

    // Apply extension filter to pick index candidates.
    const repoFiles = aliveFiles.filter((filePath) => isIndexableFile(filePath));

    // C. Determine Staleness
    // Stale = In DB, but not in 'aliveFiles' (meaning deleted from disk or added to .gitignore)
    const diskPaths = new Set(aliveFiles);

    // 3. Delete stale files (files in DB but not on disk)
    const stalePaths = Array.from(dbPaths).filter((p) => !diskPaths.has(p));
    const total = repoFiles.length;
    let processed = 0;
    let indexed = 0;
    let pendingIndexCount = 0;
    let writeBuffer: VectorRecord[] = [];
    const embedQueue: PreparedChunk[] = [];

    const flushWriteBuffer = async (force = false) => {
        if (dryRun) return;
        if (writeBuffer.length === 0) return;
        if (!force && writeBuffer.length < 500) return;
        const toWrite = writeBuffer;
        writeBuffer = [];
        const writeStart = PROFILE_ENABLED ? now() : null;
        await store.insertBatch(storeId, toWrite);

        // CHECKPOINTING FIX: Update meta store only after successful write
        if (metaStore) {
            const uniquePaths = new Set(toWrite.map(r => r.path as string));
            for (const p of uniquePaths) {
                // We need the hash. Since we don't have it handy in a map here easily without looking up,
                // we can rely on the fact that 'toWrite' contains the records.
                // Optimization: Create a map of path -> hash from the batch
                const record = toWrite.find(r => r.path === p);
                if (record && record.hash) {
                    metaStore.set(p, record.hash as string);
                }
            }
        }

        if (PROFILE_ENABLED && writeStart && profile) {
            profile.sections.tableWrite =
                (profile.sections.tableWrite ?? 0) + toMs(writeStart);
        }
    };

    const flushEmbedQueue = async (force = false) => {
        if (dryRun) {
            embedQueue.length = 0;
            return;
        }
        while (
            embedQueue.length >= EMBED_BATCH_SIZE ||
            (force && embedQueue.length > 0)
        ) {
            const batch = embedQueue.splice(0, EMBED_BATCH_SIZE);
            const embedStart = PROFILE_ENABLED ? now() : null;
            const vectors = await preparedChunksToVectors(batch);
            if (PROFILE_ENABLED && embedStart && profile) {
                profile.sections.embed =
                    (profile.sections.embed ?? 0) + toMs(embedStart);
                profile.sections.embedBatches =
                    (profile.sections.embedBatches ?? 0) + 1;
            }
            writeBuffer.push(...vectors);
            await flushWriteBuffer();
        }
    };

    if (PROFILE_ENABLED && profile) {
        profile.processed = total;
    }

    const CONCURRENCY = Math.max(1, Math.min(4, os.cpus().length || 4));
    const limit = pLimit(CONCURRENCY);
    const BATCH_SIZE = 5; // Small batches keep memory pressure predictable

    const candidates: IndexCandidate[] = [];
    let embedFlushQueue = Promise.resolve();

    // Process files in batches (hashing + change detection only)
    for (let i = 0; i < repoFiles.length; i += BATCH_SIZE) {
        if (signal?.aborted) break;
        const batch = repoFiles.slice(i, i + BATCH_SIZE);

        await Promise.all(
            batch.map((filePath) =>
                limit(async () => {
                    try {
                        const buffer = await fs.promises.readFile(filePath);
                        const hashStart = PROFILE_ENABLED ? now() : null;
                        const hash = computeBufferHash(buffer);

                        if (PROFILE_ENABLED && hashStart && profile) {
                            profile.sections.hash =
                                (profile.sections.hash ?? 0) + toMs(hashStart);
                        }

                        let existingHash: string | undefined;
                        if (metaStore) {
                            existingHash = metaStore.get(filePath);
                        } else {
                            existingHash = storeHashes.get(filePath);
                        }

                        processed += 1;
                        const shouldIndex =
                            storeIsEmpty || !existingHash || existingHash !== hash;

                        if (shouldIndex) {
                            if (dryRun) {
                                indexed += 1;
                            } else {
                                candidates.push({ filePath, hash });
                            }
                            pendingIndexCount += 1;
                        }

                        onProgress?.({ processed, indexed, total, filePath });
                    } catch (_err) {
                        onProgress?.({ processed, indexed, total, filePath });
                    }
                }),
            ),
        );
    }

    // Single delete for stale + changed paths
    if (!dryRun) {
        const deleteTargets = Array.from(
            new Set([...stalePaths, ...candidates.map((c) => c.filePath)]),
        );
        if (deleteTargets.length > 0) {
            const staleStart = PROFILE_ENABLED ? now() : null;
            await store.deleteFiles(storeId, deleteTargets);
            if (PROFILE_ENABLED && staleStart && profile) {
                profile.sections.staleDeletes =
                    (profile.sections.staleDeletes ?? 0) + toMs(staleStart);
            }
        }
        if (metaStore && stalePaths.length > 0) {
            stalePaths.forEach((p) => metaStore.delete(p));
            await metaStore.save();
        }
    } else if (stalePaths.length > 0) {
        for (const p of stalePaths) {
            console.log("Dry run: would delete", p);
        }
    }

    if (!dryRun && !storeIsEmpty) {
        storeIsEmpty =
            initialDbCount - stalePaths.length - candidates.length <= 0;
    }

    const queueFlush = (force = false) => {
        embedFlushQueue = embedFlushQueue.then(() => flushEmbedQueue(force));
        return embedFlushQueue;
    };

    // Second pass: chunk + embed + write using global batching (parallel chunking)
    if (!dryRun) {
        const INDEX_BATCH = 50;
        for (let i = 0; i < candidates.length; i += INDEX_BATCH) {
            const slice = candidates.slice(i, i + INDEX_BATCH);
            await Promise.all(
                slice.map((candidate) =>
                    limit(async () => {
                        if (signal?.aborted) return;
                        try {
                            const buffer = await fs.promises.readFile(candidate.filePath);
                            const { chunks, indexed: didIndex } = await indexFile(
                                store,
                                storeId,
                                candidate.filePath,
                                path.basename(candidate.filePath),
                                metaStore,
                                profile,
                                buffer,
                                candidate.hash,
                                storeIsEmpty,
                            );
                            pendingIndexCount = Math.max(0, pendingIndexCount - 1);
                            if (didIndex) {
                                indexed += 1;
                                if (chunks.length > 0) {
                                    embedQueue.push(...chunks);
                                    if (embedQueue.length >= EMBED_BATCH_SIZE) {
                                        await queueFlush();
                                    }
                                }

                                // Periodic meta save
                                if (metaStore && !SKIP_META_SAVE && indexed % 25 === 0) {
                                    const saveStart = PROFILE_ENABLED ? now() : null;
                                    metaStore
                                        .save()
                                        .catch((err) =>
                                            console.error("Failed to auto-save meta:", err),
                                        );
                                    if (PROFILE_ENABLED && saveStart && profile) {
                                        profile.metaSaveCount += 1;
                                        profile.sections.metaSave =
                                            (profile.sections.metaSave ?? 0) + toMs(saveStart);
                                    }
                                }
                            }
                            onProgress?.({
                                processed,
                                indexed,
                                total,
                                filePath: candidate.filePath,
                            });
                        } catch (_err) {
                            pendingIndexCount = Math.max(0, pendingIndexCount - 1);
                            onProgress?.({
                                processed,
                                indexed,
                                total,
                                filePath: candidate.filePath,
                            });
                        }
                    }),
                ),
            );
            // Force flush between batches to ensure backpressure
            await queueFlush(true);
        }
    }

    await queueFlush(true);
    await flushWriteBuffer(true);

    if (PROFILE_ENABLED && profile) {
        profile.processed = processed;
        profile.indexed = indexed;
    }

    // Final meta save
    if (!dryRun && metaStore) {
        const finalSaveStart = PROFILE_ENABLED ? now() : null;
        await metaStore.save();
        if (PROFILE_ENABLED && finalSaveStart && profile) {
            profile.metaSaveCount += 1;
            profile.sections.metaSave =
                (profile.sections.metaSave ?? 0) + toMs(finalSaveStart);
        }
    }

    // Create/Update FTS & Vector Index only if needed
    if (!dryRun && indexed > 0) {
        const ftsStart = PROFILE_ENABLED ? now() : null;
        await store.createFTSIndex(storeId);
        if (PROFILE_ENABLED && ftsStart && profile) {
            profile.sections.createFTSIndex =
                (profile.sections.createFTSIndex ?? 0) + toMs(ftsStart);
        }
        const vecStart = PROFILE_ENABLED ? now() : null;
        await store.createVectorIndex(storeId);
        if (PROFILE_ENABLED && vecStart && profile) {
            profile.sections.createVectorIndex =
                (profile.sections.createVectorIndex ?? 0) + toMs(vecStart);
        }
    }

    if (PROFILE_ENABLED && totalStart && profile) {
        profile.sections.total = toMs(totalStart);
        const metaSize = await fs.promises
            .stat(META_FILE)
            .then((s) => s.size)
            .catch(() => undefined);
        profile.metaFileSize = metaSize;
        console.log(
            "[profile] timing (ms):",
            Object.fromEntries(
                Object.entries(profile.sections).map(([k, v]) => [
                    k,
                    Number(v.toFixed(2)),
                ]),
            ),
        );
        console.log(
            "[profile] indexing",
            `processed=${processed} indexed=${indexed} metaSaves=${profile.metaSaveCount} metaSize=${metaSize ?? "n/a"} bytes`,
        );
    }

    return { processed, indexed, total };
}

export async function indexFile(
    store: Store,
    storeId: string,
    filePath: string,
    fileName: string,
    metaStore?: MetaStore,
    profile?: IndexingProfile,
    preComputedBuffer?: Buffer,
    preComputedHash?: string,
    forceIndex?: boolean,
): Promise<IndexFileResult> {
    const indexStart = PROFILE_ENABLED ? now() : null;
    let buffer: Buffer;
    let hash: string;

    if (preComputedBuffer && preComputedHash) {
        buffer = preComputedBuffer;
        hash = preComputedHash;
    } else {
        buffer = await fs.promises.readFile(filePath);
        if (buffer.length === 0) {
            return { chunks: [], indexed: false };
        }
        hash = computeBufferHash(buffer);
    }

    const contentString = buffer.toString("utf-8");

    if (!forceIndex && metaStore) {
        const cachedHash = metaStore.get(filePath);
        if (cachedHash === hash) {
            return { chunks: [], indexed: false };
        }
    }

    const options = {
        external_id: filePath,
        overwrite: true,
        metadata: {
            path: filePath,
            hash,
        },
        content: contentString,
    };

    let chunks: PreparedChunk[] = [];
    let indexed = false;

    try {
        chunks = await store.indexFile(storeId, contentString, options);
        indexed = true;
    } catch (_err) {
        // Fallback for weird encodings
        chunks = await store.indexFile(
            storeId,
            new File([new Uint8Array(buffer)], fileName, { type: "text/plain" }),
            options,
        );
        indexed = true;
    }

    // DEFERRED: We do NOT update the meta store here anymore.
    // We only update it after the vectors are successfully written to the DB.
    // if (indexed && metaStore) {
    //   metaStore.set(filePath, hash);
    // }

    if (indexed && PROFILE_ENABLED && indexStart && profile) {
        profile.sections.index = (profile.sections.index ?? 0) + toMs(indexStart);
    }

    return { chunks, indexed };
}

export async function preparedChunksToVectors(
    chunks: PreparedChunk[],
): Promise<VectorRecord[]> {
    if (chunks.length === 0) return [];
    const hybrids = await workerManager.computeHybrid(
        chunks.map((chunk) => chunk.content),
    );
    return chunks.map((chunk, idx) => {
        const hybrid = hybrids[idx] ?? { dense: [], colbert: Buffer.alloc(0), scale: 1 };
        return {
            ...chunk,
            vector: hybrid.dense,
            colbert: hybrid.colbert,
            colbert_scale: hybrid.scale,
        };
    });
}

