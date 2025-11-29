import { workerManager } from "../workers/worker-manager";
import { CONFIG } from "../../config";
import { maxSim, cosineSim } from "./colbert-math";
import type {
    SearchFilter,
    SearchResponse,

    VectorRecord,
    ChunkType,
} from "../store/store";
import { VectorDB } from "../store/vector-db";

export class Searcher {
    private readonly queryPrefix = CONFIG.QUERY_PREFIX;
    private readonly colbertDim = CONFIG.COLBERT_DIM;

    constructor(private db: VectorDB) { }

    private mapRecordToChunk(record: VectorRecord, score: number): ChunkType {
        const fullText = `${record.context_prev || ""}${record.content || ""}${record.context_next || ""} `;
        const startLine = record.start_line || 0;
        const endLine = record.end_line || startLine;

        return {
            type: "text",
            text: fullText,
            score,
            metadata: {
                path: record.path,
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

    private applyStructureBoost(record: VectorRecord, score: number): number {
        let adjusted = score;
        const chunkType = record.chunk_type || "";
        const boosted = ["function", "class", "method", "interface", "type_alias"];
        if (boosted.includes(chunkType)) {
            adjusted *= 1.25;
        }
        const pathStr = record.path.toLowerCase();
        if (
            pathStr.includes(".test.") ||
            pathStr.includes(".spec.") ||
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
        storeId: string,
        query: string,
        top_k?: number,
        _search_options?: { rerank?: boolean },
        _filters?: SearchFilter,
    ): Promise<SearchResponse> {
        let table;
        try {
            table = await this.db.ensureTable(storeId);
        } catch {
            return { data: [] };
        }

        const finalLimit = top_k ?? 10;

        // 1. Dense + ColBERT query encoding
        const queryEnc = await workerManager.encodeQuery(this.queryPrefix + query);
        const queryVector = queryEnc.dense;
        const doRerank = _search_options?.rerank !== false;

        if (queryEnc.colbertDim && queryEnc.colbertDim !== this.colbertDim) {
            console.warn(
                `[osgrep] Warning: Model dimension mismatch.Config: ${this.colbertDim}, Model: ${queryEnc.colbertDim}. Scores may be inaccurate.`,
            );
        }

        // Optional path filter support
        const allFilters = Array.isArray((_filters as { all?: unknown })?.all)
            ? ((_filters as { all?: unknown }).all as Record<string, unknown>[])
            : [];
        const pathFilterEntry = allFilters.find(
            (f) => f?.key === "path" && f?.operator === "starts_with",
        );
        const pathPrefix =
            typeof pathFilterEntry?.value === "string" ? pathFilterEntry.value : "";

        const whereClause = pathPrefix
            ? `path LIKE '${pathPrefix.replace(/'/g, "''").replace(/\\/g, "\\\\")}%'`
            : undefined;

        // 2. HYBRID RECALL
        const docClause =
            "(path LIKE '%.md' OR path LIKE '%.mdx' OR path LIKE '%.txt' OR path LIKE '%.json')";
        const codeClause = `NOT ${docClause}`;

        // A. Search Code
        const codeQuery = table
            .search(queryVector)
            .where(whereClause ? `${whereClause} AND ${codeClause}` : codeClause)
            .limit(100);

        // B. Search Docs
        const docQuery = table
            .search(queryVector)
            .where(whereClause ? `${whereClause} AND ${docClause}` : docClause)
            .limit(100);

        // C. FTS Search
        let ftsPromise: Promise<VectorRecord[]> = Promise.resolve([]);
        try {
            let ftsQuery = table.search(query);
            if (whereClause) {
                ftsQuery = ftsQuery.where(whereClause);
            }
            ftsPromise = (
                ftsQuery.limit(100).toArray() as Promise<VectorRecord[]>
            ).catch((e) => {
                console.warn(
                    "FTS search failed (index missing?):",
                    e instanceof Error ? e.message : String(e),
                );
                return [];
            });
        } catch (e) {
            console.warn("FTS search failed, falling back to pure vector search", e);
        }

        const [codeResults, docResults, ftsResults] = await Promise.all([
            codeQuery.toArray() as Promise<VectorRecord[]>,
            docQuery.toArray() as Promise<VectorRecord[]>,
            ftsPromise,
        ]);

        const denseCandidates = [...codeResults, ...docResults, ...ftsResults];

        // Deduplicate
        const candidatesMap = new Map<string, VectorRecord>();
        denseCandidates.forEach((r) => {
            const key = `${r.path}:${r.start_line}`;
            if (!candidatesMap.has(key)) candidatesMap.set(key, r);
        });
        const candidates = Array.from(candidatesMap.values());

        if (candidates.length === 0) {
            return { data: [] };
        }

        // 3. Rerank
        const queryMatrix = doRerank ? queryEnc.colbert : [];



        const reranked = candidates.map((doc) => {
            const denseVec = Array.isArray(doc.vector)
                ? (doc.vector as number[])
                : [];
            let score = cosineSim(queryVector, denseVec);

            if (
                doRerank &&
                doc.colbert &&
                !(Array.isArray(doc.colbert) && doc.colbert.length === 0) &&
                queryMatrix.length > 0
            ) {
                const scale =
                    typeof doc.colbert_scale === "number" ? doc.colbert_scale : 1.0;
                let int8: Int8Array | null = null;
                if (Buffer.isBuffer(doc.colbert)) {
                    const buffer = doc.colbert as Buffer;
                    int8 = new Int8Array(
                        buffer.buffer,
                        buffer.byteOffset,
                        buffer.byteLength,
                    );
                } else if (Array.isArray(doc.colbert)) {
                    int8 = new Int8Array(doc.colbert as number[]);
                }

                if (int8) {
                    const docMatrix: number[][] = [];
                    const stride = this.colbertDim;

                    for (let i = 0; i < int8.length; i += stride) {
                        const row: number[] = [];
                        let isPadding = true;

                        for (let k = 0; k < stride; k++) {
                            if (i + k >= int8.length) break;
                            const val = (int8[i + k] / 127) * scale;
                            if (val !== 0) isPadding = false;
                            row.push(val);
                        }
                        if (!isPadding && row.length === stride) {
                            docMatrix.push(row);
                        }
                    }

                    if (docMatrix.length > 0) {
                        score = maxSim(queryMatrix, docMatrix);
                    }
                }
            }

            score = this.applyStructureBoost(doc, score);

            return { record: doc, score };
        });

        return {
            data: reranked
                .sort((a, b) => b.score - a.score)
                .slice(0, finalLimit)
                .map((x) => this.mapRecordToChunk(x.record, x.score)),
        };
    }
}
