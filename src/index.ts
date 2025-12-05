#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { program } from "commander";
import { installClaudeCode } from "./commands/claude-code";
import { doctor } from "./commands/doctor";
import { index } from "./commands/index";
import { list } from "./commands/list";
import { search } from "./commands/search";
import { serve } from "./commands/serve";
import { setup } from "./commands/setup";

program
  .version(
    JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), {
        encoding: "utf-8",
      }),
    ).version,
  )
  .option(
    "--store <string>",
    "The store to use (auto-detected if not specified)",
    process.env.OSGREP_STORE || undefined,
  );

const legacyDataPath = path.join(
  require("node:os").homedir(),
  ".osgrep",
  "data",
);
const isIndexCommand = process.argv.some((arg) => arg === "index");
if (isIndexCommand && fs.existsSync(legacyDataPath)) {
  console.log("⚠️  Legacy global database detected at ~/.osgrep/data.");
  console.log("   osgrep now uses per-project .osgrep/ directories.");
  console.log(
    "   Run 'osgrep index' in your project root to create a new index.",
  );
}

program.addCommand(search, { isDefault: true });
program.addCommand(index);
program.addCommand(list);
program.addCommand(setup);
program.addCommand(serve);
program.addCommand(installClaudeCode);
program.addCommand(doctor);

program.parse();
