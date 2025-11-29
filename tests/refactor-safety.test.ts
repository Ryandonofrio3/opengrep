import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LocalStore } from "../src/lib/store/local-store";
import { createFileSystem } from "../src/lib/core/context";
import { DEFAULT_IGNORE_PATTERNS } from "../src/lib/index/ignore-patterns";

const { MOCK_HOME, TEMP_DIR, TEST_REPO } = vi.hoisted(() => {
    const _fs = require("node:fs");
    const _path = require("node:path");
    const _os = require("node:os");
    const tmp = _fs.mkdtempSync(_path.join(_os.tmpdir(), "osgrep-safety-test-"));
    return {
        TEMP_DIR: tmp,
        MOCK_HOME: _path.join(tmp, "home"),
        TEST_REPO: _path.join(tmp, "repo"),
    };
});

vi.mock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:os")>();
    return {
        ...actual,
        homedir: () => MOCK_HOME,
    };
});

describe("Refactor Safety Net (Integration)", () => {
    let store: LocalStore;
    const storeId = "safety-test-store";

    beforeAll(async () => {
        // Setup directories
        fs.mkdirSync(MOCK_HOME, { recursive: true });
        fs.mkdirSync(TEST_REPO, { recursive: true });

        // Create some test files
        fs.writeFileSync(path.join(TEST_REPO, "hello.ts"), `
      export function hello() {
        console.log("Hello from vector search!");
      }
    `);
        fs.writeFileSync(path.join(TEST_REPO, "doc.md"), `
      # Documentation
      This is a documentation file about search features.
    `);
        fs.writeFileSync(path.join(TEST_REPO, "ignored.txt"), "secret");

        // Initialize Store
        store = new LocalStore();
        await store.create({ name: storeId });
    });

    afterAll(async () => {
        // Cleanup
        if (store) {
            try {
                await store.deleteStore(storeId);
            } catch { }
        }
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("indexes files correctly", async () => {
        const fileSystem = createFileSystem({ ignorePatterns: DEFAULT_IGNORE_PATTERNS });

        // Index hello.ts
        const helloPath = path.join(TEST_REPO, "hello.ts");
        const helloChunks = await store.indexFile(storeId, helloPath, {
            external_id: helloPath,
            metadata: { path: helloPath, hash: "hash1" },
            content: fs.readFileSync(helloPath, "utf-8")
        });
        expect(helloChunks.length).toBeGreaterThan(0);
        await store.insertBatch(storeId, helloChunks as any);

        // Index doc.md
        const docPath = path.join(TEST_REPO, "doc.md");
        const docChunks = await store.indexFile(storeId, docPath, {
            external_id: docPath,
            metadata: { path: docPath, hash: "hash2" },
            content: fs.readFileSync(docPath, "utf-8")
        });
        expect(docChunks.length).toBeGreaterThan(0);
        await store.insertBatch(storeId, docChunks as any);

        // Create FTS index to avoid warnings in subsequent searches
        await store.createFTSIndex(storeId);
    });

    it("performs vector search", async () => {
        // We expect "vector search" to match hello.ts because of the content
        const results = await store.search(storeId, "vector search", 5);
        expect(results.data.length).toBeGreaterThan(0);

        const helloMatch = results.data.find(r => r.metadata?.path.endsWith("hello.ts"));
        expect(helloMatch).toBeDefined();
        expect(helloMatch?.text).toContain("Hello from vector search");
    });

    it("performs hybrid/FTS search", async () => {


        // "documentation" should match doc.md via FTS/Hybrid
        const results = await store.search(storeId, "documentation", 5);
        expect(results.data.length).toBeGreaterThan(0);

        const docMatch = results.data.find(r => r.metadata?.path.endsWith("doc.md"));
        expect(docMatch).toBeDefined();
        expect(docMatch?.text).toContain("Documentation");
    });

    it("deletes files", async () => {
        const helloPath = path.join(TEST_REPO, "hello.ts");
        await store.deleteFile(storeId, helloPath);

        const results = await store.search(storeId, "vector search", 5);
        const helloMatch = results.data.find(r => r.metadata?.path.endsWith("hello.ts"));
        expect(helloMatch).toBeUndefined();
    });
});
