import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LANGUAGES } from "../core/languages";

export const GRAMMARS_DIR = path.join(os.homedir(), ".osgrep", "grammars");

const GRAMMAR_URLS: Record<string, string> = {};
for (const lang of LANGUAGES) {
    if (lang.grammar) {
        GRAMMAR_URLS[lang.grammar.name] = lang.grammar.url;
    }
}

const downloadFile = async (url: string, dest: string) => {
    const response = await fetch(url, {
        headers: {
            "User-Agent": "osgrep",
        },
    });
    if (!response.ok) throw new Error(`Failed to download ${url}`);
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(dest, Buffer.from(arrayBuffer));
};

export async function ensureGrammars(log: (msg: string) => void = console.log) {
    if (!fs.existsSync(GRAMMARS_DIR)) {
        fs.mkdirSync(GRAMMARS_DIR, { recursive: true });
    }

    for (const [lang, url] of Object.entries(GRAMMAR_URLS)) {
        const dest = path.join(GRAMMARS_DIR, `tree-sitter-${lang}.wasm`);
        if (fs.existsSync(dest)) {
            log(`✓ Grammar: ${lang}`);
        } else {
            // Use process.stdout directly for the "Downloading..." part if possible,
            // but to keep it simple with the passed log function, we'll just log a start message.
            // If the caller passed console.log, it will print a newline.
            // For a better UX, we might want to allow a more complex logger, but for now:
            if (log === console.log) {
                process.stdout.write(`⬇ Downloading ${lang} grammar... `);
            } else {
                log(`⬇ Downloading ${lang} grammar...`);
            }

            try {
                await downloadFile(url, dest);
                if (log === console.log) {
                    console.log("Done");
                } else {
                    log(`Downloaded ${lang} grammar`);
                }
            } catch (err) {
                if (log === console.log) {
                    console.log("Failed");
                }
                console.error(`  Error downloading ${lang}:`, err);
            }
        }
    }
}
