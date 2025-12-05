import { describe, expect, it, vi, beforeEach } from "vitest";

const putSpy = vi.fn();
const delSpy = vi.fn();
const getSpy = vi.fn();
const getAllKeysSpy = vi.fn(async () => new Set<string>(["a.ts"]));
const closeSpy = vi.fn();

vi.mock("../store/meta-cache", () => {
    class MetaCacheMock {
        private m = new Map<string, any>();
        constructor(_p: string) {
            this.m.set("a.ts", { hash: "h1", mtimeMs: 0, size: 50 });
        }
        get(p: string) {
            getSpy(p);
            return this.m.get(p);
        }
        async getAllKeys() {
            return getAllKeysSpy();
        }
        put(p: string, e: any) {
            putSpy(p, e);
            this.m.set(p, e);
        }
        delete(p: string) {
            delSpy(p);
            this.m.delete(p);
        }
        close() {
            closeSpy();
        }
    }
    return { MetaCache: MetaCacheMock };
});

const hasAnyRowsSpy = vi.fn(async () => {
    throw new Error("hasAnyRows should not be called in dryRun");
});
const dropSpy = vi.fn();
const closeDbSpy = vi.fn();

vi.mock("../store/vector-db", () => {
    class VectorDBMock {
        constructor(_p: string) { }
        hasAnyRows() {
            return hasAnyRowsSpy();
        }
        drop() {
            return dropSpy();
        }
        close() {
            return closeDbSpy();
        }
        // not used in these tests but referenced elsewhere
        deletePaths() {
            return Promise.resolve();
        }
        insertBatch() {
            return Promise.resolve();
        }
        createFTSIndex() {
            return Promise.resolve();
        }
    }
    return { VectorDB: VectorDBMock };
});

vi.mock("../utils/project-root", () => ({
    ensureProjectPaths: (_root: string) => ({
        root: "/repo",
        osgrepDir: "/repo/.osgrep",
        lancedbDir: "/repo/.osgrep/lancedb",
        cacheDir: "/repo/.osgrep/cache",
        lmdbPath: "/repo/.osgrep/cache/meta.lmdb",
        configPath: "/repo/.osgrep/config.json",
    }),
}));

vi.mock("../utils/lock", () => ({
    acquireWriterLock: async () => ({ release: async () => { } }),
    acquireWriterLockWithRetry: async () => ({ release: async () => { } }),
}));

vi.mock("../utils/file-utils", () => ({
    isIndexableFile: () => true,
}));

vi.mock("../workers/pool", () => ({
    getWorkerPool: () => ({
        processFile: async () => ({
            vectors: [],
            hash: "h1",
            mtimeMs: 1,
            size: 100,
            shouldDelete: false,
        }),
    }),
}));

vi.mock("node:fs", () => ({
    existsSync: () => false,
    readFileSync: () => "",
    realpathSync: (p: string) => p,
    promises: {
        stat: async () => ({ mtimeMs: 1, size: 100 }),
    },
    rmSync: vi.fn(),
}));

vi.mock("fast-glob", () => {
    async function* gen() {
        yield "a.ts";
    }
    return { default: { stream: () => gen() } };
});

import { initialSync } from "./syncer";

describe("initialSync dryRun", () => {
    beforeEach(() => {
        putSpy.mockClear();
        delSpy.mockClear();
        getSpy.mockClear();
        getAllKeysSpy.mockClear();
        hasAnyRowsSpy.mockClear();
        dropSpy.mockClear();
    });

    it("does not call VectorDB.hasAnyRows in dryRun (avoids LanceDB writes)", async () => {
        const res = await initialSync({ projectRoot: "/repo", dryRun: true });
        expect(res.processed).toBe(1);
        expect(res.indexed).toBe(0);
        expect(hasAnyRowsSpy).not.toHaveBeenCalled();
    });

    it("does not write MetaCache when cached.hash === result.hash in dryRun", async () => {
        await initialSync({ projectRoot: "/repo", dryRun: true });
        expect(putSpy).not.toHaveBeenCalled();
        expect(delSpy).not.toHaveBeenCalled();
    });

    it("reset:true + dryRun:true does not drop VectorDB or delete LMDB", async () => {
        await initialSync({ projectRoot: "/repo", dryRun: true, reset: true });
        expect(dropSpy).not.toHaveBeenCalled();
        // hasAnyRows also must not be called
        expect(hasAnyRowsSpy).not.toHaveBeenCalled();
    });
});
