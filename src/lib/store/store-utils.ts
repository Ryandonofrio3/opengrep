import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { RepositoryScanner } from "../index/scanner";
import type { Store } from "./store";

/**
 * Extracts owner-repo format from various git URL formats
 */
export function extractRepoInfoFromUrl(url: string): string {
    const cleanUrl = url.replace(/\.git$/, "");
    const parts = cleanUrl.split(/[\/:]/);
    const nonEmptyParts = parts.filter((p) => p.length > 0);

    if (nonEmptyParts.length >= 2) {
        const repo = nonEmptyParts[nonEmptyParts.length - 1];
        const owner = nonEmptyParts[nonEmptyParts.length - 2];
        if (repo && owner) {
            return `${owner}-${repo}`.toLowerCase();
        }
    }

    return nonEmptyParts[nonEmptyParts.length - 1]?.toLowerCase() || "unknown-repo";
}

/**
 * Converts a name to a safe store ID format
 */
export function sanitizeStoreName(name: string): string {
    return name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Automatically determines a unique store ID based on the target directory
 */
export function getAutoStoreId(targetDir: string = process.cwd()): string {
    const scanner = new RepositoryScanner({ ignorePatterns: [] });
    const absolutePath = resolve(targetDir);

    try {
        const root = scanner.getRepositoryRoot(absolutePath);
        if (root) {
            const remote = scanner.getRemoteUrl(root);
            if (remote) {
                return sanitizeStoreName(extractRepoInfoFromUrl(remote));
            }
        }
    } catch (e) {
        // Ignore git errors
    }

    const folderName = basename(absolutePath);
    const pathHash = createHash("sha256")
        .update(absolutePath)
        .digest("hex")
        .substring(0, 8);

    return sanitizeStoreName(`${folderName}-${pathHash}`);
}

export async function ensureStoreExists(
    store: Store,
    storeId: string,
): Promise<void> {
    try {
        await store.create({
            name: storeId,
            description: "osgrep local index",
        });
    } catch (_err) {
        // Ignore errors if it already exists
    }

    await store.retrieve(storeId);
}

export async function isStoreEmpty(
    store: Store,
    storeId: string,
): Promise<boolean> {
    try {
        for await (const _ of store.listFiles(storeId)) {
            return false;
        }
    } catch (_err) {
        // If we can't list files, treat it as empty/missing
    }
    return true;
}

export async function listStoreFileHashes(
    store: Store,
    storeId: string,
): Promise<Map<string, string | undefined>> {
    const byExternalId = new Map<string, string | undefined>();
    for await (const file of store.listFiles(storeId)) {
        const externalId = file.external_id ?? undefined;
        if (!externalId) continue;
        const metadata = file.metadata;
        const hash: string | undefined =
            metadata && typeof metadata.hash === "string" ? metadata.hash : undefined;
        byExternalId.set(externalId, hash);
    }
    return byExternalId;
}
