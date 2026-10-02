import { execFileSync } from "node:child_process";

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
});
const reports = JSON.parse(raw);
if (!Array.isArray(reports) || reports.length !== 1) {
  throw new Error("npm pack must return exactly one package report");
}

const files = new Set(reports[0].files.map((entry) => entry.path));
for (const required of [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/workspace.js",
  "dist/workspace.d.ts"
]) {
  if (!files.has(required)) throw new Error(`package smoke missing ${required}`);
}

for (const path of files) {
  if (/^(?:src|tests|scripts|native|docs|reports|\.github)\//.test(path)) {
    throw new Error(`package smoke leaked development path: ${path}`);
  }
}

console.log(`package smoke passed: ${files.size} files`);
