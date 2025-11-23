import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { v4 as uuidv4 } from "uuid";
import type {
  ChunkType,
  CreateStoreOptions,
  IndexFileOptions,
  SearchFilter,
  SearchResponse,
  Store,
  StoreFile,
  StoreInfo,
  VectorRecord,
} from "./store";
import { TreeSitterChunker } from "./chunker";
import {
  buildAnchorChunk,
  ChunkWithContext,
  formatChunkText,
} from "./chunk-utils";
import { WorkerManager } from "./worker-manager";

const PROFILE_ENABLED =
  process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

export interface LocalStoreProfile {
  listFilesMs: number;
  indexCount: number;
  totalChunkCount: number;
  totalEmbedBatches: number;
  totalChunkTimeMs: number;
  totalEmbedTimeMs: number;
  totalTableWriteMs: number;
  totalTableDeleteMs: number;
}

export class LocalStore implements Store {
  private db: lancedb.Connection | null = null;
  // WorkerManager runs embedding/rerank work, serializes requests, and restarts on high RSS.
  private workerManager = new WorkerManager();
  private chunker = new TreeSitterChunker();
  private readonly VECTOR_DIMENSIONS = 384;
  private readonly EMBED_BATCH_SIZE = 12; // Smaller batches to tame thermals/memory on large repos
  // Query prefix for embeddings: Represent this sentence for searching relevant passages
  private readonly queryPrefix =
    "Represent this sentence for searching relevant passages: ";
  private profile: LocalStoreProfile = {
    listFilesMs: 0,
    indexCount: 0,
    totalChunkCount: 0,
    totalEmbedBatches: 0,
    totalChunkTimeMs: 0,
    totalEmbedTimeMs: 0,
    totalTableWriteMs: 0,
    totalTableDeleteMs: 0,
  };

  constructor() {
    // Initialize chunker in background (it might download WASMs)
    this.chunker
      .init()
      .catch((err) => console.error("Failed to init chunker:", err));
  }

  private isNodeReadable(input: unknown): input is NodeJS.ReadableStream {
    return (
      typeof input === "object" &&
      input !== null &&
      typeof (input as NodeJS.ReadableStream)[Symbol.asyncIterator] ===
        "function"
    );
  }

  private async getDb(): Promise<lancedb.Connection> {
    if (!this.db) {
      const dbPath = path.join(os.homedir(), ".osgrep", "data");
      if (!fs.existsSync(dbPath)) {
        fs.mkdirSync(dbPath, { recursive: true });
      }
      this.db = await lancedb.connect(dbPath);
    }
    return this.db;
  }

  private async getTable(storeId: string): Promise<lancedb.Table> {
    const db = await this.getDb();
    return await db.openTable(storeId);
  }

  private baseSchemaRow(): VectorRecord {
    return {
      id: "seed",
      path: "",
      hash: "",
      content: "",
      start_line: 0,
      end_line: 0,
      chunk_index: 0,
      is_anchor: false,
      context_prev: "",
      context_next: "",
      vector: Array(this.VECTOR_DIMENSIONS).fill(0),
    };
  }

  private async ensureTable(storeId: string): Promise<lancedb.Table> {
    const db = await this.getDb();
    try {
      return await db.openTable(storeId);
    } catch {
      const table = await db.createTable(storeId, [this.baseSchemaRow()]);
      await table.delete('id = "seed"');
      return table;
    }
  }

  async *listFiles(storeId: string): AsyncGenerator<StoreFile> {
    const start = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    try {
      const table = await this.getTable(storeId);
      // This is a simplification; ideally we'd group by file path
      // For now, let's just return unique paths
      const results = await table.query().select(["path", "hash"]).toArray();

      const seen = new Set<string>();
      for (const r of results) {
        if (!seen.has(r.path as string)) {
          seen.add(r.path as string);
          yield {
            external_id: r.path as string,
            metadata: {
              path: r.path as string,
              hash: (r.hash as string) || "",
            },
          };
        }
      }
    } catch (e) {
      // Table might not exist
    } finally {
      if (PROFILE_ENABLED && start) {
        const end = process.hrtime.bigint();
        this.profile.listFilesMs += Number(end - start) / 1_000_000;
      }
    }
  }

