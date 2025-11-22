import { exec } from "node:child_process";
import { Command } from "commander";

const shell =
  process.env.SHELL ||
  (process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "/bin/sh");

function installPlugin() {
  exec(
    "claude plugin marketplace add Ryandonofrio3/osgrep",
    { shell, env: process.env },
    (error) => {
      if (error) {
        console.error("❌ Error adding marketplace:");
        console.error(error);
        console.error("\nTroubleshooting:");
        console.error("- Ensure you have Claude Code version 2.0.36 or higher installed");
        console.error("- Try running: claude plugin marketplace list");
        console.error("- Check the Claude Code documentation: https://code.claude.com/docs");
        process.exit(1);
      }
      console.log("✅ Successfully added the osgrep marketplace");
      exec(
        "claude plugin install osgrep",
        { shell, env: process.env },
        (error) => {
          if (error) {
            console.error("❌ Error installing plugin:");
            console.error(error);
            process.exit(1);
          }
          console.log("✅ Successfully installed the osgrep plugin for Claude Code");
          console.log("\nNext steps:");
          console.log("1. Restart Claude Code if it's running");
          console.log(
            "2. The plugin will automatically index your project when you open it",
          );
          console.log(
            "3. Claude will use osgrep for semantic code search automatically",
          );
          console.log(
            "4. You can also use `osgrep` commands directly in your terminal",
          );
        },
      );
    },
  );
}

export const installClaudeCode = new Command("install-claude-code")
  .description("Install the Claude Code plugin")
  .action(() => {
    installPlugin();
  });
