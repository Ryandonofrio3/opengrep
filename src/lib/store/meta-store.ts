import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

const META_FILE = PATHS.meta;

export class MetaStore {
    private data: Record<string, string> = {};
    private loaded = false;
    private saveQueue: Promise<void> = Promise.resolve();

    async load() {
        if (this.loaded) return;

        const loadFile = async (p: string) => {
            const content = await fs.promises.readFile(p, "utf-8");
            return JSON.parse(content);
        };

        try {
            this.data = await loadFile(META_FILE);
        } catch (err) {
            // Try to recover from tmp file if main file is missing or corrupt
            const tmpFile = `${META_FILE}.tmp`;
            try {
                if (fs.existsSync(tmpFile)) {
                    console.warn("[MetaStore] Main meta file corrupt/missing, recovering from tmp...");
                    this.data = await loadFile(tmpFile);
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

    get(filePath: string): string | undefined {
        return this.data[filePath];
    }

    set(filePath: string, hash: string) {
        this.data[filePath] = hash;
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
