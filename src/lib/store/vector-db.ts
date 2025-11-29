import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
    Binary,
    Bool,
    Field,
    FixedSizeList,
    Float32,
    Float64,
    Int32,
    Schema,
    Utf8,
} from "apache-arrow";
import { CONFIG } from "../../config";
import type { VectorRecord } from "./store";

export class VectorDB {
    private db: lancedb.Connection | null = null;
    private readonly VECTOR_DIMENSIONS = CONFIG.VECTOR_DIMENSIONS;

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
            chunk_type: "",
            vector: Array(this.VECTOR_DIMENSIONS).fill(0),
            colbert: Buffer.alloc(0),
            colbert_scale: 1,
        };
    }

    private normalizeVector(vector: unknown): number[] {
        const source =
            Array.isArray(vector) && vector.every((v) => typeof v === "number")
                ? (vector as number[])
                : ArrayBuffer.isView(vector)
                    ? Array.from(vector as unknown as ArrayLike<number>)
                    : [];
        const trimmed = source.slice(0, this.VECTOR_DIMENSIONS);
        if (trimmed.length < this.VECTOR_DIMENSIONS) {
            trimmed.push(...Array(this.VECTOR_DIMENSIONS - trimmed.length).fill(0));
        }
        return trimmed;
    }

    async ensureTable(storeId: string): Promise<lancedb.Table> {
        const db = await this.getDb();
        const schema = new Schema([
            new Field("id", new Utf8(), false),
            new Field("path", new Utf8(), false),
            new Field("hash", new Utf8(), false),
            new Field("content", new Utf8(), false),
            new Field("start_line", new Int32(), false),
            new Field("end_line", new Int32(), false),
            new Field(
                "vector",
                new FixedSizeList(
                    this.VECTOR_DIMENSIONS,
                    new Field("item", new Float32(), false),
                ),
                false,
            ),
            new Field("chunk_index", new Int32(), true),
            new Field("is_anchor", new Bool(), true),
            new Field("context_prev", new Utf8(), true),
            new Field("context_next", new Utf8(), true),
            new Field("chunk_type", new Utf8(), true),
            new Field("colbert", new Binary(), true),
            new Field("colbert_scale", new Float64(), true),
        ]);

        try {
            const table = await db.openTable(storeId);
            // Basic schema validation could go here
            return table;
        } catch (err) {
            try {
                const table = await db.createTable(storeId, [this.baseSchemaRow()], {
                    schema,
                });
                await table.delete('id = "seed"');
                return table;
            } catch (createErr) {
                const message =
                    createErr instanceof Error ? createErr.message : String(createErr);
                if (message.toLowerCase().includes("already exists")) {
                    return await db.openTable(storeId);
                }
                throw createErr;
            }
        }
    }

    async insertBatch(storeId: string, records: VectorRecord[]): Promise<void> {
        if (records.length === 0) return;

        const sanitizeRecord = (rec: VectorRecord): VectorRecord => {
            const vecArray =
                typeof rec.vector?.toString === "function" && !Array.isArray(rec.vector)
                    ? Array.from(rec.vector as ArrayLike<number>)
                    : Array.isArray(rec.vector)
                        ? (rec.vector as number[])
                        : [];
            const normalizedVector = this.normalizeVector(vecArray);

            const colBuffer = Buffer.isBuffer(rec.colbert)
                ? rec.colbert
                : Array.isArray(rec.colbert)
                    ? Buffer.from(new Int8Array(rec.colbert as number[]))
                    : ArrayBuffer.isView(rec.colbert)
                        ? Buffer.from(
                            new Int8Array(Array.from(rec.colbert as ArrayLike<number>)),
                        )
                        : Buffer.alloc(0);

            return {
                ...rec,
                vector: Array.from(normalizedVector),
                colbert: Buffer.from(new Uint8Array(colBuffer)),
                colbert_scale:
                    typeof rec.colbert_scale === "number" ? rec.colbert_scale : 1,
            };
        };

        const sanitized = records.map(sanitizeRecord);
        const table = await this.ensureTable(storeId);
        await table.add(sanitized);
    }

    async createFTSIndex(storeId: string): Promise<void> {
        const table = await this.ensureTable(storeId);
        try {
            await table.createIndex("content", {
                config: lancedb.Index.fts(),
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!msg.includes("already exists")) {
                console.warn("Failed to create FTS index:", e);
            }
        }
    }

    async createVectorIndex(storeId: string): Promise<void> {
        const table = await this.ensureTable(storeId);
        const rowCount = await table.countRows();
        if (rowCount < 4000) return;

        try {
            const numPartitions = Math.max(
                8,
                Math.min(64, Math.floor(rowCount / 100)),
            );
            await table.createIndex("vector", {
                type: "ivf_flat",
                num_partitions: numPartitions,
            } as Record<string, unknown>);
        } catch (e) {
            // Fallback logic omitted for brevity, can re-add if needed
            console.warn("Failed to create vector index:", e);
        }
    }

    async deleteFile(storeId: string, filePath: string): Promise<void> {
        const table = await this.ensureTable(storeId);
        const safePath = filePath.replace(/'/g, "''");
        await table.delete(`path = '${safePath}'`);
    }

    async *listFiles(storeId: string): AsyncGenerator<{ external_id: string; metadata: { path: string; hash: string } }> {
        const table = await this.ensureTable(storeId);
        let results: VectorRecord[] = [];
        try {
            results = (await table
                .query()
                .where("is_anchor = true")
                .select(["path", "hash"])
                .toArray()) as VectorRecord[];
        } catch {
            results = (await table
                .query()
                .select(["path", "hash"])
                .toArray()) as VectorRecord[];
        }

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
    }

    async deleteStore(storeId: string): Promise<void> {
        const db = await this.getDb();
        try {
            await db.dropTable(storeId);
        } catch { }
    }
}
