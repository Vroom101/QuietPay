/**
 * Load measurement of the real relayer on local anvil (not the testnet). Reports requests per second and latency
 * percentiles for: health, order read, order creation (shows the per-IP limiter), and end-to-end payment throughput.
 *   node --import tsx src/load.ts
 */
import { startLocalStack } from "./stack.js";
import { newOrder, signPay, relayPay, waitStatus } from "./actions.js";
import type { Hex } from "viem";

const pct = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;

async function hammer(name: string, concurrency: number, ms: number, fn: () => Promise<number>) {
  const lat: number[] = []; const codes = new Map<number, number>();
  const end = Date.now() + ms;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < end) {
      const s = performance.now();
      let code = 0;
      try { code = await fn(); } catch { code = -1; }
      lat.push(performance.now() - s);
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }));
  const secs = (Date.now() - t0) / 1000;
  console.log(`${name.padEnd(28)} conc=${String(concurrency).padStart(3)} ${(lat.length / secs).toFixed(0).padStart(6)} req/s  p50=${pct(lat, 50).toFixed(0)}ms p95=${pct(lat, 95).toFixed(0)}ms p99=${pct(lat, 99).toFixed(0)}ms  status=${JSON.stringify(Object.fromEntries(codes))}`);
}

const s = await startLocalStack({ basePort: Number(process.env.E2E_PORT_BASE ?? 8860) });
try {
  const base = s.relayerUrl;
  const order = await newOrder(s, 1_000_000n);
  await hammer("GET /v1/health", 50, 4000, async () => (await fetch(`${base}/v1/health`)).status);
  await hammer("GET /v1/orders/:id", 50, 4000, async () => (await fetch(`${base}/v1/orders/${order.id}`)).status);
  await hammer("POST /v1/orders (1 IP)", 20, 4000, async () => {
    try { await newOrder(s, 1_000_000n); return 201; } catch (e) { return (e as { status?: number }).status ?? 0; }
  });

  if (process.env.LOAD_SKIP_PAY) { await s.stop(); process.exit(0); }
  console.log('(waiting 65 s for the per-IP order limiter window to reset)');
  await new Promise((r) => setTimeout(r, 65_000));
  // End-to-end payments: N distinct payers pay N distinct orders concurrently; time until every order is settled.
  for (const n of [5, 20, 50]) {
    if (n === 50) await new Promise((r) => setTimeout(r, 65_000));
    const payers: Awaited<ReturnType<typeof s.newPayer>>[] = [];
    for (let i = 0; i < n; i++) payers.push(await s.newPayer(50_000_000n));
    const orders = [];
    for (let i = 0; i < n; i++) { try { orders.push(await newOrder(s, 1_000_000n)); } catch { break; } }
    const sigs = await Promise.all(orders.map((o, i) => signPay(o, payers[i]!.key)));
    const t0 = performance.now();
    const res = await Promise.all(sigs.map((g) => relayPay(s, g)));
    const accepted = res.filter((r) => r.status === 200).length;
    await Promise.all(orders.map((o, i) => (res[i]!.status === 200 ? waitStatus(s, o.id as Hex, ["settled"], 120_000) : Promise.resolve(null))));
    const secs = (performance.now() - t0) / 1000;
    const codes = res.reduce<Record<number, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    console.log(`payments n=${String(n).padStart(2)}: orders created=${orders.length}, accepted=${accepted}, all settled in ${secs.toFixed(1)}s => ${(accepted / secs).toFixed(1)} payments/s  status=${JSON.stringify(codes)}`);
  }
} finally {
  await s.stop();
}
process.exit(0);
