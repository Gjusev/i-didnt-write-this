import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { createCart, addItem, recompute } from "../src/cart.js";
import { applyCoupon } from "../src/pricing.js";
import { serialize, reload } from "../src/store.js";

const fixtureRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function runCli(input) {
  const res = spawnSync(process.execPath, [path.join(fixtureRoot, "src", "index.js")], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 10000,
  });
  return { exitCode: res.status, stdout: JSON.parse(res.stdout), stderr: res.stderr };
}

test("percent coupon: 10% of 55 with cap 20 gives total 49.5", () => {
  const cart = createCart();
  addItem(cart, "keyboard", 30, 1);
  addItem(cart, "cable", 12.5, 2);
  const result = applyCoupon(cart, "TENPCT");
  assert.deepEqual(result, { ok: true, code: "TENPCT", discount: 5.5, total: 49.5 });
  assert.deepEqual(cart.totals, { subtotal: 55, discount: 5.5, total: 49.5 });
});

test("fixed coupon: SAVE5 subtracts 5", () => {
  const cart = createCart();
  addItem(cart, "mouse", 20, 1);
  const result = applyCoupon(cart, "SAVE5");
  assert.deepEqual(result, { ok: true, code: "SAVE5", discount: 5, total: 15 });
});

test("percent coupon is capped at 20", () => {
  const cart = createCart();
  addItem(cart, "monitor", 300, 1);
  const result = applyCoupon(cart, "TENPCT");
  assert.equal(result.discount, 20);
  assert.equal(result.total, 280);
});

test("discount never exceeds the subtotal", () => {
  const cart = createCart();
  addItem(cart, "sticker", 3, 1);
  const result = applyCoupon(cart, "SAVE5");
  assert.deepEqual(result, { ok: true, code: "SAVE5", discount: 3, total: 0 });
});

test("unknown coupon is rejected", () => {
  const cart = createCart();
  addItem(cart, "mouse", 20, 1);
  assert.deepEqual(applyCoupon(cart, "NOPE"), { ok: false, reason: "unknown coupon" });
});

test("recompute resets any discount", () => {
  const cart = createCart();
  addItem(cart, "mouse", 20, 1);
  applyCoupon(cart, "SAVE5");
  recompute(cart);
  assert.deepEqual(cart.totals, { subtotal: 20, discount: 0, total: 20 });
});

test("serialize persists only items and coupon code", () => {
  const cart = createCart();
  addItem(cart, "mouse", 20, 1);
  applyCoupon(cart, "SAVE5");
  const saved = serialize(cart);
  assert.deepEqual(saved, { items: [{ sku: "mouse", price: 20, qty: 1 }], coupon: "SAVE5" });
});

test("reload keeps the coupon label but loses the discount (known behavior)", () => {
  const cart = createCart();
  addItem(cart, "keyboard", 30, 1);
  addItem(cart, "cable", 12.5, 2);
  applyCoupon(cart, "TENPCT");
  const afterReload = reload(serialize(cart));
  assert.equal(afterReload.coupon, "TENPCT");
  assert.deepEqual(afterReload.totals, { subtotal: 55, discount: 0, total: 55 });
});

test("CLI checkout applies the coupon end to end", () => {
  const out = runCli({
    cmd: "checkout",
    items: [
      { sku: "keyboard", price: 30, qty: 1 },
      { sku: "cable", price: 12.5, qty: 2 },
    ],
    coupon: "TENPCT",
  });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout.totals, { subtotal: 55, discount: 5.5, total: 49.5 });
  assert.equal(out.stdout.saved.coupon, "TENPCT");
});

test("CLI reload loses the discount end to end", () => {
  const out = runCli({
    cmd: "reload",
    saved: {
      items: [
        { sku: "keyboard", price: 30, qty: 1 },
        { sku: "cable", price: 12.5, qty: 2 },
      ],
      coupon: "TENPCT",
    },
  });
  assert.equal(out.exitCode, 0);
  assert.equal(out.stdout.coupon, "TENPCT");
  assert.deepEqual(out.stdout.totals, { subtotal: 55, discount: 0, total: 55 });
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
