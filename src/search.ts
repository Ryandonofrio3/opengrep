import type { Command } from "commander";
import { Command as CommanderCommand } from "commander";
import { getJWTToken } from "./lib/auth";
import { createMxbaiClient } from "./lib/mxbai";
import type { FileMetadata } from "./types";
import { ensureAuthenticated } from "./utils";

export const search: Command = new CommanderCommand("search")
  .description("File pattern searcher")
  .argument("<pattern>", "The pattern to search for")
  .action(async (pattern, _options, cmd) => {
    const options: { store: string } = cmd.optsWithGlobals();

    await ensureAuthenticated();

    try {
      const jwtToken = await getJWTToken();
      const mxbai = createMxbaiClient(jwtToken);

      const path = process.cwd();

      const results = await mxbai.stores.search({
        query: pattern,
        store_identifiers: [options.store],
        filters: {
          all: [
            {
              key: "path",
              operator: "starts_with",
              value: path,
            },
          ],
        },
      });

      console.log(
        results.data
          .map((result) => {
            let content =
              result.type === "text"
                ? result.text
                : `Not a text chunk! (${result.type})`;
            content = JSON.stringify(content);
            return `${(result.metadata as FileMetadata)?.path ?? "Unknown path"}: ${content}`;
          })
          .join("\n"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to search:", message);
      process.exitCode = 1;
    }
  });
