
import { parentPort } from "node:worker_threads";
import { env, pipeline } from "@huggingface/transformers";
import * as path from "node:path";
import * as os from "node:os";
import { MODEL_IDS } from "../config";

// Configuration
const HOMEDIR = os.homedir();
const CACHE_DIR = path.join(HOMEDIR, ".osgrep", "models");
env.cacheDir = CACHE_DIR;
env.allowLocalModels = true;
env.allowRemoteModels = true;

// Helper to download with timeout
async function downloadModelWithTimeout(modelId: string, dtype: any) {
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    const downloadPromise = pipeline("feature-extraction", modelId, {
        dtype,
        progress_callback: (progress: any) => {
            if (parentPort) parentPort.postMessage({ type: "progress", progress });
        },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Download timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    });

    return Promise.race([downloadPromise, timeoutPromise]);
}

async function download() {
    try {
        // 1. Download Dense Model
        const embedPipeline = await downloadModelWithTimeout(MODEL_IDS.embed, "q4");
        await embedPipeline.dispose();

        // 2. Download ColBERT Model
        const colbertPipeline = await downloadModelWithTimeout(MODEL_IDS.colbert, "q8");
        await colbertPipeline.dispose();

        if (parentPort) {
            parentPort.postMessage({ status: "success" });
        } else {
            process.exit(0);
        }
    } catch (error) {
        console.error("Worker failed to download models:", error);
        if (parentPort) {
            parentPort.postMessage({ status: "error", error: error instanceof Error ? error.message : String(error) });
        } else {
            process.exit(1);
        }
    }
}

download();
