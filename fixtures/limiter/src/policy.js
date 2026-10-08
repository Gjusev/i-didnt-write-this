import { createBucket, tryTake } from "./bucket.js";

// Free tier: small burst, slow refill. Pro tier: bigger burst, fast refill.
const TIERS = {
  free: { capacity: 2, refillPerSecond: 10 },
  pro: { capacity: 10, refillPerSecond: 0.5 },
};

export function tierNames() {
  return Object.keys(TIERS);
}

export function bucketFor(tier) {
  const rule = TIERS[tier];
  if (!rule) throw new Error(`unknown tier: ${tier}`);
  return createBucket(rule.capacity, rule.refillPerSecond);
}

export function check(bucket, tier, nowMs, cost = 1) {
  if (!(tier in TIERS)) throw new Error(`unknown tier: ${tier}`);
  return tryTake(bucket, nowMs, cost);
}
