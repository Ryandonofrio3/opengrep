/**
 * Gracefully exits the process after a short delay to allow buffers to flush.
 * This is useful when background threads (e.g. ONNX Runtime) prevent natural exit.
 */
export async function gracefulExit(code = 0) {
    // Give stdout/stderr a moment to flush
    await new Promise((resolve) => setTimeout(resolve, 250));
    process.exit(code);
}
