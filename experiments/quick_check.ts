import { VectorDB } from "../src/lib/store/vector-db";
import { ensureProjectPaths, findProjectRoot } from "../src/lib/utils/project-root";

async function main() {
  const root = process.cwd();
  const paths = ensureProjectPaths(findProjectRoot(root) ?? root);
  const db = new VectorDB(paths.lancedbDir);
  const table = await db.ensureTable();
  const rows = (await table.query().limit(5).toArray()) as any[];
  rows.forEach((r, i) => {
    const col = r.colbert;
    let len = 0;
    if (Buffer.isBuffer(col)) len = col.length;
    else if (Array.isArray(col)) len = col.length;
    else if (
      col &&
      typeof col === "object" &&
      "length" in (col as Record<string, unknown>)
    )
      len = Number((col as { length: number }).length) || 0;
    else if (col && col.type === "Buffer" && Array.isArray(col.data))
      len = col.data.length;
    console.log(`#${i} path=${r.path}, colbertLen=${len}, scale=${r.colbert_scale}`);
  });
}
main().catch(console.error);
