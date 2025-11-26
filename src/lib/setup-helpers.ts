import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ora from "ora";
import { areModelsDownloaded, downloadModels } from "./model-loader";

export interface SetupPaths {
  root: string;
  models: string;
  data: string;
  grammars: string;
}

export interface SetupStatus extends SetupPaths {
  createdDirs: boolean;
  downloadedModels: boolean;
}

function getPaths(): SetupPaths {
  const home = os.homedir();
  const root = path.join(home, ".osgrep");
  return {
    root,
    models: path.join(root, "models"),
    data: path.join(root, "data"),
    grammars: path.join(root, "grammars"),
  };
}

/**
 * Idempotent helper that ensures osgrep directories and models exist.
 * Returns status about work performed so callers can decide what to show.
 */
export async function ensureSetup({
  silent,
}: {
  silent?: boolean;
} = {}): Promise<SetupStatus> {
  const paths = getPaths();
  const dirs = [paths.root, paths.models, paths.data, paths.grammars];

  const needsDirs = dirs.some((dir) => !fs.existsSync(dir));
  let createdDirs = false;

  const dirSpinner =
    !silent && needsDirs
      ? ora("Preparing osgrep directories...").start()
      : null;
  try {
    if (needsDirs) {
      dirs.forEach((dir) => {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
          createdDirs = true;
        }
      });
    }
    dirSpinner?.succeed("Directories ready");
  } catch (error) {
    dirSpinner?.fail("Failed to prepare directories");
    throw error;
  }

  const modelsPresent = areModelsDownloaded();
  let downloadedModels = false;

  if (!modelsPresent) {
    const modelSpinner = !silent
      ? ora("Downloading models (first run)...").start()
      : null;
    try {
      await downloadModels();
      downloadedModels = true;
      modelSpinner?.succeed("Models downloaded and ready");
    } catch (error) {
      modelSpinner?.fail("Failed to download models");
      throw error;
    }
  }

  return { ...paths, createdDirs, downloadedModels };
}

const GRAMMAR_URLS: Record<string, string> = {
  typescript:
    "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-typescript.wasm",
  tsx: "https://github.com/tree-sitter/tree-sitter-typescript/releases/latest/download/tree-sitter-tsx.wasm",
  python:
    "https://github.com/tree-sitter/tree-sitter-python/releases/latest/download/tree-sitter-python.wasm",
  go: "https://github.com/tree-sitter/tree-sitter-go/releases/latest/download/tree-sitter-go.wasm",
};

/**
 * Ensures all supported tree-sitter grammars are downloaded.
 * Used during index --reset to restore grammars to a known good state.
 */
export async function ensureGrammarsDownloaded(): Promise<void> {
  const paths = getPaths();
  const grammarsDir = paths.grammars;

  if (!fs.existsSync(grammarsDir)) {
    fs.mkdirSync(grammarsDir, { recursive: true });
  }

  const downloadFile = async (url: string, dest: string): Promise<void> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(arrayBuffer));
  };

  for (const [lang, url] of Object.entries(GRAMMAR_URLS)) {
    const wasmPath = path.join(grammarsDir, `tree-sitter-${lang}.wasm`);
    if (!fs.existsSync(wasmPath)) {
      try {
        await downloadFile(url, wasmPath);
      } catch (err) {
        console.warn(`⚠️  Could not download ${lang} grammar: ${err}`);
      }
    }
  }
}
