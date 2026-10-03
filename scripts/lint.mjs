import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["src", "tests/unit", "tests/integration", "tests/browser"];
const extensions = new Set([".ts", ".js", ".mjs"]);
const violations = [];

async function collect(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collect(child));
    else if (entry.isFile() && extensions.has(extname(entry.name))) files.push(child);
  }
  return files;
}

for (const root of roots) {
  for (const path of await collect(root)) {
    const content = await readFile(path, "utf8");
    const lines = content.split("\n");
    if (!content.endsWith("\n")) violations.push(`${path}: file must end with newline`);
    if (content.includes("\r")) violations.push(`${path}: CRLF is not allowed`);
    lines.forEach((line, index) => {
      if (/[ \t]+$/.test(line)) violations.push(`${path}:${index + 1}: trailing whitespace`);
      if (/\t/.test(line)) violations.push(`${path}:${index + 1}: tab indentation is not allowed`);
      if (/@ts-(?:ignore|nocheck)/.test(line)) violations.push(`${path}:${index + 1}: TypeScript suppression is not allowed`);
      if (/\bdebugger\s*;/.test(line)) violations.push(`${path}:${index + 1}: debugger statement is not allowed`);
      if (/\bvar\s+/.test(line)) violations.push(`${path}:${index + 1}: use let/const instead of var`);
    });
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
} else {
  console.log("source lint passed");
}
