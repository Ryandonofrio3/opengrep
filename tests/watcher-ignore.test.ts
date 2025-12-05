import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SERVE_IGNORE_PATTERNS = [
  "*.lock",
  "*.bin",
  "*.ipynb",
  "*.pyc",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  ".osgrep/**",
];

describe("serve watcher ignore predicate", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osgrep-watch-"));
    await fs.mkdir(path.join(tempRoot, ".osgrep"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, ".osgrep", "server.json"), "{}");
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("does not throw on the root path and ignores osgrep/git internals", async () => {
    const filter = ignore().add(SERVE_IGNORE_PATTERNS);
    const ignored = (watchedPath: string | Buffer) => {
      const rel = path
        .relative(tempRoot, watchedPath.toString())
        .replace(/\\/g, "/");
      if (!rel) return false;
      return (
        filter.ignores(rel) ||
        watchedPath.toString().includes(`${path.sep}.git${path.sep}`) ||
        watchedPath.toString().includes(`${path.sep}.osgrep${path.sep}`)
      );
    };

    expect(() => ignored(tempRoot)).not.toThrow();
    expect(ignored(tempRoot)).toBe(false);

    expect(ignored(path.join(tempRoot, ".osgrep", "server.json"))).toBe(true);
    expect(ignored(path.join(tempRoot, ".git", "HEAD"))).toBe(true);
  });
});
