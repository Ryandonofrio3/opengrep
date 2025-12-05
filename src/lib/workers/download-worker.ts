import * as os from "node:os";
import * as path from "node:path";
import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import { MODEL_IDS } from "../../config";

// Configuration
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Suppress noisy warnings from transformers.js/onnxruntime
const originalWarn = console.warn;
console.warn = (...args) => {
  if (
    args[0] &&
    typeof args[0] === "string" &&
    args[0].includes("Unable to determine content-length")
  ) {
    return;
  }
  originalWarn(...args);
};

type QuantizationDType =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

type PipelineDType = QuantizationDType | Record<string, QuantizationDType>;

// Helper to download with timeout
async function downloadModelWithTimeout(modelId: string, dtype: PipelineDType) {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  try {
    const downloadPromise = pipeline("feature-extraction", modelId, {
      dtype,
      progress_callback: (progress: unknown) => {
        if (parentPort) parentPort.postMessage({ type: "progress", progress });
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`Download timed out after ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      );
    });

    return Promise.race([downloadPromise, timeoutPromise]);
  } catch (err) {
    console.error(`Worker: pipeline creation failed for ${modelId}: `, err);
    throw err;
  }
}

async function download() {
  try {
    // 1. Download Dense Model
    const embedPipeline = await downloadModelWithTimeout(MODEL_IDS.embed, "q4");
    await embedPipeline.dispose();

    // 2. Download ColBERT Model
    const colbertPipeline = await downloadModelWithTimeout(
      MODEL_IDS.colbert,
      "fp32",
    );
    await colbertPipeline.dispose();

    if (parentPort) {
      parentPort.postMessage({ status: "success" });
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error("Worker failed to download models:", error);
    if (parentPort) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      parentPort.postMessage({ status: "error", error: errorMsg });
    } else {
      process.exit(1);
    }
  }
}

download();
