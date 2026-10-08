import { round2 } from "./cart.js";

// Fixed catalog of coupon rules.
const COUPONS = {
  SAVE5: { kind: "fixed", value: 5 },
  TENPCT: { kind: "percent", value: 10, cap: 20 },
};

export function applyCoupon(cart, code) {
  const rule = COUPONS[code];
  if (!rule) {
    return { ok: false, reason: "unknown coupon" };
  }
  const subtotal = cart.totals.subtotal;
  let discount;
  if (rule.kind === "fixed") {
    discount = rule.value;
  } else {
    discount = Math.min(round2((subtotal * rule.value) / 100), rule.cap);
  }
  discount = round2(Math.min(discount, subtotal));
  cart.coupon = code;
  cart.totals.discount = discount;
  cart.totals.total = round2(subtotal - discount);
  return { ok: true, code, discount, total: cart.totals.total };
}
