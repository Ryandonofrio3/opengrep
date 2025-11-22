import { extname, join, relative, normalize } from "node:path";
import { highlight } from "cli-highlight";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import type { ChunkType, FileMetadata, SearchResponse } from "../lib/store";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import { initialSync, MetaStore } from "../utils";

// --- UI Helpers (No external deps) ---
const style = {
  reset: (s: string) => `\x1b[0m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

function detectLanguage(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".rs":
      return "rust";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".json":
      return "json";
    case ".md":
      return "markdown";
    case ".yml":
    case ".yaml":
      return "yaml";
    case ".css":
      return "css";
    case ".html":
      return "html";
    case ".sh":
      return "bash";
    default:
      return "plaintext";
  }
}

/**
 * Parses the specialized chunk format: "Header\n---\nBody"
 */
function parseChunkText(text: string) {
  const separator = "\n---\n";
  const index = text.indexOf(separator);

  if (index === -1) {
    return { header: "", body: text };
  }

  return {
    header: text.substring(0, index),
    body: text.substring(index + separator.length),
  };
}

function formatSearchResults(
  response: SearchResponse,
  options: {
    showContent: boolean;
    perFile: number;
    showScores: boolean;
    compact: boolean;
    root: string;
  },
) {
  const { data } = response;
  if (data.length === 0) return "";

  // 1. Group by File Path (Preserve score order)
  const grouped = new Map<string, ChunkType[]>();
  for (const chunk of data) {
    const rawPath = (chunk.metadata as FileMetadata)?.path || "Unknown path";
    if (!grouped.has(rawPath)) {
      grouped.set(rawPath, []);
    }
    grouped.get(rawPath)?.push(chunk);
  }

  // 2. Summary Line
  const totalFiles = grouped.size;
  const summary = style.bold(
    `Found ${data.length} relevant chunks in ${totalFiles} files. Showing top ${totalFiles} files.`,
  );
  let output = `\n${summary}\n`;

  // 3. Iterate Groups
  for (const [rawPath, chunks] of grouped) {
    // Path Formatting
    let displayPath = rawPath;
    if (rawPath !== "Unknown path") {
      displayPath = relative(options.root, rawPath);
    }

    // Compact Mode: Just the path
    if (options.compact) {
      output += `${style.green("📂 " + displayPath)}\n`;
      continue;
    }

    // File Header
    output += `\n${style.green("📂 " + style.bold(displayPath))}\n`;

    // Render Chunks
    const shownChunks = chunks.slice(0, options.perFile);
    const remaining = chunks.length - shownChunks.length;

    for (const chunk of shownChunks) {
      // Metadata
      const startLine = (chunk.generated_metadata?.start_line ?? 0) + 1;
      const scoreDisplay = options.showScores
        ? style.dim(` (score: ${chunk.score.toFixed(3)})`)
        : "";

      // Parse Text
      const { header, body } = parseChunkText(chunk.text ?? "");

      // Context Header (e.g. "Function: myFunc")
      if (header) {
        const contextClean = header.replace(/^File:.*$/m, "").trim();
        if (contextClean) {
          output += `   ${style.dim("Context: " + contextClean)}\n`;
        }
      }

      // Code Body Highlighting
      let displayBody = body;
      if (!options.showContent) {
        // Truncate if not requesting full content
        const lines = body.split("\n");
        if (lines.length > 6) {
          displayBody = lines.slice(0, 6).join("\n");
        }
      }

      // Apply Syntax Highlighting (ANSI)
      let highlighted = displayBody;
      try {
        const lang = detectLanguage(rawPath);
        highlighted = highlight(displayBody, {
          language: lang,
          ignoreIllegals: true,
        });
      } catch {
        // Fallback to plain text
      }

      // Apply Line Numbers to the Highlighted Text
      const lines = highlighted.split("\n");
      const snippet = lines
        .map((line, i) => {
          const lineNum = style.dim(`${startLine + i}`.padStart(4) + " │");
          return `${lineNum} ${line}`;
        })
        .join("\n");

      output += `${snippet}${scoreDisplay}\n`;

      // Visual separator between chunks in same file if needed
      if (shownChunks.length > 1 && chunk !== shownChunks[shownChunks.length - 1]) {
        output += style.dim("      ...\n");
      }
    }

    // "More matches" footer
    if (remaining > 0) {
      output += `      ${style.dim(`... +${remaining} more matches in this file (use --per-file ${chunks.length} to see all)`)}\n`;
    }
  }

  return output;
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option("-i", "Makes the search case-insensitive", false)
  .option("-r", "Recursive search", false)
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "25",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option(
    "--per-file <n>",
    "Number of matches to show per file",
    "1",
  )
  .option("--scores", "Show relevance scores", false)
  .option("--compact", "Show file paths only", false)
  .option(
    "-s, --sync",
    "Syncs the local files to the store before searching",
    false,
  )
  .option(
    "-d, --dry-run",
    "Dry run the search process (no actual file syncing)",
    false,
  )
  .argument("<pattern>", "The pattern to search for")
  .argument("[path]", "The path to search in")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (pattern, exec_path, _options, cmd) => {
    const options: {
      store: string;
      m: string;
      c: boolean;
      perFile: string;
      scores: boolean;
      compact: boolean;
      sync: boolean;
      dryRun: boolean;
    } = cmd.optsWithGlobals();

    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    try {
      await ensureSetup({ silent: true });
      const store = await createStore();
      await ensureStoreExists(store, options.store);
      const root = process.cwd();
      const autoSync =
        options.sync || (await isStoreEmpty(store, options.store));
      let didSync = false;

      if (autoSync) {
        const fileSystem = createFileSystem({
          ignorePatterns: [
            "*.lock",
            "*.bin",
            "*.ipynb",
            "*.pyc",
            "pnpm-lock.yaml",
            "package-lock.json",
            "yarn.lock",
            "bun.lockb",
          ],
        });
        const metaStore = new MetaStore();
        const { spinner, onProgress } = createIndexingSpinner(
          root,
          options.sync ? "Indexing..." : "Indexing repository (first run)...",
        );
        const result = await initialSync(
          store,
          fileSystem,
          options.store,
          root,
          options.dryRun,
          onProgress,
          metaStore,
        );
        while (true) {
          const info = await store.getInfo(options.store);
          spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
          if (info.counts.pending === 0 && info.counts.in_progress === 0) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        spinner.succeed(
          `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
        );
        didSync = true;
        if (options.dryRun) {
          console.log(
            formatDryRunSummary(result, {
              actionDescription: "would have indexed",
            }),
          );
          process.exit(0);
        }
      }

      const search_path = exec_path?.startsWith("/")
        ? exec_path
        : normalize(join(root, exec_path ?? ""));

      // Execute Search
      const results = await store.search(
        options.store,
        pattern,
        parseInt(options.m, 10),
        { rerank: true },
        {
          all: [
            {
              key: "path",
              operator: "starts_with",
              value: search_path,
            },
          ],
        },
      );

      // Hint if no results found
      if (results.data.length === 0) {
        if (!didSync) {
          try {
            const info = await store.getInfo(options.store);
            if (info.counts.pending === 0 && info.counts.in_progress === 0) {
              // Store exists but no results - might need re-indexing if files changed
              console.log(
                "No results found. If files have changed, you can re-index with 'osgrep index' or 'osgrep search --sync \"<query>\"'.\n",
              );
            }
          } catch {
            console.log(
              "No results found. The repository will be automatically indexed on your next search.\n",
            );
          }
        }
        process.exit(0);
      }

      // Render Output
      const output = formatSearchResults(results, {
        showContent: options.c,
        perFile: parseInt(options.perFile, 10),
        showScores: options.scores,
        compact: options.compact,
        root,
      });

      console.log(output);

      // Exit cleanly after successful search
      process.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exit(1);
    }
  });