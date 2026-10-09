// Builds the lesson pages under test with the real toolkit pipeline, so the
// E2E suite exercises the same artifacts a user would open.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildHtml } from "../skills/i-didnt-write-this/assets/toolkit.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-e2e-"));

const demoLessonPath = path.join(repoRoot, "tests", "fixtures", "cart-lesson.json");
const cartRepo = path.join(repoRoot, "fixtures", "cart");

function urlFor(name) {
  return pathToFileURL(path.join(outDir, name)).href;
}

export default async function globalSetup() {
  const demo = JSON.parse(fs.readFileSync(demoLessonPath, "utf8"));

  // 1. The reference pages, built with the real pipeline from the test fixtures.
  const demoUrl = urlFor("demo.html");
  const limiterLesson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "tests", "fixtures", "limiter-lesson.json"), "utf8")
  );
  fs.writeFileSync(path.join(outDir, "demo.html"), (await buildHtml(demo, cartRepo)).html);
  fs.writeFileSync(
    path.join(outDir, "limiter.html"),
    (await buildHtml(limiterLesson, path.join(repoRoot, "fixtures", "limiter"))).html
  );

  // 2. Same lesson with every challenge unverified.
  const unverified = structuredClone(demo);
  for (const c of unverified.challenges) c.verifiedBy = [];
  const unverifiedHtml = (await buildHtml(unverified, cartRepo)).html;

  // 3. Hostile content that must be escaped, never executed.
  const hostile = structuredClone(demo);
  hostile.title = '<script>alert("title")</script>';
  hostile.challenges[0].prompt = '<img src=x onerror="alert(2)">';
  hostile.challenges[0].hints = ["<script>alert(3)</script>"];
  hostile.limitations = ["<svg onload=alert(4)>"];
  const hostileHtml = (await buildHtml(hostile, cartRepo)).html;

  // 4. A drifted repository: the lesson's references are now stale.
  const staleRepo = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-e2e-stale-"));
  fs.cpSync(cartRepo, staleRepo, { recursive: true });
  fs.appendFileSync(path.join(staleRepo, "src", "store.js"), "\n// edited after the lesson was generated\n");
  const staleHtml = (await buildHtml(demo, staleRepo)).html;

  fs.writeFileSync(path.join(outDir, "unverified.html"), unverifiedHtml);
  fs.writeFileSync(path.join(outDir, "hostile.html"), hostileHtml);
  fs.writeFileSync(path.join(outDir, "stale.html"), staleHtml);

  const manifest = {
    demo: demoUrl,
    limiter: urlFor("limiter.html"),
    unverified: urlFor("unverified.html"),
    hostile: urlFor("hostile.html"),
    stale: urlFor("stale.html"),
    answers: demo.challenges.map((c) => ({ id: c.id, answer: c.answer })),
  };
  fs.writeFileSync(path.join(repoRoot, "e2e", ".build-manifest.json"), JSON.stringify(manifest, null, 2));
  process.env.IDWT_E2E_MANIFEST = "written";
  console.log(`e2e pages built in ${outDir}`);
}
