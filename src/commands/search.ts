import { extname, join, relative, normalize } from "node:path";
import { highlight } from "cli-highlight";
import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { createFileSystem, createStore } from "../lib/context";
import { ensureSetup } from "../lib/setup-helpers";
import type {
  ChunkType,
  FileMetadata,
  SearchResponse,
  Store,
} from "../lib/store";
import { DEFAULT_IGNORE_PATTERNS } from "../lib/ignore-patterns";
import { ensureStoreExists, isStoreEmpty } from "../lib/store-helpers";
import { getAutoStoreId } from "../lib/store-resolver";
import {
  createIndexingSpinner,
  formatDryRunSummary,
} from "../lib/sync-helpers";
import {
  formatDenseSnippet,
  initialSync,
  MetaStore,
  readServerLock,
} from "../utils";

// --- UI Helpers (No external deps) ---
const style = {
  reset: (s: string) => `\x1b[0m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
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

/**
 * Cleans metadata lines from the top of a snippet to show code faster.
 */
function cleanSnippet(body: string): {
  cleanedLines: string[];
  linesRemoved: number;
} {
  let lines = body.split("\n");
  let linesRemoved = 0;

  // Metadata prefixes to strip from the *start* of the snippet
  const NOISE_PREFIXES = [
    "File:",
    "Top comments:",
    "Preamble:",
    "(anchor)",
    "Imports:",
    "Exports:",
    "---",
  ];

  while (
    lines.length > 0 &&
    (lines[0].trim() === "" ||
      NOISE_PREFIXES.some((p) => lines[0].trim().startsWith(p)))
  ) {
    lines.shift();
    linesRemoved++;
  }

  return { cleanedLines: lines, linesRemoved };
}

function toDenseResults(
  root: string,
  data: SearchResponse["data"],
): Array<{ path: string; score: number; content: string }> {
  return data.map((item) => {
    const rawPath =
      typeof (item.metadata as FileMetadata | undefined)?.path === "string"
        ? ((item.metadata as FileMetadata).path as string)
        : "";
    const relPath = rawPath ? relative(root, rawPath) || rawPath : "unknown";
    const snippet = formatDenseSnippet(item.text ?? "");
    return {
      path: relPath,
      score: Number(item.score.toFixed(3)),
      content: snippet,
    };
  });
}

function formatSearchResults(
  response: SearchResponse,
  options: {
    showContent: boolean;
    perFile: number;
    showScores: boolean;
    compact: boolean;
    plain: boolean;
    maxCount: number;
    root: string;
  },
) {
  const { data } = response;
  if (data.length === 0) return "";

  // 1. Group by File Path
  const grouped = new Map<string, ChunkType[]>();
  for (const chunk of data) {
    const rawPath = (chunk.metadata as FileMetadata)?.path || "Unknown path";
    if (!grouped.has(rawPath)) {
      grouped.set(rawPath, []);
    }
    grouped.get(rawPath)?.push(chunk);
  }

  let output = "";

  // 2. Iterate Groups
  for (const [rawPath, chunks] of grouped) {
    // Sort chunks within file: Prefer content over anchors, then score
    chunks.sort((a, b) => {
      const aIsAnchor = !!a.metadata?.is_anchor;
      const bIsAnchor = !!b.metadata?.is_anchor;
      if (aIsAnchor !== bIsAnchor) return aIsAnchor ? 1 : -1; // Put non-anchors first
      return b.score - a.score; // Then sort by score
    });

    // Path Formatting
    let displayPath = rawPath;
    if (rawPath !== "Unknown path") {
      displayPath = relative(options.root, rawPath);
    }

    // Compact Mode: Just the path
    if (options.compact) {
      output += options.plain ? `${displayPath}\n` : `${style.green("📂 " + displayPath)}\n`;
      continue;
    }

    // File Header
    if (options.plain) {
      output += `${displayPath}\n`;
    } else {
      output += `${style.green("📂 " + style.bold(displayPath))}`;
    }

    // Render Chunks
    const shownChunks = chunks.slice(0, options.perFile);

    for (const chunk of shownChunks) {
      // Metadata
      let startLine = (chunk.generated_metadata?.start_line ?? 0) + 1;
      const scoreDisplay = options.showScores
        ? (options.plain ? ` (score: ${chunk.score.toFixed(3)})` : style.dim(` (score: ${chunk.score.toFixed(3)})`))
        : "";

      // Parse Text
      const { header, body } = parseChunkText(chunk.text ?? "");

      // Context Header (e.g. "Function: myFunc") - Only show if meaningful
      if (header && !options.showContent) {
        const contextLines = header
          .split("\n")
          .filter((l) => !l.startsWith("File:") && !l.includes("(anchor)"))
          .map((l) => l.trim())
          .filter(Boolean);

        if (contextLines.length > 0) {
          const contextStr = contextLines.join(" > ");
          output += options.plain
            ? `   Context: ${contextStr}`
            : `\n   ${style.dim("Context: " + contextStr)}`;
        }
      }

      // Clean Snippet Body
      let displayBody = body;
      let linesRemoved = 0;

      if (!options.showContent) {
        const cleaned = cleanSnippet(body);
        let lines = cleaned.cleanedLines;
        linesRemoved = cleaned.linesRemoved;

        // Truncate length
        const chunkType =
          typeof (chunk.metadata as any)?.chunk_type === "string"
            ? ((chunk.metadata as any).chunk_type as string)
            : "";
        const isDefinition =
          chunkType === "function" ||
          chunkType === "class" ||
          chunkType === "method";
        const maxLines = isDefinition ? 25 : 12;
        if (lines.length > maxLines) {
          lines = lines.slice(0, maxLines);
          lines.push(
            `... (+${cleaned.cleanedLines.length - maxLines} more lines)`,
          );
        }
        displayBody = lines.join("\n");
      }

      // Adjust start line based on cleaning
      startLine += linesRemoved;

      // Apply Syntax Highlighting (ANSI)
      let highlighted = displayBody;
      if (!options.plain) {
        try {
          const lang = detectLanguage(rawPath);
          highlighted = highlight(displayBody, {
            language: lang,
            ignoreIllegals: true,
          });
        } catch {
          // Fallback to plain text
        }
      }

      // Apply Line Numbers
      const lines = highlighted.split("\n");
      const snippet = lines
        .map((line, i) => {
          if (options.plain) {
            // Simple format: "10: code"
            return `${startLine + i}: ${line}`;
          }
          // Fancy format: "  10 │ code"
          const lineNum = style.dim(`${startLine + i}`.padStart(4) + " │");
          return `${lineNum} ${line}`;
        })
        .join("\n");

      output += options.plain ? `\n${snippet}${scoreDisplay}\n` : `\n${snippet}${scoreDisplay}\n`;

      // Visual separator between chunks in same file if needed
      if (
        shownChunks.length > 1 &&
        chunk !== shownChunks[shownChunks.length - 1]
      ) {
        output += options.plain ? "...\n" : `${style.dim("      ...")}\n`;
      }
    }

    // Separator between files
    output += "\n";
  }

  return output.trimEnd();
}

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .option(
    "-m <max_count>, --max-count <max_count>",
    "The maximum number of results to return (total)",
    "10",
  )
  .option("-c, --content", "Show full chunk content instead of snippets", false)
  .option(
    "--per-file <n>",
    "Number of matches to show per file",
    "1",
  )
  .option("--scores", "Show relevance scores", false)
  .option("--compact", "Show file paths only", false)
  .option("--plain", "Disable ANSI colors and use simpler formatting", false)
  .option("--json", "Output results as JSON for machine consumption", false)
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
      store?: string;
      m: string;
      c: boolean;
      perFile: string;
      scores: boolean;
      compact: boolean;
      plain: boolean;
      json: boolean;
      sync: boolean;
      dryRun: boolean;
    } = cmd.optsWithGlobals();

    if (exec_path?.startsWith("--")) {
      exec_path = "";
    }

    const root = process.cwd();

    async function tryServerFastPath(): Promise<boolean> {
      const lock = await readServerLock(root);
      if (!lock || !lock.authToken) return false;

      const authHeader = { Authorization: `Bearer ${lock.authToken}` };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 100);
      try {
        const health = await fetch(`http://localhost:${lock.port}/health`, {
          signal: controller.signal,
          headers: authHeader,
        });
        if (!health.ok) return false;
      } catch (_err) {
        return false;
      } finally {
        clearTimeout(timeout);
      }

      try {
        const searchRes = await fetch(
          `http://localhost:${lock.port}/search`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...authHeader,
            },
            body: JSON.stringify({
              query: pattern,
              limit: parseInt(options.m, 10),
              rerank: true,
              path: exec_path ?? "",
            }),
          },
        );
        if (!searchRes.ok) return false;
        const payload = await searchRes.json();

        // 1. HANDLE JSON MODE (Machine)
        if (options.json) {
          console.log(JSON.stringify(payload));
          return true;
        }

        // 2. Rehydrate server results to match local store shape expected by formatSearchResults.
        // Server payload is flat ({ path, content/snippet, score, chunk_type? }).
        const rehydratedResults = (payload.results ?? []).map((r: any) => ({
          score: typeof r.score === "number" ? r.score : 0,
          text: r.content ?? r.snippet ?? "",
          metadata: {
            path: typeof r.path === "string" ? r.path : "Unknown path",
            is_anchor: r.is_anchor === true,
          },
          generated_metadata: {
            type: r.chunk_type,
            start_line: typeof r.start_line === "number" ? r.start_line : 0,
            num_lines:
              typeof r.num_lines === "number" ? r.num_lines : undefined,
          },
        }));

        // 2. HANDLE TEXT MODE (Agent/Human)
        // Check for the status flag
        if (payload.status === "indexing") {
          const pct = payload.progress ?? 0;
          console.error(
            `⚠️  osgrep is currently indexing (${pct}% complete). Results may be partial.\n`,
          );
        }

        // Auto-detect plain mode if not in TTY (e.g. piped to agent)
        const isTTY = process.stdout.isTTY;
        const shouldBePlain = options.plain || !isTTY;

        const output = formatSearchResults(
          { data: rehydratedResults } as any,
          {
            showContent: options.c,
            perFile: parseInt(options.perFile, 10),
            showScores: options.scores,
            compact: options.compact,
            plain: shouldBePlain,
            maxCount: parseInt(options.m, 10),
            root,
          },
        );
        console.log(output);
        return true;
      } catch (_err) {
        return false;
      }
    }

    if (options.json) {
      const fast = await tryServerFastPath();
      if (fast) {
        return;
      }
    }

    let store: Store | null = null;
    try {
      await ensureSetup({ silent: options.json });
      store = await createStore();

      // Auto-detect store ID if not explicitly provided
      const storeId = options.store || getAutoStoreId(root);

      await ensureStoreExists(store, storeId);
      const autoSync =
        options.sync || (await isStoreEmpty(store, storeId));
      let didSync = false;

      if (autoSync) {
        const fileSystem = createFileSystem({
          ignorePatterns: DEFAULT_IGNORE_PATTERNS,
        });
        const metaStore = new MetaStore();

        if (options.json) {
          // JSON mode: silent indexing without UI
          await initialSync(
            store,
            fileSystem,
            storeId,
            root,
            options.dryRun,
            undefined, // No progress callback
            metaStore,
            undefined, // No timeout for JSON mode (usually machine controlled)
          );
          if (!options.dryRun) {
            while (true) {
              const info = await store.getInfo(storeId);
              if (info.counts.pending === 0 && info.counts.in_progress === 0) {
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          didSync = true;
          if (options.dryRun) {
            console.log(JSON.stringify({ results: [] }));
            return;
          }
        } else {
          // Human/Agent mode
          const isTTY = process.stdout.isTTY;
          let abortController: AbortController | undefined;
          let signal: AbortSignal | undefined;

          // If non-interactive (Agent), enforce a timeout to prevent hanging
          if (!isTTY) {
            abortController = new AbortController();
            signal = abortController.signal;
            setTimeout(() => {
              abortController?.abort();
            }, 10000); // 10s timeout
          }

          // Show spinner and progress
          const { spinner, onProgress } = createIndexingSpinner(
            root,
            options.sync ? "Indexing..." : "Indexing repository (first run)...",
          );

          try {
            const result = await initialSync(
              store,
              fileSystem,
              storeId,
              root,
              options.dryRun,
              onProgress,
              metaStore,
              signal,
            );

            if (signal?.aborted) {
              spinner.warn(
                `Indexing timed out (${result.processed}/${result.total}). Results may be partial.`,
              );
            } else {
              while (true) {
                const info = await store.getInfo(storeId);
                spinner.text = `Indexing ${info.counts.pending + info.counts.in_progress} file(s)`;
                if (
                  info.counts.pending === 0 &&
                  info.counts.in_progress === 0
                ) {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 1000));
              }
              spinner.succeed(
                `Indexing complete (${result.processed}/${result.total}) • indexed ${result.indexed}`,
              );
            }
            didSync = true;

            if (options.dryRun) {
              console.log(
                formatDryRunSummary(result, {
                  actionDescription: "would have indexed",
                }),
              );
              process.exit(0);
            }
          } catch (err) {
            spinner.fail("Indexing failed");
            throw err;
          }
        }
      }

      const search_path = exec_path?.startsWith("/")
        ? exec_path
        : normalize(join(root, exec_path ?? ""));

      // Execute Search
      const results = await store.search(
        storeId,
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

      // Handle JSON output
      if (options.json) {
        const dense = toDenseResults(root, results.data);
        console.log(JSON.stringify({ results: dense }));
        return; // Let Node exit naturally
      }

      // Hint if no results found
      if (results.data.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ results: [] }));
          return;
        }
        if (!didSync) {
          try {
            const info = await store.getInfo(storeId);
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
        return; // Let Node exit naturally
      }

      // Auto-detect plain mode if not in TTY (e.g. piped to agent)
      const isTTY = process.stdout.isTTY;
      const shouldBePlain = options.plain || !isTTY;

      // Render Output
      const output = formatSearchResults(results, {
        showContent: options.c,
        perFile: parseInt(options.perFile, 10),
        showScores: options.scores,
        compact: options.compact,
        plain: shouldBePlain,
        maxCount: parseInt(options.m, 10),
        root,
      });

      console.log(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exitCode = 1;
    } finally {
      // Always clean up the store
      if (store && typeof store.close === "function") {
        try {
          await store.close();
        } catch (err) {
          console.error("Failed to close store:", err);
        }
      }
    }
  });
