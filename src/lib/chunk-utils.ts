import type { Chunk } from "./chunker";

export type ChunkWithContext = Chunk & {
  context: string[];
  chunkIndex?: number;
  isAnchor?: boolean;
};

export function extractTopComments(lines: string[]): string[] {
  const comments: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inBlock) {
      comments.push(line);
      if (trimmed.includes("*/")) inBlock = false;
      continue;
    }
    if (trimmed === "") {
      comments.push(line);
      continue;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("#!") ||
      trimmed.startsWith("# ")
    ) {
      comments.push(line);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      comments.push(line);
      if (!trimmed.includes("*/")) inBlock = true;
      continue;
    }
    break;
  }
  while (comments.length > 0 && comments[comments.length - 1].trim() === "") {
    comments.pop();
  }
  return comments;
}

export function extractImports(lines: string[], limit = 200): string[] {
  const modules: string[] = [];
  for (const raw of lines.slice(0, limit)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("import ")) {
      const fromMatch = trimmed.match(/from\s+["']([^"']+)["']/);
      const sideEffect = trimmed.match(/^import\s+["']([^"']+)["']/);
      const named = trimmed.match(/import\s+(?:\* as\s+)?([A-Za-z0-9_$]+)/);
      if (fromMatch?.[1]) modules.push(fromMatch[1]);
      else if (sideEffect?.[1]) modules.push(sideEffect[1]);
      else if (named?.[1]) modules.push(named[1]);
      continue;
    }
    const requireMatch = trimmed.match(/require\(\s*["']([^"']+)["']\s*\)/);
    if (requireMatch?.[1]) {
      modules.push(requireMatch[1]);
    }
  }
  return Array.from(new Set(modules));
}

export function extractExports(lines: string[], limit = 200): string[] {
  const exports: string[] = [];
  for (const raw of lines.slice(0, limit)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("export") && !trimmed.includes("module.exports"))
      continue;

    const decl = trimmed.match(
      /^export\s+(?:default\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/,
    );
    if (decl?.[2]) {
      exports.push(decl[2]);
      continue;
    }

    const brace = trimmed.match(/^export\s+\{([^}]+)\}/);
    if (brace?.[1]) {
      const names = brace[1]
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      exports.push(...names);
      continue;
    }

    if (trimmed.startsWith("export default")) {
      exports.push("default");
    }

    if (trimmed.includes("module.exports")) {
      exports.push("module.exports");
    }
  }
  return Array.from(new Set(exports));
}

export function formatChunkText(
  chunk: ChunkWithContext,
  filePath: string,
): string {
  const breadcrumb = [...chunk.context];
  const fileLabel = `File: ${filePath || "unknown"}`;
  const hasFileLabel = breadcrumb.some(
    (entry) => typeof entry === "string" && entry.startsWith("File: "),
  );
  if (!hasFileLabel) {
    breadcrumb.unshift(fileLabel);
  }
  const header = breadcrumb.length > 0 ? breadcrumb.join(" > ") : fileLabel;
  return `${header}\n---\n${chunk.content}`;
}

export function buildAnchorChunk(
  filePath: string,
  content: string,
): Chunk & { context: string[]; chunkIndex: number; isAnchor: boolean } {
  const lines = content.split("\n");
  const topComments = extractTopComments(lines);
  const imports = extractImports(lines);
  const exports = extractExports(lines);

  const preamble: string[] = [];
  let nonBlank = 0;
  let totalChars = 0;
  let lastIncludedLineIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    preamble.push(line);
    lastIncludedLineIdx = i;
    nonBlank += 1;
    totalChars += line.length;
    if (nonBlank >= 30 || totalChars >= 1200) break;
  }

  const sections: string[] = [];
  sections.push(`File: ${filePath}`);
  if (imports.length > 0) {
    sections.push(`Imports: ${imports.join(", ")}`);
  }
  if (exports.length > 0) {
    sections.push(`Exports: ${exports.join(", ")}`);
  }
  if (topComments.length > 0) {
    sections.push(`Top comments:\n${topComments.join("\n")}`);
  }
  if (preamble.length > 0) {
    sections.push(`Preamble:\n${preamble.join("\n")}`);
  }
  sections.push("---");
  sections.push("(anchor)");

  const anchorText = sections.join("\n\n");
  // Use the actual line index of the last included line
  const approxEndLine = Math.min(lines.length - 1, Math.max(0, lastIncludedLineIdx));

  return {
    content: anchorText,
    startLine: 0,
    endLine: approxEndLine,
    type: "block",
    context: [`File: ${filePath}`, "Anchor"],
    chunkIndex: -1,
    isAnchor: true,
  };
}
