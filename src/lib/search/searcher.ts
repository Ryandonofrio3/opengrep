import type { Table } from "@lancedb/lancedb";
import { CONFIG } from "../../config";
import type {
  ChunkType,
  SearchFilter,
  SearchResponse,
  VectorRecord,
} from "../store/types";
import type { VectorDB } from "../store/vector-db";
import { escapeSqlString, normalizePath } from "../utils/filter-builder";
import { getWorkerPool } from "../workers/pool";

export class Searcher {
  constructor(private db: VectorDB) {}

  private mapRecordToChunk(
    record: Partial<VectorRecord>,
    score: number,
  ): ChunkType {
    const fullText = `${record.context_prev || ""}${record.display_text || record.content || ""}${record.context_next || ""} `;
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

    // Item 6: Anchors are recall helpers, not rank contenders
    if (record.is_anchor) {
      // Minimal penalty to break ties
      const anchorPenalty =
        Number.parseFloat(process.env.OSGREP_ANCHOR_PENALTY ?? "") || 0.99;
      adjusted *= anchorPenalty;
    } else {
      // Only boost non-anchors
      const chunkType = record.chunk_type || "";
      const boosted = [
        "function",
        "class",
        "method",
        "interface",
        "type_alias",
      ];
      if (boosted.includes(chunkType)) {
        const boostFactor =
          Number.parseFloat(process.env.OSGREP_CODE_BOOST ?? "") || 1.05;
        adjusted *= boostFactor;
      }
    }

    const pathStr = (record.path || "").toLowerCase();

    // Use path-segment and filename patterns to avoid false positives like "latest"
    const isTestPath =
      /(^|\/)(__tests__|tests?|specs?)(\/|$)/i.test(pathStr) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/i.test(pathStr);

    if (isTestPath) {
      const testPenalty =
        Number.parseFloat(process.env.OSGREP_TEST_PENALTY ?? "") || 0.9;
      adjusted *= testPenalty; // Downweight tests
    }
    if (
      pathStr.endsWith(".md") ||
      pathStr.endsWith(".mdx") ||
      pathStr.endsWith(".txt") ||
      pathStr.endsWith(".json") ||
      pathStr.endsWith(".lock") ||
      pathStr.includes("/docs/")
    ) {
      const docPenalty =
        Number.parseFloat(process.env.OSGREP_DOC_PENALTY ?? "") || 0.85;
      adjusted *= docPenalty; // Downweight docs/data
    }
    return adjusted;
  }

  private ftsIndexChecked = false;

