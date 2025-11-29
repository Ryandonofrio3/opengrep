import { RepositoryScanner, type ScannerOptions } from "../index/scanner";
import { LocalStore } from "../store/local-store";
import type { Store } from "../store/store";

/**
 * Creates a Store instance
 */
export async function createStore(): Promise<Store> {
  return new LocalStore();
}

/**
 * Creates a FileSystem instance (RepositoryScanner)
 */
export function createFileSystem(
  options: ScannerOptions = { ignorePatterns: [] },
): RepositoryScanner {
  return new RepositoryScanner(options);
}

