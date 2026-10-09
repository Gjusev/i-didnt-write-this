import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export { repoRoot };
export const CART_REPO = path.join(repoRoot, "fixtures", "cart");
export const TOOLKIT = path.join(repoRoot, "skills", "i-didnt-write-this", "assets", "toolkit.mjs");
export const DEMO_LESSON_PATH = path.join(repoRoot, "examples", "cart", "lesson.json");

export function loadDemoLesson() {
  return JSON.parse(fs.readFileSync(DEMO_LESSON_PATH, "utf8"));
}

export function hashTree(root) {
  const hashes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else hashes[path.relative(root, abs).split(path.sep).join("/")] = fs.readFileSync(abs).toString("base64");
    }
  };
  walk(root);
  return hashes;
}
