import { v4 as uuidv4 } from "uuid";
import {
    TreeSitterChunker,
    buildAnchorChunk,
    ChunkWithContext,
    formatChunkText,
} from "./chunker";
import type {
    IndexFileOptions,
    PreparedChunk,
    VectorRecord,
} from "../store/store";
import { VectorDB } from "../store/vector-db";

const PROFILE_ENABLED =
    process.env.OSGREP_PROFILE === "1" || process.env.OSGREP_PROFILE === "true";

export class Indexer {
    private chunker = new TreeSitterChunker();

    constructor(private db: VectorDB) {
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

    async indexFile(
        _storeId: string,
        file: File | ReadableStream | NodeJS.ReadableStream | string,
        options: IndexFileOptions,
    ): Promise<PreparedChunk[]> {
        const fileIndexStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
        let fileChunkMs = 0;

        // Read file content
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

        // Chunking
        const chunkStart = PROFILE_ENABLED ? process.hrtime.bigint() : null;
        const { chunks: parsedChunks, metadata } = await this.chunker.chunk(
            options.metadata?.path || "unknown",
            content,
        );

        if (PROFILE_ENABLED && chunkStart) {
            const chunkEnd = process.hrtime.bigint();
            fileChunkMs += Number(chunkEnd - chunkStart) / 1_000_000;
        }

        const anchorChunk = buildAnchorChunk(
            options.metadata?.path || "unknown",
            content,
            metadata
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
                    chunkWithContext.isAnchor === true ||
                    (anchorChunk ? idx === 0 : false),
            };
        });

        const chunkTexts = chunks.map((chunk) =>
            formatChunkText(chunk, options.metadata?.path || ""),
        );

        const pendingWrites: PreparedChunk[] = [];

        for (let i = 0; i < chunkTexts.length; i++) {
            const chunk = chunks[i];
            const prev = chunkTexts[i - 1];
            const next = chunkTexts[i + 1];

            pendingWrites.push({
                id: uuidv4(),
                path: options.metadata?.path || "",
                hash: options.metadata?.hash || "",
                content: chunkTexts[i],
                context_prev: typeof prev === "string" ? prev : undefined,
                context_next: typeof next === "string" ? next : undefined,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                chunk_index: chunk.chunkIndex,
                is_anchor: chunk.isAnchor === true,
                chunk_type: typeof chunk.type === "string" ? chunk.type : undefined,
            });
        }

        if (PROFILE_ENABLED && fileIndexStart) {
            const end = process.hrtime.bigint();
            const total = Number(end - fileIndexStart) / 1_000_000;
            console.log(
                `[profile] index ${options.metadata?.path ?? "unknown"} • chunks = ${chunks.length} chunkTime = ${fileChunkMs.toFixed(1)}ms total = ${total.toFixed(1)} ms`,
            );
        }

        return pendingWrites;
    }

    async insertBatch(storeId: string, records: VectorRecord[]): Promise<void> {
        await this.db.insertBatch(storeId, records);
    }
}
