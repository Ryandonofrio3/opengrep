import type { Table } from "@lancedb/lancedb";
import { CONFIG } from "../../config";
import type {
  ChunkType,
  SearchFilter,
  SearchResponse,
  VectorRecord,
} from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { getWorkerPool } from "../workers/pool";
import { escapeSqlString, normalizePath } from "../utils/filter-builder";

export class Searcher {
  constructor(private db: VectorDB) { }

  private mapRecordToChunk(
    record: Partial<VectorRecord>,
    score: number,
  ): ChunkType {
    const fullText = `${record.context_prev || ""}${record.content || ""}${record.context_next || ""} `;
    const startLine = record.start_line || 0;
    const endLine = record.end_line || startLine;

    return {
      type: "text",
      text: fullText,
      score,
      metadata: {
        path: record.path || "",
        hash: record.hash || "",
        is_anchor: !!record.is_anchor,
      },
      generated_metadata: {
        start_line: startLine,
        num_lines: Math.max(1, endLine - startLine + 1),
        type: record.chunk_type,
      },
    };
  }

  private applyStructureBoost(
    record: Partial<VectorRecord>,
    score: number,
  ): number {
    let adjusted = score;
    const chunkType = record.chunk_type || "";
    const boosted = ["function", "class", "method", "interface", "type_alias"];
    if (boosted.includes(chunkType)) {
      adjusted *= 1.25;
    }
    const pathStr = (record.path || "").toLowerCase();
    // Aggressive test detection: match "test" or "spec" anywhere in the path
    // but try to avoid common false positives like "latest" or "special" if possible.
    // However, the user requested aggressive matching, so we will follow the PR's lead.
    if (
      pathStr.includes("test") ||
      pathStr.includes("spec") ||
      pathStr.includes("__tests__")
    ) {
      adjusted *= 0.85;
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".mdx") ||
      pathStr.endsWith(".txt") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      adjusted *= 0.5;
    }
    return adjusted;
  }

  async search(
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: SearchFilter,
    pathPrefix?: string,
  ): Promise<SearchResponse> {
    const finalLimit = top_k ?? 10;

    const pool = getWorkerPool();

    const {
      dense: queryVector,
      colbert: queryMatrixRaw,
      colbertDim,
    } = await pool.encodeQuery(query);

    if (colbertDim !== CONFIG.COLBERT_DIM) {
      console.warn(
        `[Searcher] Warning: Query ColBERT dim (${colbertDim}) != Config (${CONFIG.COLBERT_DIM})`,
      );
    }

    const whereClause = pathPrefix
      ? `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`
      : undefined;

    const PRE_RERANK_K = Math.max(finalLimit * 3, 150);

    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      return { data: [] };
    }

    let vectorQuery = table.vectorSearch(queryVector).limit(PRE_RERANK_K);
    if (whereClause) {
      vectorQuery = vectorQuery.where(whereClause);
    }
    const vectorResults = (await vectorQuery.toArray()) as VectorRecord[];

    let ftsResults: VectorRecord[] = [];
    try {
      let ftsQuery = table.search(query).limit(PRE_RERANK_K);
      if (whereClause) {
        ftsQuery = ftsQuery.where(whereClause);
      }
      ftsResults = (await ftsQuery.toArray()) as VectorRecord[];
    } catch (_e) {
      // ignore fts failures
    }

    const seen = new Set<string>();
    const candidates: VectorRecord[] = [];

    for (const r of [...vectorResults, ...ftsResults]) {
      const key = `${r.path}:${r.chunk_index}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(r);
      }
    }

    if (candidates.length === 0) {
      return { data: [] };
    }

    const scores = await pool.rerank({
      query: queryMatrixRaw.map((row: number[]) => Array.from(row)),
      docs: candidates.map((doc) => ({
        colbert:
          (doc.colbert as Buffer | Int8Array | number[]) ?? new Int8Array(),
        scale: typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1,
      })),
      colbertDim,
    });

    const scored = candidates.map((doc, idx) => ({
      record: doc,
      score: scores?.[idx] ?? 0,
    }));

    const boosted = scored.map((item) => {
      const boost = this.applyStructureBoost(item.record, item.score);
      return { ...item, score: boost };
    });

    boosted.sort((a, b) => b.score - a.score);

    const finalResults = boosted.slice(0, finalLimit).map((item) => ({
      ...item.record,
      _score: item.score,
      vector: undefined,
      colbert: undefined,
    }));

    return {
      data: finalResults.map((r) => this.mapRecordToChunk(r, r._score || 0)),
    };
  }
}
