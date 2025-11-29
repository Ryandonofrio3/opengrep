import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeFileSystem } from "../src/lib/file";
import { GitIgnoreFilter } from "../src/lib/git";
import type { Git } from "../src/lib/git";

class FakeGit implements Git {
  constructor(private readonly isRepo = false) { }

  isGitRepository(): boolean {
    return this.isRepo;
  }
  getGitIgnoreContent(): string | null {
    return null;
  }
  async *getGitFiles(): AsyncGenerator<string> {
    yield* [];
  }
  getGitIgnoreFilter(): GitIgnoreFilter {
    return new GitIgnoreFilter();
  }
  getRepositoryRoot(): string | null {
    return null;
  }
  getRemoteUrl(): string | null {
    return null;
  }
}

describe("NodeFileSystem", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-fs-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("skips hidden files when traversing", async () => {
    const hiddenDir = path.join(tempRoot, ".hidden");
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(hiddenDir, "secret.ts"), "secret");
    await fs.writeFile(path.join(tempRoot, "visible.ts"), "visible");

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const files: string[] = [];
    for await (const file of fsImpl.getFiles(tempRoot)) {
      files.push(file);
    }

    expect(files.some((f) => f.includes(".hidden"))).toBe(false);
    expect(files.some((f) => f.endsWith("visible.ts"))).toBe(true);
  });

  it("applies .osgrepignore patterns", async () => {
    await fs.writeFile(path.join(tempRoot, "keep.ts"), "keep");
    await fs.writeFile(path.join(tempRoot, "skip.ts"), "skip");
    await fs.writeFile(path.join(tempRoot, ".osgrepignore"), "skip.ts\n");

    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    // Trigger .osgrepignore loading
    for await (const _ of fsImpl.getFiles(tempRoot)) {
      // consume
    }
    expect(fsImpl.isIgnored(path.join(tempRoot, "skip.ts"), tempRoot)).toBe(
      true,
    );
    expect(fsImpl.isIgnored(path.join(tempRoot, "keep.ts"), tempRoot)).toBe(
      false,
    );
  });

  it("honors custom ignorePatterns option", async () => {
    await fs.writeFile(path.join(tempRoot, "keep.ts"), "keep");
    await fs.writeFile(path.join(tempRoot, "skip.log"), "skip");

    const fsImpl = new NodeFileSystem(new FakeGit(), {
      ignorePatterns: ["*.log"],
    });
    expect(fsImpl.isIgnored(path.join(tempRoot, "skip.log"), tempRoot)).toBe(
      true,
    );
    expect(fsImpl.isIgnored(path.join(tempRoot, "keep.ts"), tempRoot)).toBe(
      false,
    );
  });

  it("treats the repository root as not ignored without throwing", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });

    expect(() => fsImpl.isIgnored(tempRoot, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(tempRoot, tempRoot)).toBe(false);
  });

  it("handles dot and parent paths without throwing or false positives", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const dotPath = path.join(tempRoot, ".");
    const parentPath = path.join(tempRoot, "..");

    expect(() => fsImpl.isIgnored(dotPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(dotPath, tempRoot)).toBe(false);

    // Parent of root should still resolve safely and be treated as ignored to avoid indexing outside root
    expect(() => fsImpl.isIgnored(parentPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(parentPath, tempRoot)).toBe(true);
  });

  it("normalizes odd separators without crashing the ignore filter", async () => {
    const fsImpl = new NodeFileSystem(new FakeGit(), { ignorePatterns: [] });
    const weirdPath = path.join(tempRoot, "foo", ".", "bar");

    await fs.mkdir(path.dirname(weirdPath), { recursive: true });
    await fs.writeFile(weirdPath, "content");

    expect(() => fsImpl.isIgnored(weirdPath, tempRoot)).not.toThrow();
    expect(fsImpl.isIgnored(weirdPath, tempRoot)).toBe(false);
  });
});

describe("GitIgnoreFilter", () => {
  it("ignores files and directories based on patterns", () => {
    const filter = new GitIgnoreFilter("dist/\n*.log\n");
    const root = fs.mkdtemp(path.join(os.tmpdir(), "osgrep-git-ignore-"));

    return root.then(async (temp) => {
      const distDir = path.join(temp, "dist");
      const appDir = path.join(temp, "app");
      await fs.mkdir(distDir, { recursive: true });
      await fs.mkdir(appDir, { recursive: true });
      await fs.writeFile(path.join(distDir, "file.js"), "content");
      await fs.writeFile(path.join(appDir, "debug.log"), "log");
      await fs.writeFile(path.join(appDir, "index.ts"), "ts");

      expect(filter.isIgnored(distDir, temp)).toBe(true);
      expect(filter.isIgnored(path.join(distDir, "file.js"), temp)).toBe(true);
      expect(filter.isIgnored(path.join(appDir, "debug.log"), temp)).toBe(true);
      expect(filter.isIgnored(path.join(appDir, "index.ts"), temp)).toBe(
        false,
      );

      await fs.rm(temp, { recursive: true, force: true });
    });
  });
});
