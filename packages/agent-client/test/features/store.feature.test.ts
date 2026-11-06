import { describe, it, expect, afterEach } from "vitest";
import { AgentStore, httpFacilitatorLookup, StoreError } from "../../src/index.js";
import { World, tmpStore, account, asset, url, url2, SECRET } from "../build-store-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const sandbox = () => {
  const s = tmpStore();
  cleanups.push(s.cleanup);
  return s;
};

describe("Feature: crash-safe agent payments", () => {
  describe("Scenario: an agent restarts mid-payment and pays once", () => {
    it("happy path", async () => {
      // Given an agent that signed a payment and died before the server answered
      const { path } = sandbox();
      const w = new World();
      let armed = true;
      const first = w.agent(path, {}, {
        faultInjection: (p) => {
          if (armed && p === "before:send") {
            armed = false;
            throw new Error("power cut");
          }
        },
      });
      await expect(first.fetch(url)).rejects.toThrow("power cut");
      first.close();
      // When the agent restarts and recovers
      const second = w.agent(path);
      const actions = await second.recover();
      // Then the same authorization is submitted once, the resource is paid once
      expect(actions.map((a) => a.action)).toEqual(["resubmitted"]);
      expect(w.submits).toHaveLength(1);
      expect(w.used.size).toBe(1);
      expect(second.payments[0].status).toBe("settled");
      expect(second.reservedAmount).toBe(10000n);
    });

    it("failure path: the facilitator is down and the chain is unreachable, so nothing is released or re-signed", async () => {
      // Given a payment in flight when the process died and the send never reached the server
      const { path } = sandbox();
      const w = new World();
      w.mode = "drop";
      const first = w.agent(path);
      await first.fetch(url).catch(() => undefined);
      first.close();
      // When the agent restarts while both the RPC and the facilitator are down
      w.chainDown = true;
      w.fac = "down";
      const second = w.agent(path);
      const actions = await second.recover();
      // Then the budget stays reserved and no second nonce exists
      expect(actions[0].action).toBe("error");
      expect(second.reservedAmount).toBe(10000n);
      expect(second.payments).toHaveLength(1);
    });

    it("failure path: the server settled while we were down and the store missed it", async () => {
      // Given a submitted record whose settlement the store never saw
      const { path } = sandbox();
      const w = new World();
      w.mode = "drop";
      const first = w.agent(path);
      const err = await first.fetch(url).catch((e) => e);
      first.close();
      w.settle(err.paymentId);
      // When the agent recovers
      const second = w.agent(path);
      const actions = await second.recover();
      // Then it adopts the settled state from the receipt and does not send again
      expect(actions[0].action).toBe("settled");
      expect(w.submits).toHaveLength(1);
    });
  });

  describe("Scenario: an agent over budget is refused", () => {
    it("happy path: payments up to the budget succeed", async () => {
      // Given a budget of exactly two payments
      const { path } = sandbox();
      const w = new World();
      const a = w.agent(path, { sessionBudget: 20000n });
      // When it buys two resources
      await a.fetch(url);
      await a.fetch(url2);
      // Then the full budget is reserved
      expect(a.reservedAmount).toBe(20000n);
    });
    it("failure path: the next purchase is refused, also after a restart", async () => {
      const { path } = sandbox();
      const w = new World();
      const a = w.agent(path, { sessionBudget: 20000n });
      await a.fetch(url);
      await a.fetch(url2);
      a.close();
      // When a restarted agent tries a third purchase
      const b = w.agent(path, { sessionBudget: 20000n });
      // Then it is refused and nothing is signed or sent
      await expect(b.fetch(`${url}?third`)).rejects.toMatchObject({ code: "budget_exceeded" });
      expect(w.submits).toHaveLength(2);
    });
    it("failure path: a restart cannot raise the budget", async () => {
      const { path } = sandbox();
      const w = new World();
      w.agent(path, { sessionBudget: 10000n }).close();
      expect(() => w.agent(path, { sessionBudget: 1_000_000n })).toThrowError(
        expect.objectContaining({ code: "mismatch" }),
      );
    });
  });

  describe("Scenario: two agents sharing nothing cannot read each other's state", () => {
    it("happy path: each agent sees only its own payments", async () => {
      // Given two agents with separate stores and secrets
      const a = sandbox(), b = sandbox();
      const wa = new World(), wb = new World();
      const A = wa.agent(a.path, {}, { secret: "secret-of-agent-A-0000" });
      const B = wb.agent(b.path, {}, { secret: "secret-of-agent-B-0000" });
      // When each pays for a different resource
      await A.fetch(url);
      await B.fetch(url2);
      // Then neither sees the other's payment, session or nonce
      expect(A.payments.map((p) => p.url)).toEqual([url]);
      expect(B.payments.map((p) => p.url)).toEqual([url2]);
      expect(A.sessionId).not.toBe(B.sessionId);
      expect(A.reservedAmount).toBe(10000n);
    });
    it("failure path: opening one agent's store with another's secret is refused", async () => {
      const a = sandbox();
      const wa = new World();
      const A = wa.agent(a.path, {}, { secret: "secret-of-agent-A-0000" });
      await A.fetch(url);
      A.close();
      expect(() =>
        AgentStore.open(
          wa.config(a.path, { secret: "secret-of-agent-B-0000", unsafeNoLease: true }),
          { chainId: 1874, token: asset, payer: account.address, budget: 30000n, domainName: "Tether USD", domainVersion: "1" },
        ),
      ).toThrowError(expect.objectContaining({ code: "integrity" }));
    });
    it("failure path: a second live agent cannot attach to the same store", async () => {
      const a = sandbox();
      const w = new World();
      const A = w.agent(a.path);
      expect(() => w.agent(a.path)).toThrowError(expect.objectContaining({ code: "lease" }));
      A.close();
      w.agent(a.path).close();
    });
  });
});

describe("Feature: facilitator lookup client", () => {
  const nonce = ("0x" + "ab".repeat(32)) as `0x${string}`;
  const mk = (res: () => Response | Promise<Response>, seen: string[] = []) =>
    httpFacilitatorLookup("https://fac.example", {
      fetch: (async (u: string) => {
        seen.push(u);
        return res();
      }) as unknown as typeof fetch,
    });
  it("reads status from the read-only route", async () => {
    const seen: string[] = [];
    const f = mk(() => Response.json({ status: "settled", transaction: "0x" + "12".repeat(32) }), seen);
    expect(await f.status({ payer: account.address, nonce })).toMatchObject({ status: "settled" });
    expect(seen[0]).toBe(`https://fac.example/v1/x402/payments/${account.address}/${nonce}`);
  });
  it("treats 404 as unknown; errors and junk throw (advisory only)", async () => {
    expect((await mk(() => new Response("", { status: 404 })).status({ payer: account.address, nonce })).status).toBe("unknown");
    await expect(mk(() => new Response("", { status: 500 })).status({ payer: account.address, nonce })).rejects.toThrow();
    await expect(mk(() => Response.json({ status: "weird" })).status({ payer: account.address, nonce })).rejects.toThrow();
    await expect(mk(() => Response.json({})).status({ payer: account.address, nonce: "0x12" as never })).rejects.toThrow();
  });
  it("refuses a URL with credentials", () => {
    expect(() => httpFacilitatorLookup("https://u:p@fac.example")).toThrow();
  });
});

void StoreError; void SECRET;
