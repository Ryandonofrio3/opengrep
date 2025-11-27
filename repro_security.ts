
import { LocalStore } from "./src/lib/local-store";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Mock CONFIG to avoid loading the real one if it causes issues, 
// but we might need the real one for constants. 
// Let's assume we can run this with `npx tsx repro_security.ts`

async function testVectorDimensionCheck() {
    console.log("Testing Vector Dimension Check...");
    const store = new LocalStore();

    // Access private method via any cast or just test insertBatch
    // We'll test insertBatch with a bad vector

    const badRecord = {
        id: "test",
        path: "test",
        hash: "test",
        content: "test",
        start_line: 0,
        end_line: 0,
        chunk_index: 0,
        is_anchor: false,
        context_prev: "",
        context_next: "",
        chunk_type: "",
        vector: [1, 2, 3], // Too short!
        colbert: Buffer.alloc(0),
        colbert_scale: 1,
    };

    try {
        // We need to mock the DB part or just let it fail at the DB level if we can't mock it easily.
        // Actually, let's look at normalizeVector. It's private.
        // We can use the fact that insertBatch calls it.
        // But insertBatch also connects to DB.

        // Let's rely on the fact that we are modifying the code to throw.
        // We can try to call the private method using 'any'
        const normalized = (store as any).normalizeVector([1, 2, 3]);
        console.log("Vector was normalized (unexpected if fix applied):", normalized.length);
        if (normalized.length === 384) { // Assuming 384 is the default
            console.log("FAIL: Vector was silently padded.");
        } else {
            console.log("SUCCESS: Vector was not padded to default (or default is different).");
        }
    } catch (e) {
        console.log("SUCCESS: Caught expected error:", e.message);
    }
}

async function testSqlInjection() {
    console.log("\nTesting SQL Injection escaping...");
    const store = new LocalStore();
    const dangerousPath = "test'; DROP TABLE students; --";
    const backslashPath = "test\\";

    // We want to see how it constructs the query.
    // Since we can't easily intercept the DB call without mocking lancedb,
    // we will verify the fix by code inspection or by trying to run it against a temp DB.
    // For this script, let's just try to run deleteFile with a dangerous path and see if it crashes or works.
    // If we fix it, it should just try to delete that file.

    const tempStoreId = "test_security_" + Date.now();
    try {
        await store.create({ name: tempStoreId, embedding_model: "test" });

        console.log("Testing basic SQL injection...");
        await store.deleteFile(tempStoreId, dangerousPath);
        console.log("SUCCESS: deleteFile with dangerous path did not crash.");

        console.log("Testing backslash...");
        await store.deleteFile(tempStoreId, backslashPath);
        console.log("SUCCESS: deleteFile with backslash did not crash.");
    } catch (e) {
        console.log("FAIL: deleteFile crashed:", e);
    } finally {
        await store.deleteStore(tempStoreId);
    }
}

async function testPathTraversal() {
    console.log("\nTesting Path Traversal Logic...");
    const root = "/Users/user/project";
    const maliciousPaths = [
        "../../etc/passwd",
        "/etc/passwd",
        "../outside",
    ];
    const safePaths = [
        "src/index.ts",
        "./src/index.ts",
        "/Users/user/project/src/index.ts"
    ];

    function checkPath(inputPath: string) {
        const resolved = path.resolve(root, inputPath);
        if (!resolved.startsWith(root)) {
            return "blocked";
        }
        return "allowed";
    }

    for (const p of maliciousPaths) {
        const result = checkPath(p);
        if (result === "blocked") {
            console.log(`SUCCESS: Blocked ${p}`);
        } else {
            console.log(`FAIL: Allowed ${p} (Resolved: ${path.resolve(root, p)})`);
        }
    }

    for (const p of safePaths) {
        const result = checkPath(p);
        if (result === "allowed") {
            console.log(`SUCCESS: Allowed ${p}`);
        } else {
            console.log(`FAIL: Blocked ${p}`);
        }
    }
}

async function main() {
    await testVectorDimensionCheck();
    await testSqlInjection();
    await testPathTraversal();
}

main().catch(console.error);
