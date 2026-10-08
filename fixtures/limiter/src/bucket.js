// Token bucket core. All functions are pure given (bucket, nowMs).

export function createBucket(capacity, refillPerSecond) {
  return { capacity, refillPerSecond, tokens: capacity, updatedAtMs: 0 };
}

export function refill(bucket, nowMs) {
  const elapsedMs = Math.max(0, nowMs - bucket.updatedAtMs);
  const gained = (elapsedMs / 1000) * bucket.refillPerSecond;
  // Idle time beyond full is discarded: tokens never exceed capacity.
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + gained);
  bucket.updatedAtMs = Math.max(bucket.updatedAtMs, nowMs);
  return bucket;
}

export function tryTake(bucket, nowMs, cost = 1) {
  refill(bucket, nowMs);
  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return { allowed: true, tokensLeft: round3(bucket.tokens) };
  }
  return { allowed: false, tokensLeft: round3(bucket.tokens) };
}

export function round3(value) {
  return Math.round(value * 1000) / 1000;
}
