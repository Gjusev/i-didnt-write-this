import { createCart, addItem } from "./cart.js";
import { applyCoupon } from "./pricing.js";
import { serialize, reload } from "./store.js";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

const input = JSON.parse(await readStdin());

if (input.cmd === "checkout") {
  const cart = createCart();
  for (const item of input.items ?? []) {
    addItem(cart, item.sku, item.price, item.qty ?? 1);
  }
  const couponResult = input.coupon ? applyCoupon(cart, input.coupon) : null;
  emit({
    cmd: "checkout",
    coupon: cart.coupon,
    couponResult,
    totals: cart.totals,
    saved: serialize(cart),
  });
} else if (input.cmd === "reload") {
  const cart = reload(input.saved ?? {});
  emit({ cmd: "reload", coupon: cart.coupon, totals: cart.totals });
} else {
  process.stderr.write(`unknown cmd: ${input?.cmd}\n`);
  process.exit(2);
}
