import { spawnSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import ignore from "ignore";

export interface ScannerOptions {
    ignorePatterns: string[];
}

export class RepositoryScanner {
    private customIgnoreFilter = ignore();
    private gitRepoCache = new Map<string, boolean>();
    private gitRootCache = new Map<string, string | null>();
    private gitRemoteCache = new Map<string, string | null>();
    private gitIgnoreCache = new Map<
        string,
        { filter: ReturnType<typeof ignore>; mtime: number }
    >();

    constructor(options: ScannerOptions) {
        this.customIgnoreFilter.add(options.ignorePatterns);
    }

    /**
     * Checks if a directory is a git repository
     */
    isGitRepository(dir: string): boolean {
        const normalizedDir = path.resolve(dir);
        const cached = this.gitRepoCache.get(normalizedDir);
        if (cached !== undefined) return cached;

        let isGit = false;
        try {
            const result = spawnSync("git", ["rev-parse", "--git-dir"], {
                cwd: dir,
                encoding: "utf-8",
            });
            isGit = result.status === 0 && !result.error;
        } catch {
            isGit = false;
        }

        this.gitRepoCache.set(normalizedDir, isGit);
        return isGit;
    }

    /**
     * Gets the repository root directory (absolute path)
     */
    getRepositoryRoot(dir: string): string | null {
        const normalizedDir = path.resolve(dir);
        const cached = this.gitRootCache.get(normalizedDir);
        if (cached !== undefined) return cached;

        let root: string | null = null;
        try {
            const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
                cwd: dir,
                encoding: "utf-8",
            });
            if (result.status === 0 && !result.error && result.stdout) {
                root = result.stdout.trim();
            }
        } catch {
            root = null;
        }

        this.gitRootCache.set(normalizedDir, root);
        return root;
    }

    /**
     * Gets the remote URL for origin
     */
    getRemoteUrl(dir: string): string | null {
        const normalizedDir = path.resolve(dir);
        const cached = this.gitRemoteCache.get(normalizedDir);
        if (cached !== undefined) return cached;

        let remote: string | null = null;
        try {
            const result = spawnSync(
                "git",
                ["config", "--get", "remote.origin.url"],
                {
                    cwd: dir,
                    encoding: "utf-8",
                },
            );
            if (result.status === 0 && !result.error && result.stdout) {
                remote = result.stdout.trim();
            }
        } catch {
            remote = null;
        }

        this.gitRemoteCache.set(normalizedDir, remote);
        return remote;
    }

    /**
     * Loads .osgrepignore patterns
     */
    loadOsgrepignore(dirRoot: string): void {
        const ignoreFile = path.join(dirRoot, ".osgrepignore");
        if (fs.existsSync(ignoreFile)) {
            this.customIgnoreFilter.add(fs.readFileSync(ignoreFile, "utf8"));
        }
    }

    /**
     * Checks if a file should be ignored
     */
    isIgnored(filePath: string, root: string): boolean {
        // 1. Check hidden files
        const relativePath = path.relative(root, filePath);
        const parts = relativePath.split(path.sep);
        if (parts.some((p) => p.startsWith(".") && p !== "." && p !== "..")) {
            return true;
        }

        // 2. Check custom/osgrepignore patterns
        let normalizedPath = relativePath.replace(/\\/g, "/");
        if (path.isAbsolute(normalizedPath)) {
            // Should not happen if relativePath is correct, but safety first
            normalizedPath = normalizedPath.replace(/^[/\\]+/, "");
        }
        if (normalizedPath.startsWith("..") || !normalizedPath) {
            return normalizedPath.startsWith("..");
        }

        let isDirectory = false;
        try {
            isDirectory = fs.statSync(filePath).isDirectory();
        } catch {
            isDirectory = false;
        }

        const pathToCheck = isDirectory ? `${normalizedPath}/` : normalizedPath;
        if (this.customIgnoreFilter.ignores(pathToCheck)) {
            return true;
        }

        // 3. Check .gitignore if applicable
        if (this.isGitRepository(root)) {
            const filter = this.getGitIgnoreFilter(root);
            return filter.ignores(pathToCheck);
        }

        return false;
    }

    private getGitIgnoreFilter(repoRoot: string): ReturnType<typeof ignore> {
        const normalizedRoot = path.resolve(repoRoot);
        const gitignorePath = path.join(repoRoot, ".gitignore");
        let currentMtime = 0;
        try {
            currentMtime = fs.statSync(gitignorePath).mtime.getTime();
        } catch { }

        const cached = this.gitIgnoreCache.get(normalizedRoot);
        if (!cached || cached.mtime !== currentMtime) {
            const filter = ignore();
            if (fs.existsSync(gitignorePath)) {
                filter.add(fs.readFileSync(gitignorePath, "utf-8"));
            }
            this.gitIgnoreCache.set(normalizedRoot, { filter, mtime: currentMtime });
            return filter;
        }
        return cached.filter;
    }

    /**
     * Main entry point: scan a directory for files
     */
    async * getFiles(dirRoot: string): AsyncGenerator<string> {
        this.loadOsgrepignore(dirRoot);

        if (this.isGitRepository(dirRoot)) {
            let yielded = false;
            try {
                for await (const file of this.streamGitFiles(dirRoot)) {
                    yielded = true;
                    yield file;
                }
            } catch (e) {
                console.warn(`[scanner] git ls-files failed: ${e}`);
            }

            if (yielded) return;
            console.warn(
                `[scanner] git ls-files returned no results for ${dirRoot}. Falling back to filesystem traversal...`,
            );
        }

        yield* this.walk(dirRoot, dirRoot);
    }

    private async * streamGitFiles(dirRoot: string): AsyncGenerator<string> {
        const child = spawn(
            "git",
            ["ls-files", "-z", "--others", "--exclude-standard", "--cached"],
            {
                cwd: dirRoot,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );

        child.stderr.on("data", (data) => {
            const msg = data.toString().trim();
            if (msg) console.error(`[git] stderr: ${msg}`);
        });

        let buffer = "";
        for await (const chunk of child.stdout) {
            buffer += chunk.toString();
            const parts = buffer.split("\u0000");
            buffer = parts.pop() || "";
            for (const file of parts) {
                if (file) yield path.join(dirRoot, file);
            }
        }
        if (buffer) yield path.join(dirRoot, buffer);

        await new Promise<void>((resolve, reject) => {
            child.on("exit", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`git exited with code ${code}`));
            });
            child.on("error", reject);
        });
    }

    private async * walk(dir: string, root: string): AsyncGenerator<string> {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (this.isIgnored(fullPath, root)) continue;

                if (entry.isDirectory()) {
                    // If nested git repo, switch to git scanning for that subtree
                    if (this.isGitRepository(fullPath)) {
                        let yielded = false;
                        try {
                            for await (const file of this.streamGitFiles(fullPath)) {
                                yielded = true;
                                yield file;
                            }
                        } catch { }
                        if (!yielded) yield* this.walk(fullPath, root);
                    } else {
                        yield* this.walk(fullPath, root);
                    }
                } else if (entry.isFile()) {
                    yield fullPath;
                }
            }
        } catch (error) {
            console.error(`Warning: Failed to read directory ${dir}:`, error);
        }
    }
}
