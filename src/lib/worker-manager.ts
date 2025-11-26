import * as fs from "node:fs";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { v4 as uuidv4 } from "uuid";
import { WORKER_TIMEOUT_MS } from "../config";

type WorkerRequest =
  | { id: string; hybrid: { texts: string[] } }
  | { id: string; query: { text: string } };

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId?: NodeJS.Timeout;
};

export class WorkerManager {
  private worker: Worker | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private isClosing = false;

  constructor() {
    this.worker = this.createWorker();
  }

  private getWorkerConfig(): { workerPath: string; execArgv: string[] } {
    const tsWorkerPath = path.join(__dirname, "worker.ts");
    const jsWorkerPath = path.join(__dirname, "worker.js");
    const hasTsWorker = fs.existsSync(tsWorkerPath);
    const hasJsWorker = fs.existsSync(jsWorkerPath);
    const runningTs = path.extname(__filename) === ".ts";
    const isDev = (runningTs && hasTsWorker) || (hasTsWorker && !hasJsWorker);

    if (isDev) {
      return { workerPath: tsWorkerPath, execArgv: ["-r", "ts-node/register"] };
    }
    return { workerPath: jsWorkerPath, execArgv: [] };
  }

  private createWorker(): Worker {
    const { workerPath, execArgv } = this.getWorkerConfig();
    const worker = new Worker(workerPath, { execArgv });

    worker.on("message", (message) => this.handleMessage(message));
    worker.on("error", (err) => {
      console.error("Worker error:", err);
      this.rejectAll(err instanceof Error ? err : new Error(String(err)));
      // Let the worker exit; ensure we create a fresh one next time.
      this.worker = null;
    });
    worker.on("exit", (code) => {
      if (!this.isClosing && code !== 0) {
        console.error(
          `Worker crashed (code ${code}). It will auto-restart on next request.`,
        );
        const error = new Error(`Worker exited with code ${code}`);
        console.error("Worker exited unexpectedly. Pending requests will be rejected.");
        this.rejectAll(error);
      }
      // Clear reference so ensureWorker will spawn a new worker on demand.
      this.worker = null;
    });

    return worker;
  }

  private handleMessage(message: any) {
    const { id, hybrids, query, error } = message;
    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    if (pending.timeoutId) clearTimeout(pending.timeoutId);

    if (error) {
      pending.reject(new Error(error));
    } else if (hybrids !== undefined) {
      pending.resolve(hybrids);
    } else if (query !== undefined) {
      pending.resolve(query);
    } else {
      pending.resolve(undefined);
    }

    this.pendingRequests.delete(id);
  }

  private rejectAll(error: Error) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = this.createWorker();
    }
    return this.worker;
  }

  private async sendToWorker<T>(
    buildPayload: (id: string) => WorkerRequest,
  ): Promise<T> {
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const payload = buildPayload(id);

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          reject(
            new Error(`Worker request timed out after ${WORKER_TIMEOUT_MS}ms`),
          );
        }
      }, WORKER_TIMEOUT_MS);
      // Ensure the timeout doesn't prevent the process from exiting if everything else is done
      timeoutId.unref();

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject: reject as (reason: unknown) => void,
        timeoutId,
      });

      worker.postMessage(payload);
    });
  }

  async computeHybrid(
    texts: string[],
  ): Promise<Array<{ dense: number[]; colbert: Buffer; scale: number }>> {
    return this.sendToWorker<Array<{ dense: number[]; colbert: Buffer; scale: number }>>((id) => ({
      id,
      hybrid: { texts },
    }));
  }

  async encodeQuery(
    text: string,
  ): Promise<{ dense: number[]; colbert: number[][] }> {
    return this.sendToWorker<{ dense: number[]; colbert: number[][] }>((id) => ({
      id,
      query: { text },
    }));
  }

  async close(): Promise<void> {
    this.isClosing = true;
    try {
      this.worker?.postMessage({ type: "shutdown" });
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (err) {
      // Silent cleanup
    }
    try {
      if (this.worker) {
        await this.worker.terminate();
      }
    } catch (_err) {
      // Silent cleanup
    } finally {
      this.worker = null;
      this.pendingRequests.clear();
    }
  }
}

// Singleton instance to avoid spinning up multiple heavy embedding workers.
export const workerManager = new WorkerManager();
