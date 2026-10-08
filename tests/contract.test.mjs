import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { validateLesson, checkLesson, extractSnippet } from "../skills/i-didnt-write-this/assets/toolkit.mjs";
import { loadDemoLesson, CART_REPO } from "./helpers.mjs";

test("the shipped demo lesson passes structural validation", () => {
  const report = validateLesson(loadDemoLesson());
  assert.deepEqual(report.errors, []);
});

test("wrong schemaVersion is rejected", () => {
  const lesson = loadDemoLesson();
  lesson.schemaVersion = 99;
  assert.match(validateLesson(lesson).errors.join("\n"), /schemaVersion/);
});

test("an answer outside the option ids is rejected", () => {
  const lesson = loadDemoLesson();
  lesson.challenges[0].answer = "o-nope";
  assert.match(validateLesson(lesson).errors.join("\n"), /answer "o-nope" is not one of the option ids/);
});

test("verification cannot cite a failed execution", () => {
  const lesson = loadDemoLesson();
  const evidence = lesson.evidence.find((e) => e.id === "e-checkout");
  evidence.exitCode = 1;
  assert.match(validateLesson(lesson).errors.join("\n"), /did not succeed/);
});

test("verification cannot cite a timed-out execution", () => {
  const lesson = loadDemoLesson();
  lesson.evidence.find((e) => e.id === "e-checkout").timedOut = true;
  assert.match(validateLesson(lesson).errors.join("\n"), /did not succeed/);
});

test("a node claiming observed needs successful execution evidence", () => {
  const lesson = loadDemoLesson();
  lesson.flow.nodes[0].evidenceIds = [];
  assert.match(validateLesson(lesson).errors.join("\n"), /claims state "observed"/);
});

test("an inferred node with successful execution evidence only warns", () => {
  const lesson = loadDemoLesson();
  lesson.flow.nodes[0].state = "inferred";
  const report = validateLesson(lesson);
  assert.equal(report.errors.length, 0);
  assert.match(report.warnings.join("\n"), /consider marking it "observed"/);
});

test("snippets with paths escaping the repository are rejected", () => {
  const lesson = loadDemoLesson();
  lesson.snippets[0].path = "../outside.js";
  assert.match(validateLesson(lesson).errors.join("\n"), /must be a repo-relative path/);
});

test("absolute snippet paths are rejected", () => {
  const lesson = loadDemoLesson();
  lesson.snippets[0].path = "C:/evil/x.js";
  assert.match(validateLesson(lesson).errors.join("\n"), /must be a repo-relative path/);
});

test("snippet code that does not match its declared range is rejected", () => {
  const lesson = loadDemoLesson();
  lesson.snippets[0].code = "one line only";
  assert.match(validateLesson(lesson).errors.join("\n"), /declares/);
});

test("a snippet for a file missing from the snapshot is rejected", () => {
  const lesson = loadDemoLesson();
  delete lesson.sourceSnapshot.files[lesson.snippets[0].path];
  assert.match(validateLesson(lesson).errors.join("\n"), /missing from sourceSnapshot/);
});

test("missing challenge kinds only warn", () => {
  const lesson = loadDemoLesson();
  lesson.challenges = lesson.challenges.slice(0, 1);
  const report = validateLesson(lesson);
  assert.equal(report.errors.length, 0);
  assert.equal(report.warnings.filter((w) => w.includes('no "trace" challenge')).length, 1);
});

test("more than three hints is an error", () => {
  const lesson = loadDemoLesson();
  lesson.challenges[0].hints = ["a", "b", "c", "d"];
  assert.match(validateLesson(lesson).errors.join("\n"), /at most 3 hints/);
});

// ---------------------------------------------------------------------------
// Freshness (checkLesson with a real repo)
// ---------------------------------------------------------------------------

test("checkLesson reports ok for the current fixture", async () => {
  const report = await checkLesson(loadDemoLesson(), CART_REPO);
  assert.equal(report.ok, true);
  assert.deepEqual(report.staleFiles, []);
});

test("checkLesson detects a modified file as stale (warning, not error)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-stale-"));
  try {
    fs.cpSync(CART_REPO, tmp, { recursive: true });
    const target = path.join(tmp, "src", "store.js");
    fs.appendFileSync(target, "\n// edited after the lesson was generated\n");
    const report = await checkLesson(loadDemoLesson(), tmp);
    assert.equal(report.ok, true, "stale files are warnings, not errors");
    assert.equal(report.fileStatus["src/store.js"], "stale");
    assert.match(report.warnings.join("\n"), /file changed after the lesson was generated/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkLesson detects a deleted file as an error", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-missing-"));
  try {
    fs.cpSync(CART_REPO, tmp, { recursive: true });
    fs.rmSync(path.join(tmp, "src", "store.js"));
    const report = await checkLesson(loadDemoLesson(), tmp);
    assert.equal(report.ok, false);
    assert.match(report.errors.join("\n"), /no longer exists/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkLesson detects a tampered snippet against an unchanged file", async () => {
  const lesson = loadDemoLesson();
  lesson.snippets.find((s) => s.id === "s-reload").code = lesson.snippets
    .find((s) => s.id === "s-reload")
    .code.replace("recompute", "REDACTED");
  const report = await checkLesson(lesson, CART_REPO);
  assert.equal(report.ok, false);
  assert.match(report.errors.join("\n"), /does not match src\/store\.js/);
});

test("extractSnippet rejects ranges past end of file", async () => {
  await assert.rejects(
    extractSnippet(CART_REPO, "src/store.js", 1, 9999),
    /goes past end of src\/store\.js/
  );
});

test("extractSnippet rejects start 0 and reversed ranges", async () => {
  await assert.rejects(extractSnippet(CART_REPO, "src/store.js", 0, 3), /invalid range/);
  await assert.rejects(extractSnippet(CART_REPO, "src/store.js", 5, 2), /invalid range/);
});

test("extractSnippet rejects paths outside the repository", async () => {
  await assert.rejects(extractSnippet(CART_REPO, "../outside.js", 1, 2), /escapes the repository/);
  await assert.rejects(extractSnippet(CART_REPO, "C:/Windows/system32/config.sys", 1, 2), /must be relative/);
});

test("extractSnippet reads exact lines without the trailing newline", async () => {
  const snippet = await extractSnippet(CART_REPO, "src/store.js", 5, 7);
  assert.equal(
    snippet.code,
    'export function serialize(cart) {\n  return { items: cart.items, coupon: cart.coupon };\n}'
  );
});
