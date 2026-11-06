import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { buildPaidApi } from "../../../apps/paid-api/src/app.js";
import { chainReady, deployWorld, startAnvil, type World } from "./build-anvil-kit.js";

// W6 interop probe. The official x402 client packages are NOT repo dependencies. Set X402_CLIENT_DIR to a throwaway
// folder holding client.mjs plus `npm i @x402/fetch @x402/evm @x402/core viem`; otherwise this file is skipped.
// It runs the unmodified official client against our paid API + facilitator on anvil and reports what happened.
const dir = process.env.X402_CLIENT_DIR;
describe.skipIf(!chainReady || !dir || !existsSync(dir + "/client.mjs"))("official x402 client against QuietPay (anvil)", () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let w: World;
  beforeAll(async () => {
    anvil = await startAnvil(1874);
    w = await deployWorld(anvil.rpc, anvil.call, false, 1874);
  }, 120000);
  afterAll(() => anvil?.stop());
  it("records the outcome of the unmodified official client", async () => {
    const s = w.makeServices({ apiKeys: new Map([["test-key", w.merchant]]) }, { waitMs: 3000 });
    const fac = buildServer(s.svc);
    await registerFacilitator(fac, s.facilitator);
    const facilitatorUrl = await fac.listen({ host: "127.0.0.1", port: 0 });
    const handler = vi.fn(() => ({ protected: "paid-data" }));
    const api = buildPaidApi({ policies: s.policies, facilitatorUrl, apiKey: "test-key", handlers: { "/v1/quote": handler } });
    const apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
    try {
      const key = generatePrivateKey();
      await w.mint(privateKeyToAccount(key).address, 50_000_000n);
      // async spawn: the servers live in this process, a blocking spawn would deadlock them
      const r = await new Promise<{ stdout: string; stderr: string; error: string }>((res) => {
        execFile("node", [dir + "/client.mjs"], { cwd: dir, env: { ...process.env, PAYER_KEY: key, URL: apiUrl + "/v1/quote", OPT_IN: process.env.X402_OPT_IN ?? "1", NETWORK: "eip155:" + w.chainId, TOKEN: w.token }, timeout: 60000 }, (err, stdout, stderr) =>
          res({ stdout, stderr, error: String(err ?? "") }),
        );
      });
      if (!r.stdout.includes("RESULT")) console.log("OFFICIAL_CLIENT_STDERR " + r.stderr.slice(0, 600) + r.error);
      const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT ")) ?? "RESULT {}";
      console.log("OFFICIAL_CLIENT " + line + " handlerCalls=" + handler.mock.calls.length + " payeeBalance=" + (await w.balance(w.payTo)));
      expect(line.startsWith("RESULT ")).toBe(true);
    } finally {
      await api.close();
      await fac.close();
      s.close();
    }
  }, 120000);
});
