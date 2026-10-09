import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "e2e", ".build-manifest.json"), "utf8"));

const challenges = manifest.answers;

function challengeLocator(page, id) {
  return page.locator(`#challenge-${id}`);
}

test.beforeEach(async ({ page }) => {
  // Any dialog (alert/confirm/prompt) means hostile content executed: fail.
  page.on("dialog", (dialog) => {
    throw new Error(`unexpected dialog (${dialog.type()}): ${dialog.message()}`);
  });
});

test("renders the full lesson structure", async ({ page }) => {
  await page.goto(manifest.demo);
  await expect(page).toHaveTitle(/Where did the coupon discount go\?/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/coupon discount/);
  await expect(page.locator("ol.flow > li.node")).toHaveCount(5);
  await expect(page.locator("article.challenge")).toHaveCount(3);
  await expect(page.locator("#progress")).toHaveText("Solved 0/3");
  await expect(page.getByRole("heading", { name: "Limitations & assumptions" })).toBeVisible();
});

test("completes all three challenges with correct answers", async ({ page }) => {
  await page.goto(manifest.demo);
  for (const { id, answer } of challenges) {
    const box = challengeLocator(page, id);
    await box.locator(`input[type=radio][value="${answer}"]`).check();
    await box.getByRole("button", { name: "Check answer" }).click();
    await expect(box.locator(".feedback")).toContainText("✓ Correct");
    await expect(box.getByRole("button", { name: "Check answer" })).toBeDisabled();
  }
  await expect(page.locator("#progress")).toHaveText("Solved 3/3");
});

test("rejects a wrong answer, then accepts the right one", async ({ page }) => {
  await page.goto(manifest.demo);
  const box = challengeLocator(page, challenges[0].id);
  const values = await box.locator("input[type=radio]").evaluateAll((inputs) =>
    inputs.map((input) => input.value)
  );
  const wrongValue = values.find((v) => v !== challenges[0].answer);
  await box.locator(`input[type=radio][value="${wrongValue}"]`).check();
  await box.getByRole("button", { name: "Check answer" }).click();
  await expect(box.locator(".feedback")).toContainText("✗ Not correct");
  await expect(page.locator("#progress")).toHaveText("Solved 0/3");

  await box.locator(`input[type=radio][value="${challenges[0].answer}"]`).check();
  await box.getByRole("button", { name: "Check answer" }).click();
  await expect(box.locator(".feedback")).toContainText("✓ Correct");
  await expect(page.locator("#progress")).toHaveText("Solved 1/3");
});

test("asks for an answer when nothing is selected", async ({ page }) => {
  await page.goto(manifest.demo);
  const box = challengeLocator(page, challenges[0].id);
  await box.getByRole("button", { name: "Check answer" }).click();
  await expect(box.locator(".feedback")).toContainText("Select an answer first");
});

test("hints open progressively with content", async ({ page }) => {
  await page.goto(manifest.demo);
  const box = challengeLocator(page, challenges[1].id);
  const hints = box.locator("details.hint");
  await expect(hints).toHaveCount(2);
  for (let i = 0; i < await hints.count(); i++) {
    await hints.nth(i).locator("summary").click();
    await expect(hints.nth(i).locator("p")).not.toBeEmpty();
  }
});

test("flow nodes expose their code and recorded evidence", async ({ page }) => {
  await page.goto(manifest.demo);
  const node = page.locator("#node-n-reload > details").first();
  await node.locator("> summary").click();
  await expect(node.locator("pre.code code")).toContainText("recompute(cart)");
  const evidence = node.locator("details.evidence");
  await evidence.locator("> summary").click();
  await expect(evidence.locator("pre.io").last()).toContainText('"discount":0');
});

test("verified challenges show the recorded run output", async ({ page }) => {
  await page.goto(manifest.demo);
  const aside = challengeLocator(page, challenges[0].id).locator("aside.verification.verified");
  await expect(aside).toContainText("✓ Verified against execution");
  await aside.locator("summary").click();
  await expect(aside.locator("pre.io").first()).toContainText('"total":49.5');
});

test("keyboard: arrows change the selection and Enter submits", async ({ page }) => {
  await page.goto(manifest.demo);
  const box = challengeLocator(page, challenges[0].id);
  const radios = box.locator("input[type=radio]");
  await radios.first().focus();
  // ArrowDown moves to the next radio in the group.
  const before = await radios.first().isChecked();
  await page.keyboard.press("ArrowDown");
  const afterArrow = await page.locator("input[type=radio]:focus").isChecked();
  expect(afterArrow).not.toBe(before);
  // Tab to the submit button and press Enter.
  await box.getByRole("button", { name: "Check answer" }).focus();
  await page.keyboard.press("Enter");
  await expect(box.locator(".feedback")).not.toBeEmpty();
});

test("keyboard: Tab reaches the skip link first and reveals it", async ({ page }) => {
  await page.goto(manifest.demo);
  await page.locator("body").focus();
  await page.keyboard.press("Tab");
  const active = page.locator(".skip:focus");
  await expect(active).toHaveText("Skip to challenges");
  const box = await active.boundingBox();
  expect(box.x).toBeGreaterThan(-100);
  await page.keyboard.press("Enter");
  await expect(page.locator("#challenges")).toBeInViewport();
});

test("interactive elements have a visible focus style declared", async ({ page }) => {
  await page.goto(manifest.demo);
  const hasFocusRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.selectorText && rule.selectorText.includes(":focus-visible") && /outline/.test(rule.cssText)) {
          return true;
        }
      }
    }
    return false;
  });
  expect(hasFocusRule).toBe(true);
});

test("unverified lessons say so explicitly", async ({ page }) => {
  await page.goto(manifest.unverified);
  await expect(page.locator("aside.verification.unverified")).toHaveCount(3);
  await expect(page.locator("aside.verification.unverified").first()).toContainText(
    "No execution evidence was recorded"
  );
  await expect(page.locator("aside.verification.verified")).toHaveCount(0);
});

test("hostile content is escaped, never executed", async ({ page }) => {
  await page.goto(manifest.hostile);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText('<script>alert("title")</script>');
  // Exactly the two template scripts exist: lesson data + viewer logic.
  expect(await page.locator("script").count()).toBe(2);
  await expect(page.locator("img")).toHaveCount(0);
  await expect(page.locator("svg")).toHaveCount(0);
});

test("stale references produce a visible warning banner", async ({ page }) => {
  await page.goto(manifest.stale);
  await expect(page.locator(".banner h2")).toContainText("⚠ Warnings");
  await expect(page.locator(".banner ul")).toContainText("file changed after the lesson was generated");
  const node = page.locator("#node-n-reload > details").first();
  await node.locator("> summary").click();
  await expect(node.locator(".stale-flag").first()).toContainText("file changed since the lesson was generated");
});

test("loads with zero non-file requests", async ({ page }) => {
  const urls = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.goto(manifest.demo);
  await page.locator("article.challenge").first().waitFor();
  const external = urls.filter((u) => !u.startsWith("file:"));
  expect(external).toEqual([]);
});

test("narrow viewports do not overflow the document", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(manifest.demo);
  const overflow = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(overflow.docScroll).toBeLessThanOrEqual(overflow.viewport + 1);
});
