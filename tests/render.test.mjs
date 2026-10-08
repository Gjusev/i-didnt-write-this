import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildHtml, extractSnippet } from "../skills/i-didnt-write-this/assets/toolkit.mjs";
import { loadDemoLesson, CART_REPO } from "./helpers.mjs";

test("buildHtml renders the demo lesson with all sections", async () => {
  const { html, warnings } = await buildHtml(loadDemoLesson(), CART_REPO);
  assert.deepEqual(warnings, []);
  assert.match(html, /Where did the coupon discount go\?/);
  assert.match(html, /How this feature works/);
  assert.match(html, /Solved 0\/3/);
  assert.match(html, /Limitations &amp; assumptions/);
  for (const id of ["c-predict-total", "c-trace-discount-zero", "c-locate-fault"]) {
    assert.ok(html.includes(`data-challenge-id="${id}"`), `missing challenge ${id}`);
  }
});

test("buildHtml output is deterministic", async () => {
  const first = await buildHtml(loadDemoLesson(), CART_REPO);
  const second = await buildHtml(loadDemoLesson(), CART_REPO);
  assert.equal(first.html, second.html);
});

test("buildHtml escapes hostile content instead of emitting raw HTML", async () => {
  // Build a repo whose source genuinely contains HTML-ish strings, so the
  // lesson stays valid while the renderer is fed hostile content.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-xss-"));
  try {
    fs.cpSync(CART_REPO, tmp, { recursive: true });
    const indexPath = path.join(tmp, "src", "index.js");
    const lines = fs.readFileSync(indexPath, "utf8").split(/\r?\n/);
    lines[21] = 'const hostile = "</script><script>alert(1)</script>";';
    fs.writeFileSync(indexPath, lines.join("\n"));

    const lesson = loadDemoLesson();
    const fresh = await extractSnippet(tmp, "src/index.js", 21, 33);
    lesson.sourceSnapshot.files["src/index.js"] = fresh.fileHash;
    lesson.snippets.find((s) => s.id === "s-checkout-branch").code = fresh.code;

    lesson.title = '<script>alert("xss")</script>';
    lesson.challenges[0].prompt = '<img src=x onerror="alert(2)">';
    lesson.challenges[0].hints = ["<script>alert(3)</script>"];
    lesson.limitations = ["<svg onload=alert(4)>"];
    const { html } = await buildHtml(lesson, tmp);

    // Only the two template scripts (lesson data + app) may appear.
    assert.equal((html.match(/<script/g) || []).length, 2);
    assert.ok(!html.includes("<script>alert"), "hostile script must not survive raw");
    assert.ok(!html.includes("<img src=x"), "hostile img must not survive raw");
    assert.ok(!html.includes("<svg onload"), "hostile svg must not survive raw");
    assert.ok(html.includes("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"), "title must be escaped");
    // The embedded JSON payload escapes < so it cannot close its own script tag.
    assert.ok(!html.includes("</script><script>alert"), "payload cannot break out of its script tag");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("challenges without verification render an explicit unverified note", async () => {
  const lesson = loadDemoLesson();
  for (const c of lesson.challenges) c.verifiedBy = [];
  const { html } = await buildHtml(lesson, CART_REPO);
  assert.match(html, /No execution evidence was recorded/);
  assert.doesNotMatch(html, /Verified against execution/);
});

test("verified challenges embed the recorded run output", async () => {
  const { html } = await buildHtml(loadDemoLesson(), CART_REPO);
  assert.match(html, /Verified against execution/);
  assert.ok(
    html.includes("&quot;total&quot;:49.5"),
    "recorded stdout with the correct answer is embedded (HTML-escaped)"
  );
});

test("ui string overrides reach the rendered page", async () => {
  const lesson = loadDemoLesson();
  lesson.ui = { solvedProgress: "Resueltas {n} de {total}", incorrect: "✗ Incorrecto." };
  const { html } = await buildHtml(lesson, CART_REPO);
  assert.match(html, /Resueltas 0 de 3/);
  assert.match(html, /✗ Incorrecto\./);
});

test("buildHtml refuses to render an invalid lesson", async () => {
  const lesson = loadDemoLesson();
  lesson.challenges[0].answer = "o-nope";
  await assert.rejects(buildHtml(lesson, CART_REPO), /failed validation[\s\S]*answer "o-nope"/);
});
