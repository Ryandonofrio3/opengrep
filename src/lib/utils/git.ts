import * as fs from "node:fs";
import * as path from "node:path";

export function isWorktree(dir: string): boolean {
  const gitPath = path.join(dir, ".git");
  try {
    const stats = fs.statSync(gitPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

export function getGitCommonDir(worktreeRoot: string): string | null {
  const gitPath = path.join(worktreeRoot, ".git");
  try {
    const content = fs.readFileSync(gitPath, "utf-8").trim();
    if (!content.startsWith("gitdir: ")) return null;

    const gitDir = content.slice(8).trim();
    const absGitDir = path.resolve(worktreeRoot, gitDir);

    const commonDirFile = path.join(absGitDir, "commondir");
    if (fs.existsSync(commonDirFile)) {
      const commonPath = fs.readFileSync(commonDirFile, "utf-8").trim();
      return path.resolve(absGitDir, commonPath);
    }

    // Fallback: assume standard structure
    return path.resolve(absGitDir, "../../");
  } catch {
    return null;
  }
}

/**
 * Resolves the main repository root from a worktree root.
 */
export function getMainRepoRoot(worktreeRoot: string): string | null {
  if (!isWorktree(worktreeRoot)) return null;

  const commonDir = getGitCommonDir(worktreeRoot);
  if (!commonDir) return null;

  // The common dir is usually .git inside the main repo root.
  // So the main repo root is the parent of commonDir.
  return path.dirname(commonDir);
}
