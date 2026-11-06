import { createServer } from "node:net";

/**
 * In CI the on-chain suites must run. A missing anvil or missing compiled contracts (a failed `forge build`)
 * would otherwise skip them and let the build go green without any on-chain coverage, so fail loudly instead.
 * Locally they may still skip.
 */
export function requireInCi(ready: boolean, what: string): void {
  if (process.env.CI && !ready) throw new Error(`${what} is required in CI; refusing to skip the on-chain suite`);
}

/** Fails with a clear message if something already listens on the fixed port (a stale anvil, another run). */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", () => reject(new Error(`port ${port} is already in use; stop the stale process (a leftover anvil?) and retry`)));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
  });
}

/** Waits for a JSON-RPC endpoint to answer eth_chainId; throws when it never does (never falls through silently). */
export async function waitForRpc(url: string, attempts = 150, delayMs = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}',
      });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`RPC at ${url} did not answer within ${(attempts * delayMs) / 1000}s`);
}
