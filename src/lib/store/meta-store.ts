import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

const META_FILE = PATHS.meta;

export type MetaEntry = {
    hash: string;
    mtimeMs: number;
    size: number;
};

type RawMetaEntry = string | Partial<MetaEntry>;

function normalizeEntry(value: RawMetaEntry): MetaEntry {
    if (typeof value === "string") {
        return { hash: value, mtimeMs: 0, size: 0 };
    }

    const hash = typeof value.hash === "string" ? value.hash : "";
    const mtimeMs =
        typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs)
            ? value.mtimeMs
            : 0;
    const size =
        typeof value.size === "number" && Number.isFinite(value.size)
            ? value.size
            : 0;

    return { hash, mtimeMs, size };
}

export class MetaStore {
    private data: Record<string, MetaEntry> = {};
    private loaded = false;
    private saveQueue: Promise<void> = Promise.resolve();

    async load() {
        if (this.loaded) return;

        const loadFile = async (p: string) => {
            const content = await fs.promises.readFile(p, "utf-8");
            return JSON.parse(content);
        };

        try {
            const raw = await loadFile(META_FILE);
            this.data = Object.fromEntries(
                Object.entries(raw as Record<string, RawMetaEntry>).map(
                    ([filePath, value]) => [filePath, normalizeEntry(value)],
                ),
            );
        } catch (err) {
            // Try to recover from tmp file if main file is missing or corrupt
            const tmpFile = `${META_FILE}.tmp`;
            try {
                if (fs.existsSync(tmpFile)) {
                    console.warn("[MetaStore] Main meta file corrupt/missing, recovering from tmp...");
                    const raw = await loadFile(tmpFile);
                    this.data = Object.fromEntries(
                        Object.entries(raw as Record<string, RawMetaEntry>).map(
                            ([filePath, value]) => [filePath, normalizeEntry(value)],
                        ),
                    );
                    // Restore the main file
                    await fs.promises.copyFile(tmpFile, META_FILE);
                } else {
                    this.data = {};
                }
            } catch {
                this.data = {};
            }
        }
        this.loaded = true;
    }

    async save() {
        // Serialize saves to avoid concurrent writes that could corrupt the file
        // Recover from previous failures so the queue never gets permanently stuck
        this.saveQueue = this.saveQueue
            .catch((err) => {
                console.error("MetaStore save failed (previous):", err);
                // Recover so future saves can still run
            })
            .then(async () => {
                await fs.promises.mkdir(path.dirname(META_FILE), { recursive: true });
                const tmpFile = `${META_FILE}.tmp`;
                await fs.promises.writeFile(
                    tmpFile,
                    JSON.stringify(this.data, null, 2),
                );
                await fs.promises.rename(tmpFile, META_FILE);
            });

        return this.saveQueue;
    }

    get(filePath: string): MetaEntry | undefined {
        return this.data[filePath];
    }

    set(filePath: string, entry: MetaEntry) {
        this.data[filePath] = entry;
    }

    delete(filePath: string) {
        delete this.data[filePath];
    }

    deleteByPrefix(prefix: string) {
        const normalizedPrefix = prefix.endsWith(path.sep) ? prefix : prefix + path.sep;
        for (const key of Object.keys(this.data)) {
            if (key.startsWith(normalizedPrefix)) {
                delete this.data[key];
            }
        }
    }
}
