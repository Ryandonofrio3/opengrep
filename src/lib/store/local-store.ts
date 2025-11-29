import type {
  CreateStoreOptions,
  IndexFileOptions,
  PreparedChunk,
  SearchFilter,
  SearchResponse,
  Store,
  StoreFile,
  StoreInfo,
  VectorRecord,
} from "./store";
import { VectorDB } from "./vector-db";
import { Indexer } from "../index/indexer";
import { Searcher } from "../search/searcher";

export class LocalStore implements Store {
  private db: VectorDB;
  private indexer: Indexer;
  private searcher: Searcher;

  constructor() {
    this.db = new VectorDB();
    this.indexer = new Indexer(this.db);
    this.searcher = new Searcher(this.db);
  }

  listFiles(storeId: string): AsyncGenerator<StoreFile> {
    return this.db.listFiles(storeId) as AsyncGenerator<StoreFile>;
  }

  async indexFile(
    storeId: string,
    file: File | ReadableStream | NodeJS.ReadableStream | string,
    options: IndexFileOptions,
  ): Promise<PreparedChunk[]> {
    return this.indexer.indexFile(storeId, file, options);
  }

  async insertBatch(storeId: string, records: VectorRecord[]): Promise<void> {
    return this.indexer.insertBatch(storeId, records);
  }

  async createFTSIndex(storeId: string): Promise<void> {
    return this.db.createFTSIndex(storeId);
  }

  async createVectorIndex(storeId: string): Promise<void> {
    return this.db.createVectorIndex(storeId);
  }

  async search(
    storeId: string,
    query: string,
    top_k?: number,
    search_options?: { rerank?: boolean },
    filters?: SearchFilter,
  ): Promise<SearchResponse> {
    return this.searcher.search(storeId, query, top_k, search_options, filters);
  }

  async retrieve(storeId: string): Promise<unknown> {
    const table = await this.db.ensureTable(storeId);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async create(options: CreateStoreOptions): Promise<unknown> {
    const table = await this.db.ensureTable(options.name);
    const tableInfo = table as { info?: () => unknown };
    return typeof tableInfo.info === "function" ? tableInfo.info() : true;
  }

  async deleteFile(storeId: string, filePath: string): Promise<void> {
    return this.db.deleteFile(storeId, filePath);
  }

  async deleteFiles(storeId: string, filePaths: string[]): Promise<void> {
    // Naive implementation for now, or add batch delete to VectorDB
    // VectorDB currently has deleteFile (single).
    // Let's just loop for now or add deleteFiles to VectorDB later.
    // Actually, let's implement the batch logic here or in VectorDB.
    // The original LocalStore had batching logic.
    // I should probably move that to VectorDB.
    // For now, I'll just loop to keep it simple, or re-implement the batching here.
    // Re-implementing batching here is safer for performance.
    const unique = Array.from(new Set(filePaths));
    if (unique.length === 0) return;

    const batchSize = 900;
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      // We can't easily do the SQL IN clause without exposing the table or adding a method to VectorDB.
      // I'll add a TODO to move this to VectorDB, and for now just call deleteFile in parallel.
      await Promise.all(batch.map((p) => this.db.deleteFile(storeId, p)));
    }
  }

  async deleteStore(storeId: string): Promise<void> {
    return this.db.deleteStore(storeId);
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

  async close(): Promise<void> {
    // No-op for now as lancedb connection is managed internally/globally
  }
}
