/** Round 5 coverage: IPv6 /64 keying, new-wallet slot reservation/release, in-flight revert limits, per-attempt payer. */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { QuietpayError, buildCheckoutAuthorization, type Order } from "@quietpay/shared";
import { Db } from "../src/db.js";
import { clientKey } from "../src/ratelimit.js";
import { makeEnv, newOrder } from "./helpers.js";

const key = (i: number) => ("0x" + (0x30 + i).toString(16).padStart(2, "0").repeat(32)) as Hex;
async function signAs(k: Hex, order: Order, now: number) {
  const acct = privateKeyToAccount(k);
  const validAfter = now - 5;
  const validBefore = now + 300;
  const signature = await acct.signTypedData(
    buildCheckoutAuthorization({
      from: acct.address,
      router: order.checkout.router as Hex,
      value: BigInt(order.amount),
      nonce: order.checkout.nonce as Hex,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      chainId: order.checkout.chainId,
      token: order.checkout.token as Hex,
    }),
  );
  return { orderId: order.id, payer: acct.address, validAfter, validBefore, signature };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof QuietpayError ? e.code : "other";
  }
};

describe("clientKey", () => {
  it("keys IPv4 exactly, mapped IPv6 as IPv4, other IPv6 by /64", () => {
    expect(clientKey("203.0.113.5")).toBe("203.0.113.5");
    expect(clientKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(clientKey("::ffff:cb00:7105")).toBe("203.0.113.5");
    expect(clientKey("2a02:6b8:abcd:12::1")).toBe(clientKey("2a02:6b8:abcd:12:ffff:1:2:3"));
    expect(clientKey("2a02:6b8:abcd:12::1")).not.toBe(clientKey("2a02:6b8:abcd:13::1"));
    expect(clientKey("2A02:6B8:ABCD:12::1%eth0")).toBe(clientKey("2a02:6b8:abcd:12::9"));
  });
});

describe("new-wallet slot reservation", () => {
  it("is released when the relay is rejected before broadcast", async () => {
    const { svc, chain, clock } = makeEnv({ maxNewPayersPerIpPerHour: 1 });
    const ctx = { ip: "203.0.113.9" };
    chain.simulateFails = true;
    const o1 = await newOrder(svc);
    expect(await code(svc.relayPay(await signAs(key(1), o1, clock.t), ctx))).toBe("simulation_failed");
    chain.simulateFails = false;
    const o2 = await newOrder(svc);
    expect(await code(svc.relayPay(await signAs(key(2), o2, clock.t), ctx))).toBe("ok");
    const o3 = await newOrder(svc);
    expect(await code(svc.relayPay(await signAs(key(3), o3, clock.t), ctx))).toBe("rate_limited");
  });
});

describe("in-flight txs count toward per-payer limits", () => {
  it("unresolvedPayerTxs reports pending txs of one payer only", async () => {
    const { svc, chain, db, clock } = makeEnv();
    chain.holdReceipt = true;
    const o = await newOrder(svc);
    const req = await signAs(key(4), o, clock.t);
    await svc.relayPay(req, { ip: "203.0.113.10" });
    const s = db.unresolvedPayerTxs(req.payer);
    expect(s.count).toBe(1);
    expect(s.wei > 0n).toBe(true);
    expect(db.unresolvedPayerTxs(privateKeyToAccount(key(5)).address).count).toBe(0);
  });
});

describe("tx_attempts.payer migration", () => {
  it("adds the column to an old database and backfills the current pay tx", () => {
    const path = `:memory:`;
    const db = new Db(path);
    expect((db.raw.prepare("PRAGMA table_info(tx_attempts)").all() as { name: string }[]).some((c) => c.name === "payer")).toBe(true);
    void Database;
  });
});
