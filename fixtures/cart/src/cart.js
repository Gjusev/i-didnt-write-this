// Cart state and totals. Totals are always recalculated from the items list.

export function createCart() {
  return { items: [], coupon: null, totals: { subtotal: 0, discount: 0, total: 0 } };
}

export function addItem(cart, sku, price, qty = 1) {
  cart.items.push({ sku, price, qty });
  recompute(cart);
  return cart;
}

// recompute recalculates every total from the items list.
// Any coupon discount is reset here on purpose: callers re-apply coupons
// after changing items.
export function recompute(cart) {
  const subtotal = cart.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  cart.totals.subtotal = round2(subtotal);
  cart.totals.discount = 0;
  cart.totals.total = round2(subtotal);
}

export function round2(value) {
  return Math.round(value * 100) / 100;
}
