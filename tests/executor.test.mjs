import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCase, extractSnippet, verifyLesson } from "../skills/i-didnt-write-this/assets/toolkit.mjs";
import { CART_REPO, hashTree } from "./helpers.mjs";

const CHECKOUT_INPUT = {
  cmd: "checkout",
  items: [
    { sku: "keyboard", price: 30, qty: 1 },
    { sku: "cable", price: 12.5, qty: 2 },
  ],
  coupon: "TENPCT",
};

test("runCase executes a checkout and records a successful execution", async () => {
  const record = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: CHECKOUT_INPUT });
  assert.equal(record.kind, "execution");
  assert.equal(record.exitCode, 0);
  assert.equal(record.timedOut, false);
  assert.equal(record.runner, "node");
  assert.match(record.command, /^node src\/index\.js$/);
  const out = JSON.parse(record.stdout);
  assert.deepEqual(out.totals, { subtotal: 55, discount: 5.5, total: 49.5 });
  assert.equal(out.saved.coupon, "TENPCT");
  assert.equal(record.stderr, "");
});

test("runCase object input and equivalent string input produce identical stdout", async () => {
  const a = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: CHECKOUT_INPUT });
  const b = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: JSON.stringify(CHECKOUT_INPUT) });
  assert.equal(a.stdout, b.stdout);
});

test("runCase records a failing command with its exit code and stderr", async () => {
  const record = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: { cmd: "nope" } });
  assert.equal(record.exitCode, 2);
  assert.match(record.stderr, /unknown cmd/);
});

test("runCase kills entries that exceed the timeout", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-loop-"));
  try {
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ type: "module" }));
    fs.writeFileSync(path.join(tmp, "loop.js"), "process.stdout.write('started\\n');\nfor (;;) {}\n");
    const record = await runCase({ repoRoot: tmp, entry: "loop.js", input: null, timeoutMs: 700 });
    assert.equal(record.timedOut, true);
    assert.equal(record.exitCode, null);
    assert.equal(record.stdout, "started\n");
    assert.ok(record.durationMs < 5000, `duration ${record.durationMs}ms should stay near the timeout`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runCase reports a missing runner without crashing", async () => {
  const record = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: null, runner: "definitely-not-a-real-runner" });
  assert.equal(record.exitCode, null);
  assert.ok(record.spawnError, "records the spawn error");
});

test("runCase rejects entries outside the repository", async () => {
  await assert.rejects(
    runCase({ repoRoot: CART_REPO, entry: "../evil.js", input: null }),
    /escapes the repository/
  );
  await assert.rejects(
    runCase({ repoRoot: CART_REPO, entry: "src/missing.js", input: null }),
    /entry not found/
  );
});

test("runCase leaves the original repository untouched", async () => {
  const before = hashTree(CART_REPO);
  await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: { cmd: "checkout", items: [], coupon: "SAVE5" } });
  await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: { cmd: "nope" } });
  assert.deepEqual(hashTree(CART_REPO), before);
});

test("runCase cleans up its temporary copy", async () => {
  const record = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: null, keepWorkDir: true });
  assert.ok(record.workDir, "exposes the work dir when asked to keep it");
  assert.ok(fs.existsSync(record.workDir), "the isolated copy exists");
  fs.rmSync(record.workDir, { recursive: true, force: true });
  assert.equal(fs.existsSync(record.workDir), false);
});

test("runCase copies the repository but skips excluded top-level directories", async () => {
  const record = await runCase({ repoRoot: CART_REPO, entry: "src/index.js", input: null, keepWorkDir: true });
  try {
    assert.ok(fs.existsSync(path.join(record.workDir, "src", "index.js")));
    const snippet = await extractSnippet(record.workDir, "src/index.js", 1, 1);
    assert.ok(snippet.code.length > 0);
  } finally {
    fs.rmSync(record.workDir, { recursive: true, force: true });
  }
});

test("runCase injects driver files and records them verbatim", async () => {
  const driver = [
    'import { reload } from "./src/store.js";',
    "const cart = reload({ items: [{ sku: 'keyboard', price: 30, qty: 1 }], coupon: 'TENPCT' });",
    "process.stdout.write(JSON.stringify({ discount: cart.totals.discount }));",
    "",
  ].join("\n");
  const record = await runCase({
    repoRoot: CART_REPO,
    entry: "__driver.js",
    input: null,
    addFiles: { "__driver.js": driver },
  });
  assert.equal(record.exitCode, 0);
  assert.deepEqual(JSON.parse(record.stdout), { discount: 0 });
  assert.deepEqual(record.addedFiles, { "__driver.js": driver });
});

test("driver files may not shadow existing repository files", async () => {
  await assert.rejects(
    runCase({
      repoRoot: CART_REPO,
      entry: "src/index.js",
      input: null,
      addFiles: { "src/store.js": "export function reload() { return { fake: true }; }" },
    }),
    /must not shadow real files/
  );
});

test("verify replays evidence with driver files byte for byte", async () => {
  const record = await runCase({
    repoRoot: CART_REPO,
    entry: "__probe.js",
    input: null,
    addFiles: {
      "__probe.js": [
        'import { applyCoupon } from "./src/pricing.js";',
        "const cart = { items: [], coupon: null, totals: { subtotal: 55, discount: 0, total: 0 } };",
        "const r = applyCoupon(cart, 'TENPCT');",
        "process.stdout.write(JSON.stringify(r));",
        "",
      ].join("\n"),
    },
  });
  assert.equal(record.exitCode, 0);
  const lesson = {
    schemaVersion: 1,
    id: "driver-evidence-check",
    title: "t",
    objective: "o",
    language: "en",
    feature: "f",
    sourceSnapshot: { revision: null, files: { "src/index.js": record.entryFileHash } },
    snippets: [],
    flow: {
      nodes: [{ id: "n1", label: "coupon math", snippetId: undefined, state: "inferred", evidenceIds: [] }],
      links: [],
    },
    challenges: [
      { id: "c1", kind: "predict", prompt: "p", options: [{ id: "a", text: "1" }, { id: "b", text: "2" }], answer: "a", hints: [], explanation: "e" },
    ],
    evidence: [Object.assign({ id: "e-driver" }, record)],
    limitations: [],
  };
  const report = await verifyLesson(lesson, CART_REPO);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.reran, 1);
});
