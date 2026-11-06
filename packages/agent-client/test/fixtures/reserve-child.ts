// Child process for the multi-process tests. args: path mode index startAtMs
import { AgentStore, StoreError, type ChainEvidence } from "../../src/store.js";

const [path, mode, index, startAt] = process.argv.slice(2);
const asset = "0x2222222222222222222222222222222222222222" as const;
const payer = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" as const;
(async () => {
  try {
    const store = AgentStore.open(
      {
        path,
        secret: "test-store-secret-0123456789",
        chain: {} as ChainEvidence,
        unsafeNoLease: mode === "nolease",
      },
      {
        chainId: 1874,
        token: asset,
        payer: (process.env.CHILD_PAYER ?? payer) as `0x${string}`,
        budget: BigInt(process.env.CHILD_BUDGET ?? "10000"),
        domainName: "Tether USD",
        domainVersion: "1",
      },
    );
    while (Date.now() < Number(startAt)) {
      /* spin so the children contend at the same moment */
    }
    if (mode === "nolease") {
      store.reserveIntent({
        to: "0x3333333333333333333333333333333333333333",
        value: 10000n,
        validAfter: 0n,
        validBefore: 2_000_000n,
        resource: `https://api.example/r${index}`,
        accepted: "{}",
      });
    }
    store.close();
    console.log(JSON.stringify({ ok: true }));
  } catch (e) {
    console.log(
      JSON.stringify({
        ok: false,
        code: e instanceof StoreError ? e.code : "other",
        message: String(e),
      }),
    );
  }
})();
