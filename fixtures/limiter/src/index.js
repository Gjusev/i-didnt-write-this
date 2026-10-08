import { bucketFor, check } from "./policy.js";

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

if (input.cmd === "burst") {
  const bucket = bucketFor(input.tier);
  const requests = (input.atMs ?? []).map((atMs) => ({
    atMs,
    ...check(bucket, input.tier, atMs, input.cost ?? 1),
  }));
  emit({ cmd: "burst", tier: input.tier, capacity: bucket.capacity, refillPerSecond: bucket.refillPerSecond, requests });
} else if (input.cmd === "tiers") {
  emit({ cmd: "tiers", tiers: ["free", "pro"] });
} else {
  process.stderr.write(`unknown cmd: ${input?.cmd}\n`);
  process.exit(2);
}
