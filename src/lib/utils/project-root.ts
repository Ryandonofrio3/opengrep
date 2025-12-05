import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config";

export interface ProjectPaths {
  root: string;
  osgrepDir: string;
  lancedbDir: string;
  cacheDir: string;
  lmdbPath: string;
  configPath: string;
}

export function findProjectRoot(startDir = process.cwd()): string | null {
  const start = path.resolve(startDir);
  
  // Check if there's an existing .osgrep directory in the current directory
  const osgrepDir = path.join(start, ".osgrep");
  if (
    fs.existsSync(osgrepDir) &&
    path.resolve(start) !== path.resolve(PATHS.globalRoot)
  ) {
    return start;
  }
  
  // Otherwise, use the current directory as the root (don't walk up)
  // This allows separate indexes per subdirectory and matches user expectations
  return start;
}

export function ensureProjectPaths(startDir = process.cwd()): ProjectPaths {
  const root = findProjectRoot(startDir) ?? path.resolve(startDir);
  const osgrepDir = path.join(root, ".osgrep");
  const lancedbDir = path.join(osgrepDir, "lancedb");
  const cacheDir = path.join(osgrepDir, "cache");
  const lmdbPath = path.join(cacheDir, "meta.lmdb");
  const configPath = path.join(osgrepDir, "config.json");

  [osgrepDir, lancedbDir, cacheDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });

  ensureGitignoreEntry(root);

  return { root, osgrepDir, lancedbDir, cacheDir, lmdbPath, configPath };
}

function ensureGitignoreEntry(root: string) {
  // Only add when inside a git repo.
  if (!fs.existsSync(path.join(root, ".git"))) return;

  const gitignorePath = path.join(root, ".gitignore");
  let contents = "";
  try {
    contents = fs.readFileSync(gitignorePath, "utf-8");
  } catch {
    // ignore missing file; will create below
  }

  const hasEntry = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(".osgrep");
  if (hasEntry) return;

  const needsNewline = contents.length > 0 && !contents.endsWith("\n");
  const prefix = needsNewline ? "\n" : "";
  fs.writeFileSync(gitignorePath, `${contents}${prefix}.osgrep\n`, {
    encoding: "utf-8",
  });
}
