import * as fs from "node:fs";

import * as path from "node:path";
import { Command } from "commander";
import { PATHS } from "../config";
import { gracefulExit } from "../lib/utils/exit";


const style = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
};

/**
 * Formats a byte size into a human-readable string
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Formats a date to a relative time string
 */
function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

/**
 * Gets the size of a directory recursively
 */
function getDirectorySize(dirPath: string): number {
  let totalSize = 0;

  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stats = fs.statSync(itemPath);

      if (stats.isDirectory()) {
        totalSize += getDirectorySize(itemPath);
      } else {
        totalSize += stats.size;
      }
    }
  } catch {
    // Ignore errors
  }

  return totalSize;
}

export const list = new Command("list")
  .description("List all osgrep stores and their metadata")
  .action(async () => {
    const dataDir = PATHS.data;

    // Check if data directory exists
    if (!fs.existsSync(dataDir)) {
      console.log("No stores found.");
      console.log(
        `\nRun ${style.green("osgrep index")} in a repository to create your first store.`,
      );
      await gracefulExit();
      return;
    }

    // Read all subdirectories (these are stores)
    let stores: string[] = [];
    try {
      const items = fs.readdirSync(dataDir);
      stores = items.filter((item) => {
        const itemPath = path.join(dataDir, item);
        return fs.statSync(itemPath).isDirectory();
      });
    } catch (error) {
      console.error("Failed to read stores:", error);
      await gracefulExit(1);
    }

    if (stores.length === 0) {
      console.log("No stores found.");
      console.log(
        `\nRun ${style.green("osgrep index")} in a repository to create your first store.`,
      );
      await gracefulExit();
      return;
    }

    // Display header
    console.log(
      `\n${style.bold(`Found ${stores.length} store(s):`)} ${style.dim(`(in ~/.osgrep/data)`)}\n`,
    );

    // Collect and display store info
    const storeInfo = stores.map((storeName) => {
      const storePath = path.join(dataDir, storeName);
      const stats = fs.statSync(storePath);
      const size = getDirectorySize(storePath);

      return {
        name: storeName,
        size,
        modified: stats.mtime,
      };
    });

    // Sort by most recently modified
    storeInfo.sort((a, b) => b.modified.getTime() - a.modified.getTime());

    // Display stores
    for (const store of storeInfo) {
      const nameDisplay = style.green(style.bold(store.name));
      const sizeDisplay = style.dim(formatSize(store.size));
      const dateDisplay = style.dim(formatDate(store.modified));

      console.log(`  ${nameDisplay}`);
      console.log(`    Size: ${sizeDisplay} • Modified: ${dateDisplay}`);
      console.log();
    }

    console.log(style.dim(`To clean up a store: rm -rf ~/.osgrep/data/<store-name>`));
    console.log(
      style.dim(`To use a specific store: osgrep --store <store-name> <query>`),
    );
    await gracefulExit();
  });

