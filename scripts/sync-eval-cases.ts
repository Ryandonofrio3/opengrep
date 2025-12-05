import * as fs from "node:fs";
import * as path from "node:path";

const newEvalPath = path.resolve(__dirname, "../src/eval.ts");
const oldEvalPath = path.resolve(__dirname, "../../old-osgrep/src/eval.ts");

function extractCases(content: string, label: string) {
  const match = content.match(
    /export const cases: EvalCase\[] = ([\s\S]*?)\nconst topK/,
  );
  if (!match) {
    throw new Error(`Could not find cases array in ${label}`);
  }
  return match[1].trim();
}

function replaceCases(targetContent: string, newCases: string) {
  return targetContent.replace(
    /export const cases: EvalCase\[] = ([\s\S]*?)\nconst topK/,
    `export const cases: EvalCase[] = ${newCases}\nconst topK`,
  );
}

function main() {
  const newEval = fs.readFileSync(newEvalPath, "utf-8");
  const oldEval = fs.readFileSync(oldEvalPath, "utf-8");

  const newCases = extractCases(newEval, newEvalPath);
  const updatedOld = replaceCases(oldEval, newCases);

  fs.writeFileSync(oldEvalPath, updatedOld);
  console.log(`Synced eval cases from ${newEvalPath} -> ${oldEvalPath}`);
}

main();
