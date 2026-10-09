// Verifies and rebuilds every committed example lesson. Run: npm run demo
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolkit = path.join(root, "skills", "i-didnt-write-this", "assets", "toolkit.mjs");

const EXAMPLES = [
  { name: "cart", repo: "fixtures/cart" },
  { name: "limiter", repo: "fixtures/limiter" },
];

let failed = false;
for (const { name, repo } of EXAMPLES) {
  const lesson = path.join("examples", name, "lesson.json");
  const output = path.join("examples", name, "lesson.html");
  for (const args of [
    ["verify", lesson, "--repo", repo],
    ["build", lesson, "--repo", repo, "--output", output],
  ]) {
    const res = spawnSync(process.execPath, [toolkit, ...args], { cwd: root, encoding: "utf8", timeout: 120_000 });
    if (res.status !== 0) {
      failed = true;
      process.stderr.write(`demo ${name} ${args[0]} failed:\n${res.stderr || res.stdout}\n`);
    }
  }
  const bytes = fs.statSync(path.join(root, output)).size;
  process.stdout.write(`${name}: verified and rebuilt (${bytes} bytes)\n`);
}
process.exit(failed ? 1 : 0);
