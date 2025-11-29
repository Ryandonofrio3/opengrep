import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RepositoryScanner } from "../src/lib/index/scanner";
import type { IndexFileOptions, Store } from "../src/lib/store/store";
import { initialSync } from "../src/lib/index/syncer";

class FakeStore implements Store {
  indexed: Array<{ storeId: string; externalId?: string }> = [];
  deleted: string[] = [];
  ftsCount = 0;
  vecCount = 0;

  async *listFiles(_storeId: string) {
    // empty store
    yield* [];
  }

  async indexFile(
    storeId: string,
    _file: string | File | ReadableStream | NodeJS.ReadableStream,
    options: IndexFileOptions,
  ) {
    this.indexed.push({ storeId, externalId: options.external_id });
    return [];
  }

  async insertBatch(_storeId: string, _records: any[]) { }

  async deleteFile(_storeId: string, externalId: string) {
    this.deleted.push(externalId);
  }

  async deleteFiles(_storeId: string, externalIds: string[]) {
    this.deleted.push(...externalIds);
  }

  async deleteStore(_storeId: string) { }

  async search(
    _storeId: string,
    _query: string,
    _top_k?: number,
    _search_options?: { rerank?: boolean },
  ) {
    return { data: [] };
  }

  async retrieve(_storeId: string) {
    return {};
  }

  async create(_options: any) {
    return {};
  }

  async ask(
    _storeId: string,
    _question: string,
    _top_k?: number,
    _search_options?: { rerank?: boolean },
  ) {
    return { answer: "", sources: [] };
  }

  async getInfo(_storeId: string) {
    return {
      name: "test",
      description: "test",
      created_at: "",
      updated_at: "",
      counts: { pending: 0, in_progress: 0 },
    };
  }

  async createFTSIndex(_storeId: string) {
    this.ftsCount += 1;
  }

  async createVectorIndex(_storeId: string) {
    this.vecCount += 1;
  }

  // Unused by these tests
  async *listStoreIds() {
    yield* [];
  }

  async close() { }
}

class StubScanner {
  constructor(
    private files: string[],
    private ignored: Set<string> = new Set(),
  ) { }

  async *getFiles(_dirRoot: string): AsyncGenerator<string> {
    yield* this.files;
  }

  isIgnored(filePath: string): boolean {
    return this.ignored.has(filePath);
  }

  loadOsgrepignore(): void { }

  // Add missing properties required by RepositoryScanner class
  isGitRepository(_dir: string): boolean { return false; }
  getRepositoryRoot(_dir: string): string | null { return null; }
  getRemoteUrl(_dir: string): string | null { return null; }
  getGitIgnoreFilter(_dir: string): any { return null; }
  getGitFiles(_dir: string): AsyncGenerator<string> { return (async function* () { })(); }
}

describe("initialSync edge cases", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-sync-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("handles an empty repository and store without indexing", async () => {
    const store = new FakeStore();
    const fsStub = new StubScanner([]);

    const result = await initialSync(
      store,
      fsStub as unknown as RepositoryScanner,
      "store",
      tempRoot,
      false,
    );

    expect(result.total).toBe(0);
    expect(result.indexed).toBe(0);
    expect(store.indexed.length).toBe(0);
    expect(store.ftsCount).toBe(0);
    expect(store.vecCount).toBe(0);
  });

  it("skips indexing when every file is ignored", async () => {
    const store = new FakeStore();
    const ignoredFile = path.join(tempRoot, "ignored.ts");
    await fs.writeFile(ignoredFile, "content");

    const fsStub = new StubScanner([ignoredFile], new Set([ignoredFile]));

    const result = await initialSync(
      store,
      fsStub as unknown as RepositoryScanner,
      "store",
      tempRoot,
      false,
    );

    expect(result.total).toBe(0);
    expect(result.indexed).toBe(0);
    expect(store.indexed.length).toBe(0);
    expect(store.ftsCount).toBe(0);
    expect(store.vecCount).toBe(0);
  });
});
