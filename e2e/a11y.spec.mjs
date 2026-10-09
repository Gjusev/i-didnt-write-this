import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "e2e", ".build-manifest.json"), "utf8"));

function summarize(violations) {
  return JSON.stringify(
    violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help })),
    null,
    2
  );
}

for (const pageUrl of [manifest.demo, manifest.limiter]) {
  test(`no serious accessibility violations (${pageUrl.includes("limiter") ? "limiter" : "cart"})`, async ({ page }) => {
    await page.goto(pageUrl);
    // Scan an interactive state too: first flow node and first challenge expanded.
    await page.locator("ol.flow > li").first().locator("> details > summary").click();
    await page.locator("article.challenge").first().locator("details.hint > summary").first().click();
    const results = await new AxeBuilder({ page }).analyze();
    const serious = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(serious, summarize(serious)).toEqual([]);
  });
}
