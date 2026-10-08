import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createBucket, refill, tryTake } from "../src/bucket.js";
import { bucketFor, check, tierNames } from "../src/policy.js";

const fixtureRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(input) {
  const res = spawnSync(process.execPath, [path.join(fixtureRoot, "src", "index.js")], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10000,
  });
  return { exitCode: res.status, stdout: JSON.parse(res.stdout), stderr: res.stderr };
}

test("a fresh bucket allows up to capacity requests, then rejects", () => {
  const bucket = createBucket(2, 1);
  assert.deepEqual(tryTake(bucket, 0), { allowed: true, tokensLeft: 1 });
  assert.deepEqual(tryTake(bucket, 0), { allowed: true, tokensLeft: 0 });
  assert.deepEqual(tryTake(bucket, 0), { allowed: false, tokensLeft: 0 });
});

test("refill adds tokens at the configured rate", () => {
  const bucket = createBucket(10, 0.5);
  bucket.tokens = 0;
  bucket.updatedAtMs = 0;
  refill(bucket, 2000);
  assert.equal(bucket.tokens, 1);
});

test("idle time beyond full is discarded (cap at capacity)", () => {
  const bucket = createBucket(3, 100);
  refill(bucket, 60000);
  assert.equal(bucket.tokens, 3);
});

test("time cannot flow backwards: negative elapsed adds nothing", () => {
  const bucket = createBucket(5, 10);
  bucket.tokens = 1;
  bucket.updatedAtMs = 5000;
  refill(bucket, 1000);
  assert.equal(bucket.tokens, 1);
});

test("fractional tokens are reported rounded to 3 decimals", () => {
  const bucket = createBucket(2, 0.5);
  tryTake(bucket, 0);
  tryTake(bucket, 0);
  const result = tryTake(bucket, 1000); // +0.5 tokens
  assert.deepEqual(result, { allowed: false, tokensLeft: 0.5 });
});

test("the free tier refills at 10 tokens/second (observed, matches the table)", () => {
  const free = bucketFor("free");
  assert.equal(free.capacity, 2);
  assert.equal(free.refillPerSecond, 10);
});

test("the pro tier refills at 0.5 tokens/second (observed, matches the table)", () => {
  const pro = bucketFor("pro");
  assert.equal(pro.capacity, 10);
  assert.equal(pro.refillPerSecond, 0.5);
});

test("unknown tiers throw", () => {
  assert.throws(() => bucketFor("enterprise"), /unknown tier/);
  assert.throws(() => check(createBucket(1, 1), "enterprise", 0), /unknown tier/);
});

test("tierNames lists both tiers", () => {
  assert.deepEqual(tierNames(), ["free", "pro"]);
});

test("CLI burst drains the free tier then recovers after 100 ms", () => {
  const out = runCli({ cmd: "burst", tier: "free", atMs: [0, 0, 0, 100] });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout.capacity, 2);
  assert.deepEqual(
    out.stdout.requests.map((r) => r.allowed),
    [true, true, false, true]
  );
});

test("CLI tiers command lists tiers", () => {
  const out = runCli({ cmd: "tiers" });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout.tiers, ["free", "pro"]);
});

test("CLI rejects unknown commands with exit code 2", () => {
  const res = spawnSync(process.execPath, [path.join(fixtureRoot, "src", "index.js")], {
    input: JSON.stringify({ cmd: "nope" }),
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown cmd/);
});
