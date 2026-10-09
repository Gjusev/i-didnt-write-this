import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveInside,
  extractSnippet,
  runCase,
  verifyLesson,
  validateLesson,
  buildHtml,
} from "../skills/i-didnt-write-this/assets/toolkit.mjs";
import { CART_REPO, loadDemoLesson } from "./helpers.mjs";

function tempRepo(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-edge-"));
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
  return tmp;
}

test("backslash separators in recorded paths verify on any OS", async () => {
  const info = resolveInside(CART_REPO, "src\\store.js");
  assert.equal(info.normalized, "src/store.js");
  const snippet = await extractSnippet(CART_REPO, "src\\store.js", 9, 9);
  assert.equal(snippet.path, "src/store.js");
  assert.ok(snippet.code.startsWith("export function reload"));
  // src/.. cancels to the repo root (still inside); only a real escape throws.
  assert.equal(resolveInside(CART_REPO, "src\\..\\store.js").normalized, "store.js");
  assert.throws(() => resolveInside(CART_REPO, "src\\..\\..\\secret.js"), /escapes the repository/);
});

test("snippet extraction is stable for files with a UTF-8 BOM", async () => {
  const tmp = tempRepo({ "bom.js": "\uFEFFexport const x = 1;\nexport const y = 2;\n" });
  try {
    const first = await extractSnippet(tmp, "bom.js", 1, 2);
    const second = await extractSnippet(tmp, "bom.js", 1, 2);
    assert.equal(first.code, second.code);
    assert.equal(first.fileHash, second.fileHash);
    assert.ok(first.code.includes("export const x"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("snippet extraction rejects empty files", async () => {
  const tmp = tempRepo({ "empty.js": "" });
  try {
    await assert.rejects(extractSnippet(tmp, "empty.js", 1, 1), /invalid range|goes past end/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("single-line ranges round-trip exactly", async () => {
  const snippet = await extractSnippet(CART_REPO, "src/store.js", 6, 6);
  assert.equal(snippet.code, "  return { items: cart.items, coupon: cart.coupon };");
});

test("entries and driver files with spaces and unicode in their names run", async () => {
  const tmp = tempRepo({
    "package.json": JSON.stringify({ type: "module" }),
    "entrée cara.cter.js": 'import { saludo } from "./módulo raro.js";\nprocess.stdout.write(saludo());\n',
    "módulo raro.js": 'export const saludo = () => "hola";\n',
  });
  try {
    const record = await runCase({ repoRoot: tmp, entry: "entrée cara.cter.js", input: null });
    assert.equal(record.exitCode, 0);
    assert.equal(record.stdout, "hola");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("driver files can live in nested directories that do not exist yet", async () => {
  const driver = 'import { reload } from "../../src/store.js";\nprocess.stdout.write(String(reload({ items: [] }).totals.total));\n';
  const record = await runCase({
    repoRoot: CART_REPO,
    entry: "probes/deep/driver.js",
    input: null,
    addFiles: { "probes/deep/driver.js": driver },
  });
  assert.equal(record.exitCode, 0);
  assert.equal(record.stdout, "0");
  assert.ok(record.addedFiles["probes/deep/driver.js"]);
});

test("CommonJS repositories execute .cjs entries", async () => {
  const tmp = tempRepo({
    "cli.cjs": 'process.stdout.write(JSON.stringify({ cwdOk: process.cwd().length > 0 }));\n',
  });
  try {
    const record = await runCase({ repoRoot: tmp, entry: "cli.cjs", input: null });
    assert.equal(record.exitCode, 0);
    assert.deepEqual(JSON.parse(record.stdout), { cwdOk: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("oversized program output degrades gracefully instead of crashing", async () => {
  const tmp = tempRepo({
    "package.json": JSON.stringify({ type: "module" }),
    "flood.js": "process.stdout.write('x'.repeat(20 * 1024 * 1024));\n",
  });
  try {
    const record = await runCase({ repoRoot: tmp, entry: "flood.js", input: null, timeoutMs: 30000 });
    assert.equal(record.timedOut, false);
    assert.ok(record.spawnError || record.stdout.length < 20 * 1024 * 1024, "output is capped or the overflow is recorded");
    assert.ok(typeof record.stdout === "string");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("verify refuses custom runners unless explicitly allowed", async () => {
  const lesson = loadDemoLesson();
  const evidence = lesson.evidence.find((e) => e.id === "e-checkout");
  // A real, working runner that is not the literal "node", quoted because the
  // binary path contains spaces (the supported form).
  evidence.runner = `"${process.execPath}"`;
  const refused = await verifyLesson(lesson, CART_REPO);
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join("\n"), /--allow-custom-runner/);

  const allowed = await verifyLesson(lesson, CART_REPO, { allowCustomRunner: true });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.errors));
});

test("quoted custom runner paths with spaces execute correctly", async () => {
  const record = await runCase({
    repoRoot: CART_REPO,
    entry: "src/index.js",
    input: { cmd: "reload", saved: { items: [], coupon: null } },
    runner: `"${process.execPath}"`,
  });
  assert.equal(record.exitCode, 0);
  assert.equal(record.runner, "node", "a quoted absolute node path normalizes back to \"node\"");
  assert.match(record.command, /^node src\/index\.js$/);
});

test("malformed addedFiles are rejected structurally", () => {
  const lesson = loadDemoLesson();
  lesson.evidence[0].addedFiles = { "C:/abs.js": "x" };
  assert.match(validateLesson(lesson).errors.join("\n"), /addedFiles\["C:\/abs\.js"\]/);

  const lesson2 = loadDemoLesson();
  lesson2.evidence[0].addedFiles = { ok: "" };
  assert.match(validateLesson(lesson2).errors.join("\n"), /non-empty driver content/);
});

test("a lesson with no limitations omits the section", async () => {
  const lesson = loadDemoLesson();
  lesson.limitations = [];
  const { html } = await buildHtml(lesson, CART_REPO);
  assert.ok(!html.includes('id="limits"'));
});

test("lesson ids, titles and prompts survive emoji and mixed scripts", async () => {
  const lesson = loadDemoLesson();
  lesson.title = "Descuento 🛒 — ¿dónde se pierde? 日本語 mixing スクリプト";
  lesson.challenges[0].prompt = "¿Qué imprime? → «totals.total» with «ñ»";
  const { html } = await buildHtml(lesson, CART_REPO);
  assert.ok(html.includes("Descuento 🛒 — ¿dónde se pierde? 日本語 mixing スクリプト"));
  assert.ok(html.includes("¿Qué imprime? → «totals.total» with «ñ»"));
});
