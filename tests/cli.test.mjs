import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { TOOLKIT, CART_REPO, DEMO_LESSON_PATH, LIMITER_LESSON_PATH, repoRoot, loadDemoLesson, hashTree } from "./helpers.mjs";

function runToolkit(...args) {
  const res = spawnSync(process.execPath, [TOOLKIT, ...args], { encoding: "utf8", timeout: 60000 });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json: safeJson(res.stdout) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

test("CLI check accepts the shipped demo lesson", () => {
  const res = runToolkit("check", DEMO_LESSON_PATH, "--repo", CART_REPO);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.ok, true);
});

test("CLI verify re-runs the demo evidence and matches", () => {
  const before = hashTree(CART_REPO);
  const res = runToolkit("verify", DEMO_LESSON_PATH, "--repo", CART_REPO);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.reran, 2);
  assert.deepEqual(hashTree(CART_REPO), before, "verify must not modify the fixture");
});

test("CLI build writes a standalone HTML file deterministically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-build-"));
  try {
    const first = path.join(dir, "a.html");
    const second = path.join(dir, "b.html");
    for (const out of [first, second]) {
      const res = runToolkit("build", DEMO_LESSON_PATH, "--repo", CART_REPO, "--output", out);
      assert.equal(res.status, 0, res.stderr);
    }
    assert.equal(fs.readFileSync(first, "utf8"), fs.readFileSync(second, "utf8"), "two builds must be byte-for-byte identical");
    assert.ok(fs.statSync(first).size > 10_000, "a real page was produced");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a lesson whose evidence no longer reproduces", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-drift-"));
  try {
    fs.cpSync(CART_REPO, tmp, { recursive: true });
    const target = path.join(tmp, "src", "pricing.js");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("cap: 20", "cap: 1"));

    const check = runToolkit("check", DEMO_LESSON_PATH, "--repo", tmp);
    assert.equal(check.status, 0, "stale hashes warn but do not fail check");
    assert.equal(check.json.fileStatus["src/pricing.js"], "stale");

    const verify = runToolkit("verify", DEMO_LESSON_PATH, "--repo", tmp);
    assert.equal(verify.status, 1, "behavior changed, so evidence no longer reproduces");
    assert.match(verify.json.errors.join("\n"), /stdout changed/);

    const out = path.join(tmp, "lesson.html");
    const build = runToolkit("build", DEMO_LESSON_PATH, "--repo", tmp, "--output", out);
    assert.equal(build.status, 0, "stale warnings do not block building");
    const html = fs.readFileSync(out, "utf8");
    assert.match(html, /file changed after the lesson was generated/);
    assert.match(html, /⚠ Warnings/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI build fails on structural errors and reports them", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-bad-"));
  try {
    const lesson = loadDemoLesson();
    lesson.challenges[0].answer = "o-nope";
    const badPath = path.join(tmp, "lesson.json");
    fs.writeFileSync(badPath, JSON.stringify(lesson));
    const res = runToolkit("build", badPath, "--repo", CART_REPO, "--output", path.join(tmp, "out.html"));
    assert.equal(res.status, 1);
    assert.match(res.stderr, /failed validation/);
    assert.equal(fs.existsSync(path.join(tmp, "out.html")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI check fails on invalid JSON lessons", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idwt-json-"));
  try {
    const bad = path.join(tmp, "lesson.json");
    fs.writeFileSync(bad, "{ not json");
    const res = runToolkit("check", bad, "--repo", CART_REPO);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not valid JSON/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI prints usage for unknown commands", () => {
  const res = runToolkit("frobnicate");
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Usage:/);
});

test("every reference lesson verifies and builds against its fixture", () => {
  const references = [
    { name: "cart", lesson: DEMO_LESSON_PATH, repo: CART_REPO },
    { name: "limiter", lesson: LIMITER_LESSON_PATH, repo: path.join(repoRoot, "fixtures", "limiter") },
  ];
  for (const { name, lesson, repo } of references) {
    const verify = runToolkit("verify", lesson, "--repo", repo);
    assert.equal(verify.status, 0, `${name}: ${verify.stderr}${verify.stdout}`);
    assert.ok(verify.json.reran >= 1, `${name}: evidence was re-run`);

    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "idwt-exbuild-")), "lesson.html");
    try {
      const build = runToolkit("build", lesson, "--repo", repo, "--output", out);
      assert.equal(build.status, 0, `${name}: ${build.stderr}`);
      assert.ok(fs.statSync(out).size > 10_000, `${name}: a real page was produced`);
    } finally {
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
    }
  }
});