  async search(
    query: string,
    top_k?: number,
    _search_options?: { rerank?: boolean },
    _filters?: SearchFilter,
    pathPrefix?: string,
  ): Promise<SearchResponse> {
    const finalLimit = top_k ?? 10;
    const doRerank = _search_options?.rerank ?? true;

    const pool = getWorkerPool();

    const {
      dense: queryVector,
      colbert: queryMatrixRaw,
      colbertDim,
      pooled_colbert_48d: queryPooled,
    } = await pool.encodeQuery(query);

    if (colbertDim !== CONFIG.COLBERT_DIM) {
      console.warn(
        `[Searcher] Warning: Query ColBERT dim (${colbertDim}) != Config (${CONFIG.COLBERT_DIM})`,
      );
    }

    const whereClause = pathPrefix
      ? `path LIKE '${escapeSqlString(normalizePath(pathPrefix))}%'`
      : undefined;

    const envPreK = Number.parseInt(process.env.OSGREP_PRE_K ?? "", 10);
    const PRE_RERANK_K =
      Number.isFinite(envPreK) && envPreK > 0
        ? envPreK
        : Math.max(finalLimit * 5, 500);
    let table: Table;
    try {
      table = await this.db.ensureTable();
    } catch {
      return { data: [] };
    }

    // Ensure FTS index exists (lazy init on first search)
    if (!this.ftsIndexChecked) {
      this.ftsIndexChecked = true; // Set immediately to prevent retry spam
      try {
        await this.db.createFTSIndex();
      } catch (e) {
        console.warn("[Searcher] Failed to ensure FTS index:", e);
      }
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[Searcher] FTS search failed: ${msg}`);
    }

    // Reciprocal Rank Fusion (vector + FTS)
    const RRF_K = 60;
    const candidateScores = new Map<string, number>();
    const docMap = new Map<string, VectorRecord>();

    vectorResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    ftsResults.forEach((doc, rank) => {
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      if (!docMap.has(key)) docMap.set(key, doc);
      const score = 1.0 / (RRF_K + rank + 1);
      candidateScores.set(key, (candidateScores.get(key) || 0) + score);
    });

    const fused = Array.from(candidateScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => docMap.get(key))
      .filter(Boolean) as VectorRecord[];

    // Item 8: Widen PRE_RERANK_K
    // Retrieve a wide set for Stage 1 filtering
    const envStage1 = Number.parseInt(process.env.OSGREP_STAGE1_K ?? "", 10);
    const STAGE1_K =
      Number.isFinite(envStage1) && envStage1 > 0 ? envStage1 : 200;
    const topCandidates = fused.slice(0, STAGE1_K);

    // Item 9: Two-stage rerank
    // Stage 1: Cheap pooled cosine filter
    let stage2Candidates = topCandidates;
    const envStage2K = Number.parseInt(process.env.OSGREP_STAGE2_K ?? "", 10);
    const STAGE2_K =
      Number.isFinite(envStage2K) && envStage2K > 0 ? envStage2K : 40;

    const envRerankTop = Number.parseInt(
      process.env.OSGREP_RERANK_TOP ?? "",
      10,
    );
    const RERANK_TOP =
      Number.isFinite(envRerankTop) && envRerankTop > 0
        ? envRerankTop
        : 20;
    const envBlend = Number.parseFloat(process.env.OSGREP_RERANK_BLEND ?? "");
    const FUSED_WEIGHT =
      Number.isFinite(envBlend) && envBlend >= 0 ? envBlend : 0.5;

    if (queryPooled && topCandidates.length > STAGE2_K) {
      const cosineScores = topCandidates.map((doc) => {
        if (!doc.pooled_colbert_48d) return -1;
        // Manual cosine sim since we don't have helper here easily
        // Assuming vectors are normalized (which they should be from orchestrator)
        let dot = 0;
        const docVec = doc.pooled_colbert_48d;
        for (let i = 0; i < queryPooled.length; i++) {
          dot += queryPooled[i] * (docVec[i] || 0);
        }
        return dot;
      });

      // Sort by cosine score and keep top N
      const withScore = topCandidates.map((doc, i) => ({
        doc,
        score: cosineScores[i],
      }));
      withScore.sort((a, b) => b.score - a.score);
      stage2Candidates = withScore.slice(0, STAGE2_K).map((x) => x.doc);
    }

    if (stage2Candidates.length === 0) {
      return { data: [] };
    }

    const rerankCandidates = stage2Candidates.slice(0, RERANK_TOP);

    const scores = doRerank
      ? await pool.rerank({
          query: queryMatrixRaw,
          docs: rerankCandidates.map((doc) => ({
            colbert: (doc.colbert as Buffer | Int8Array | number[]) ?? [],
            scale: typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1,
            token_ids: Array.isArray((doc as any).doc_token_ids)
              ? ((doc as any).doc_token_ids as number[])
              : undefined,
          })),
          colbertDim,
        })
      : rerankCandidates.map((doc, idx) => {
          // If rerank is disabled, fall back to fusion ordering with structural boost
          const key = doc.id || `${doc.path}:${doc.chunk_index}`;
          const fusedScore = candidateScores.get(key) ?? 0;
          // Small tie-breaker so later items don't all share 0
          return fusedScore || 1 / (idx + 1);
        });

    type ScoredItem = {
      record: typeof rerankCandidates[number];
      score: number;
    };

    const scored: ScoredItem[] = rerankCandidates.map((doc, idx) => {
      const base = scores?.[idx] ?? 0;
      const key = doc.id || `${doc.path}:${doc.chunk_index}`;
      const fusedScore = candidateScores.get(key) ?? 0;
      const blended = base + FUSED_WEIGHT * fusedScore;
      const boosted = this.applyStructureBoost(doc, blended);
      return { record: doc, score: boosted };
    });

    // Note: "boosted" was not previously declared -- fix to use "scored"
    scored.sort((a: ScoredItem, b: ScoredItem) => b.score - a.score);

    // Item 10: Per-file diversification
    const seenFiles = new Map<string, number>();
    const diversified: ScoredItem[] = [];
    const envMaxPerFile = Number.parseInt(
      process.env.OSGREP_MAX_PER_FILE ?? "",
      10,
    );
    const MAX_PER_FILE =
      Number.isFinite(envMaxPerFile) && envMaxPerFile > 0
        ? envMaxPerFile
        : 3;

    for (const item of scored) {
      const path = item.record.path || "";
      const count = seenFiles.get(path) || 0;
      if (count < MAX_PER_FILE) {
        diversified.push(item);
        seenFiles.set(path, count + 1);
      }
      if (diversified.length >= finalLimit) break;
    }

    const finalResults = diversified.map((item: ScoredItem) => ({
      ...item.record,
      _score: item.score,
      vector: undefined,
      colbert: undefined,
    }));

    return {
      data: finalResults.map((r: typeof finalResults[number]) => this.mapRecordToChunk(r, r._score || 0)),
    };
  }
}