  async indexFile(
    storeId: string,
    file: File | ReadableStream | NodeJS.ReadableStream | string,
    options: IndexFileOptions,
  ): Promise<VectorRecord[]> {
    const fileIndexStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    let fileChunkMs = 0;
    let fileEmbedMs = 0;
    let fileDeleteMs = 0;
    let fileWriteMs = 0;
    const table = await this.ensureTable(storeId);

    // Read file content (prefer provided content to avoid double reads)
    let content = options.content ?? "";
    if (!content) {
      if (typeof file === "string") {
        content = file;
      } else if (this.isNodeReadable(file)) {
        for await (const chunk of file) {
          content += typeof chunk === "string" ? chunk : chunk.toString();
        }
      } else if (file instanceof ReadableStream) {
        const reader = file.getReader();
        let result = await reader.read();
        while (!result.done) {
          const value = result.value;
          content +=
            typeof value === "string"
              ? value
              : Buffer.from(value as ArrayBuffer).toString();
          result = await reader.read();
        }
      } else if (file instanceof File) {
        content = await file.text();
      } else {
        return [];
      }
    }

    // Delete existing chunks for this file
    const safePath = options.metadata?.path?.replace(/'/g, "''");
    if (safePath) {
      const deleteStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
      await table.delete(`path = '${safePath}'`);
      if (PROFILE_ENABLED && deleteStart) {
        const deleteEnd = process.hrtime.bigint();
        this.profile.totalTableDeleteMs +=
          Number(deleteEnd - deleteStart) / 1_000_000;
        fileDeleteMs += Number(deleteEnd - deleteStart) / 1_000_000;
      }
    }

    // Use TreeSitterChunker
    const chunkStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    const parsedChunks = await this.chunker.chunk(
      options.metadata?.path || "unknown",
      content,
    );
    if (PROFILE_ENABLED && chunkStart) {
      const chunkEnd = process.hrtime.bigint();
      this.profile.totalChunkTimeMs +=
        Number(chunkEnd - chunkStart) / 1_000_000;
      fileChunkMs += Number(chunkEnd - chunkStart) / 1_000_000;
      this.profile.totalChunkCount += parsedChunks.length;
    }
    const anchorChunk = buildAnchorChunk(
      options.metadata?.path || "unknown",
      content,
    );
    const baseChunks = anchorChunk
      ? [anchorChunk, ...parsedChunks]
      : parsedChunks;
    if (baseChunks.length === 0) return [];

    const chunks: ChunkWithContext[] = baseChunks.map((chunk, idx) => {
      const chunkWithContext = chunk as ChunkWithContext;
      return {
        ...chunkWithContext,
        context: Array.isArray(chunkWithContext.context)
          ? chunkWithContext.context
          : [],
        chunkIndex:
          typeof chunkWithContext.chunkIndex === "number"
            ? chunkWithContext.chunkIndex
            : anchorChunk
              ? idx - 1
              : idx,
        isAnchor:
          chunkWithContext.isAnchor === true || (anchorChunk ? idx === 0 : false),
      };
    });
    this.profile.totalChunkCount += anchorChunk ? 1 : 0;

    const chunkTexts = chunks.map((chunk) =>
      formatChunkText(chunk, options.metadata?.path || ""),
    );

    const BATCH_SIZE = this.EMBED_BATCH_SIZE;
    let pendingWrites: VectorRecord[] = [];

    for (let i = 0; i < chunkTexts.length; i += BATCH_SIZE) {
      const batchTexts = chunkTexts.slice(i, i + BATCH_SIZE);
      const embedStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
      const batchVectors = await this.workerManager.getEmbeddings(batchTexts);
      if (PROFILE_ENABLED && embedStart) {
        const embedEnd = process.hrtime.bigint();
        this.profile.totalEmbedTimeMs +=
          Number(embedEnd - embedStart) / 1_000_000;
        fileEmbedMs += Number(embedEnd - embedStart) / 1_000_000;
        this.profile.totalEmbedBatches += 1;
      }
      for (let j = 0; j < batchVectors.length; j++) {
        const chunkIndex = i + j;
        const chunk = chunks[chunkIndex];
        const vector = batchVectors[j];
        const prev = chunkTexts[chunkIndex - 1];
        const next = chunkTexts[chunkIndex + 1];

        pendingWrites.push({
          id: uuidv4(),
          path: options.metadata?.path || "",
          hash: options.metadata?.hash || "",
          content: chunkTexts[chunkIndex],
          context_prev: typeof prev === "string" ? prev : undefined,
          context_next: typeof next === "string" ? next : undefined,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          chunk_index: chunk.chunkIndex,
          is_anchor: chunk.isAnchor === true,
          vector,
        });
      }
    }

    if (PROFILE_ENABLED && fileIndexStart) {
      const end = process.hrtime.bigint();
      this.profile.indexCount += 1;
      const total = Number(end - fileIndexStart) / 1_000_000;
      console.log(
        `[profile] index ${options.metadata?.path ?? "unknown"} • chunks=${
          chunks.length
        } batches=${Math.ceil(chunkTexts.length / BATCH_SIZE)} ` +
          `chunkTime=${fileChunkMs.toFixed(1)}ms embedTime=${fileEmbedMs.toFixed(1)}ms ` +
          `deleteTime=${fileDeleteMs.toFixed(1)}ms writeTime=${fileWriteMs.toFixed(1)}ms total=${total.toFixed(1)}ms`,
      );
    }

    return pendingWrites;
  }

  async insertBatch(storeId: string, records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const table = await this.ensureTable(storeId);
    const writeStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
    await table.add(records);
    if (PROFILE_ENABLED && writeStart) {
      const writeEnd = process.hrtime.bigint();
      this.profile.totalTableWriteMs +=
        Number(writeEnd - writeStart) / 1_000_000;
    }
  }

  async createFTSIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);
    try {
      await table.createIndex("content");
    } catch (e) {
      console.warn("Failed to create FTS index (might already exist):", e);
    }
  }

  async createVectorIndex(storeId: string): Promise<void> {
    const table = await this.getTable(storeId);
    
    // Guard against small tables - LanceDB IVF_PQ requires 256 rows to train
    // If we have fewer, flat search is faster anyway and we avoid crashes
    const rowCount = await table.countRows();
    if (rowCount < 256) {
      return;
    }
    
    try {
      const vectorIndexOptions: Record<string, unknown> = { type: "ivf_flat" };
      await table.createIndex("vector", vectorIndexOptions);
    } catch (e) {
      const fallbackMsg = e instanceof Error ? e.message : String(e);
      if (!fallbackMsg.includes("already exists")) {
        try {
          await table.createIndex("vector");
        } catch (fallbackError) {
          const fallbackErr =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          if (!fallbackErr.includes("already exists")) {
            console.warn("Failed to create vector index:", fallbackError);
          }
        }
      }
    }
  }

  async search(
    storeId: string,
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: SearchFilter,
  ): Promise<SearchResponse> {
    let table: lancedb.Table;
    try {
      table = await this.getTable(storeId);
    } catch {
      return { data: [] };
    }

    // 1. Setup
    const queryVector = await this.workerManager.getEmbedding(
      this.queryPrefix + query,
    );
    const finalLimit = top_k ?? 10;

    // Keep balanced pools so exact matches survive to rerank
    const vectorLimit = 200;
    const ftsLimit = 200;
    const RERANK_CAP = 50;

    const allFilters = Array.isArray((_filters as { all?: unknown })?.all)
      ? ((_filters as { all?: unknown }).all as Record<string, unknown>[])
      : [];
    const pathFilterEntry = allFilters.find(
      (f) => f?.key === "path" && f?.operator === "starts_with",
    );
    const pathPrefix =
      typeof pathFilterEntry?.value === "string" ? pathFilterEntry.value : "";

    const whereClause = pathPrefix
      ? `path LIKE '${pathPrefix.replace(/'/g, "''")}%'`
      : undefined;

    // 2. Parallel Retrieval
    const vectorSearchQuery = table.search(queryVector).limit(vectorLimit);
    const ftsSearchQuery = table.search(query).limit(ftsLimit);

    if (whereClause) {
      vectorSearchQuery.where(whereClause);
      ftsSearchQuery.where(whereClause);
    }

    const [vectorResults, ftsResults] = await Promise.all([
      vectorSearchQuery.toArray() as Promise<VectorRecord[]>,
      ftsSearchQuery.toArray().catch(() => []) as Promise<VectorRecord[]>,
    ]);

    // 3. RRF Fusion
    const k = 20; // balances FTS and vector without overpowering rerank
    const rrfScores = new Map<string, number>();
    const contentMap = new Map<string, VectorRecord>();

    const fuse = (results: VectorRecord[]) => {
      results.forEach((r, i) => {
        const key = `${r.path}:${r.start_line}`;
        if (!contentMap.has(key)) contentMap.set(key, r);
        const rank = i + 1;
        const score = 1 / (k + rank);
        rrfScores.set(key, (rrfScores.get(key) || 0) + score);
      });
    };

    fuse(vectorResults);
    fuse(ftsResults);

    const candidates = Array.from(rrfScores.keys())
      .sort((a, b) => (rrfScores.get(b) || 0) - (rrfScores.get(a) || 0))
      .map((key) => contentMap.get(key))
      .filter((record): record is VectorRecord => Boolean(record))
      .slice(0, vectorLimit + ftsLimit);

    if (candidates.length === 0) {
      return { data: [] };
    }

    const rerankCandidates = candidates.slice(0, RERANK_CAP);

    // 4. Neural Reranking & Brute-Force Boosting
    const rrfValues = Array.from(rrfScores.values());
    const maxRrf = rrfValues.length > 0 ? Math.max(...rrfValues) : 0;
    const normalizeRrf = (key: string) =>
      maxRrf > 0 ? (rrfScores.get(key) || 0) / maxRrf : 0;

    const lowerQuery = query.toLowerCase().trim();
    const queryParts = lowerQuery
      .split(/[\s/\\_.-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2);
    const isCodeQuery =
      /[A-Z_]|`|\(|\)|\//.test(query) || queryParts.some((p) => p.includes("_"));

    let finalResults = rerankCandidates.map((r) => {
      const key = `${r.path}:${r.start_line}`;
      const rrfScore = normalizeRrf(key);
      return { record: r, score: rrfScore, rrfScore, rerankScore: 0 };
    });

    try {
      const docs = rerankCandidates.map((r) => String(r.content ?? ""));
      const scores = await this.workerManager.rerank(query, docs);

      finalResults = rerankCandidates.map((r, i) => {
        const key = `${r.path}:${r.start_line}`;
        const rrfScore = normalizeRrf(key);
        const rerankScore = scores[i] ?? 0;
        const rerankWeight = isCodeQuery ? 0.55 : 0.6;
        const rrfWeight = 1 - rerankWeight;
        let blendedScore = rerankWeight * rerankScore + rrfWeight * rrfScore;

        const content = String(r.content ?? "").toLowerCase();
        const path = String(r.path ?? "").toLowerCase();

        // Boost 1: exact substring
        if (lowerQuery.length > 2 && content.includes(lowerQuery)) {
          blendedScore += 0.25;
        }

        // Boost 2: anchor/definition
        if (r.is_anchor === true) {
          blendedScore += 0.12;
        }

        // Boost 3: path token match
        if (queryParts.some((part) => path.includes(part))) {
          blendedScore += 0.05;
        }

        // Boost 4: token overlap (light)
        const contentTokens = new Set(
          content
            .split(/[^a-z0-9_]+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 2),
        );
        let overlap = 0;
        if (queryParts.length > 0 && contentTokens.size > 0) {
          for (const tok of queryParts) {
            if (contentTokens.has(tok)) overlap += 1;
          }
          if (overlap > 0) {
            blendedScore += Math.min(0.08, overlap * 0.02);
          }
        }

        return { record: r, score: blendedScore, rrfScore, rerankScore };
      });
    } catch (e) {
      console.warn("Reranker failed; falling back to RRF:", e);
    }

    // 5. Final Sort
    finalResults.sort((a, b) => b.score - a.score);
    const limited = finalResults.slice(0, finalLimit);

    const chunks: ChunkType[] = limited.map(({ record, score }) => {
      const contextPrev =
        typeof record.context_prev === "string" ? record.context_prev : "";
      const contextNext =
        typeof record.context_next === "string" ? record.context_next : "";
      const fullText = `${contextPrev}${record.content ?? ""}${contextNext}`;
      const startLine = (record.start_line as number) ?? 0;
      const endLine = (record.end_line as number) ?? startLine;
      return {
        type: "text",
        text: fullText,
        score,
        metadata: {
          path: record.path as string,
          hash: (record.hash as string) || "",
          is_anchor: record.is_anchor === true,
        },
        generated_metadata: {
          start_line: startLine,
          num_lines: Math.max(1, endLine - startLine + 1),
        },
      };
    });

    return { data: chunks };
  }

  async retrieve(storeId: string): Promise<unknown> {
    const table = await this.getTable(storeId);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async create(options: CreateStoreOptions): Promise<unknown> {
    const table = await this.ensureTable(options.name);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async deleteFile(storeId: string, filePath: string): Promise<void> {
    const table = await this.getTable(storeId);
    const safePath = filePath.replace(/'/g, "''");
    await table.delete(`path = '${safePath}'`);
  }

  async getInfo(storeId: string): Promise<StoreInfo> {
    return {
      name: storeId,
      description: "Local Store",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      counts: {
        pending: 0,
        in_progress: 0,
      },
    };
  }

  getProfile(): LocalStoreProfile {
    return { ...this.profile };
  }

  async close(): Promise<void> {
    try {
      await this.workerManager.close();
    } catch (err) {
      // Silent cleanup - worker may have already exited
    }
    if (this.db) {
      try {
        // LanceDB connections don't have an explicit close, but we null the ref
        this.db = null;
      } catch (err) {
        // Silent cleanup
      }
    }
  }
}
