import { relative } from "node:path";
import ora, { type Ora } from "ora";

interface IndexingSpinner {
  spinner: Ora;
  onProgress: (info: InitialSyncProgress) => void;
}

export interface InitialSyncProgress {
  processed: number;
  indexed: number;
  total: number;
  filePath?: string;
}

interface ProgressTracker {
  update(processed: number, total: number): void;
}

export interface InitialSyncResult {
  processed: number;
  indexed: number;
  total: number;
  failedFiles: number;
}

/**
 * Converts an absolute `filePath` into a path relative to `root` when possible,
 * keeping absolute fallbacks for paths outside the repo.
 *
 * @param root The root directory of the repository
 * @param filePath The path to the file to format
 * @returns The formatted path
 */
function formatRelativePath(root: string, filePath?: string): string {
  if (!filePath) {
    return "";
  }
  return filePath.startsWith(root) ? relative(root, filePath) : filePath;
}

/**
 * Creates a progress tracker that estimates time remaining based on processing rate.
 */
function createProgressTracker(): ProgressTracker {
  return {
    update(_processed: number, _total: number) {
      // No-op for now, but keeping structure if we want to add stats later
    },
  };
}

/**
 * Creates a shared spinner + progress callback pair that keeps the CLI UI
 * consistent across commands running `initialSync`.
 *
 * @param root The root directory of the repository
 * @param label The label to use for the spinner
 * @returns The spinner and progress callback pair
 */
export function createIndexingSpinner(
  root: string,
  label = "Indexing files...",
): IndexingSpinner {
  const spinner = ora({ text: label }).start();
  const tracker = createProgressTracker();

  return {
    spinner,
    onProgress(info) {
      tracker.update(info.processed, info.total);

      // Handle pre-indexing phases (before total is known or special messages)
      if (
        info.filePath &&
        (info.filePath.startsWith("Scanning...") ||
          info.filePath.startsWith("Checking index...") ||
          info.filePath.startsWith("Processing") ||
          info.filePath.startsWith("Checking for changes"))
      ) {
        spinner.text = info.filePath;
        if (process.env.OSGREP_DEBUG_INDEX === "1") {
          console.log(`[progress] ${info.filePath}`);
        }
        return;
      }

      const rel = formatRelativePath(root, info.filePath);
      const fileSuffix = rel ? ` • ${rel}` : "";

      const totalKnown = info.total > 0;
      const progressSuffix = totalKnown
        ? `(${info.processed}/${info.total})`
        : `(${info.processed} files)`;

      spinner.text = `Indexing files ${progressSuffix}${fileSuffix}`;
    },
  };
}

/**
 * Produces a single-line summary describing what a dry-run sync would have done.
 *
 * @param result The result of the initial sync
 * @param actionDescription The description of the action
 * @param includeTotal Whether to include the total number of files
 * @returns The formatted summary
 */
export function formatDryRunSummary(
  result: InitialSyncResult,
  {
    actionDescription,
    includeTotal = false,
  }: { actionDescription: string; includeTotal?: boolean },
): string {
  const totalSuffix = includeTotal ? " in total" : "";
  return `Dry run: ${actionDescription} ${result.processed} files${totalSuffix}, would have indexed ${result.indexed} changed or new files`;
}
