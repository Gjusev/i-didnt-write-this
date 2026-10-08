import { recompute } from "./cart.js";

// Only the items and the coupon code are persisted. Totals are never stored:
// they are recalculated on load.
export function serialize(cart) {
  return { items: cart.items, coupon: cart.coupon };
}

export function reload(saved) {
  const cart = {
    items: Array.isArray(saved.items) ? saved.items : [],
    coupon: saved.coupon ?? null,
    totals: { subtotal: 0, discount: 0, total: 0 },
  };
  recompute(cart);
  return cart;
}
