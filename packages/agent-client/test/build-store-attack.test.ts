import { describe, it, expect, afterEach } from "vitest";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { AgentStore, deriveNonce, type AgentOptions } from "../src/index.js";
import type { Hex } from "viem";
import { encodeX402Header } from "@quietpay/shared";
import { World, tmpStore, account, asset, payTo, evil, url, url2, base } from "./build-store-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const sandbox = () => {
  const s = tmpStore();
  cleanups.push(s.cleanup);
  return s;
};
const terms = {
  chainId: 1874,
  token: asset,
  payer: account.address,
  budget: 30000n,
  domainName: "Tether USD",
  domainVersion: "1",
};
const peek = (w: World, path: string) => {
  const s = AgentStore.open(w.config(path, { unsafeNoLease: true }), terms);
  const l = s.list();
  s.close();
  return l;
};
/** Leave a submitted record behind (the network dropped the request). */
async function dropped(path: string, w: World) {
  w.mode = "drop";
  const a = w.agent(path);
  const err = await a.fetch(url).catch((e) => e);
  a.close();
  w.mode = "settle";
  return err.paymentId as Hex;
}

describe("attack: the facilitator lies", () => {
  it("says failed, then chain shows the nonce used: reserved unchanged until evidence, then settled", async () => {
    const { path } = sandbox();
    const w = new World();
    const id = await dropped(path, w);
    w.mode = "drop";
    w.fac = { status: "failed" };
    const a = w.agent(path);
    // Not expired, nothing on chain: the failed claim changes nothing.
    await a.recover();
    expect(a.reservedAmount).toBe(10000n);
    expect(a.payments[0].status).not.toBe("failed");
    // Real settlement lands on chain behind the facilitator's back.
    w.settle(id);
    const r = await a.recover();
    expect(r[0].action).toBe("settled");
    expect(a.payments[0].status).toBe("settled");
    expect(a.reservedAmount).toBe(10000n);
    // And it is never released afterwards, however late the chain gets.
    w.now += 10_000n;
    w.finalized = w.now;
    await a.recover();
    expect(a.reservedAmount).toBe(10000n);
  });

  it("says failed AFTER expiry while the nonce is used on chain: settled, never released", async () => {
    const { path } = sandbox();
    const w = new World();
    const id = await dropped(path, w);
    w.settle(id);
    w.fac = { status: "failed" };
    w.now += 10_000n;
    w.finalized = w.now;
    const a = w.agent(path);
    expect((await a.recover())[0].action).toBe("settled");
    expect(a.reservedAmount).toBe(10000n);
  });

  it("a rejected payment (HTTP failure header) still holds budget until chain expiry", async () => {
    const { path } = sandbox();
    const w = new World();
    w.mode = "reject";
    const a = w.agent(path);
    await expect(a.fetch(url)).rejects.toMatchObject({ code: "payment_failed" });
    expect(a.reservedAmount).toBe(10000n);
    await a.recover();
    expect(a.reservedAmount).toBe(10000n);
    w.now += 1000n;
    w.finalized = w.now;
    expect((await a.recover())[0].action).toBe("released");
    expect(a.reservedAmount).toBe(0n);
  });

  it("facilitator says settled with a transaction that is not ours: stays unresolved, never settled", async () => {
    const cases: [string, (w: World, id: Hex) => Hex][] = [
      ["wrong payTo", (w, id) => w.settle(id, evil)],
      ["wrong value", (w, id) => w.settle(id, payTo, "1")],
      ["another payer", (w, id) => w.settle(id, payTo, "10000", evil)],
    ];
    for (const [name, make] of cases) {
      const { path } = sandbox();
      const w = new World();
      const id = await dropped(path, w);
      const tx = make(w, id);
      w.used.delete(id.toLowerCase()); // the lie is only the facilitator's; chain state says unused
      w.fac = { status: "settled", transaction: tx };
      const a = w.agent(path);
      const r = await a.recover();
      expect(r[0].action, name).toBe("held");
      expect(a.payments[0].status, name).not.toBe("settled");
      expect(a.reservedAmount, name).toBe(10000n);
      // Even past expiry the foreign tx keeps the budget held.
      w.now += 10_000n;
      w.finalized = w.now;
      await a.recover();
      expect(a.reservedAmount, name).toBe(10000n);
      expect(a.payments[0].status, name).not.toBe("settled");
    }
  });

  it("cancelAuthorization sets authorizationState without paying: never settled, never released", async () => {
    const { path } = sandbox();
    const w = new World();
    const id = await dropped(path, w);
    w.cancel(id);
    w.now += 10_000n;
    w.finalized = w.now;
    const a = w.agent(path);
    expect((await a.recover())[0].action).toBe("held");
    expect(a.payments[0].status).not.toBe("settled");
    expect(a.reservedAmount).toBe(10000n);
  });

  it("a resource server claiming success with a fake tx is not believed", async () => {
    const { path } = sandbox();
    const w = new World();
    const fake = w.fetch;
    (w as unknown as { fetch: unknown }).fetch = async (u: string, init?: RequestInit) => {
      if (!new Headers(init?.headers).get("PAYMENT-SIGNATURE")) return w.challenge(u);
      return new Response("{}", {
        headers: {
          "PAYMENT-RESPONSE": encodeX402Header({
            success: true,
            transaction: "0x" + "cd".repeat(32),
            payer: account.address,
            network: "eip155:1874",
          }),
        },
      });
    };
    void fake;
    const a = w.agent(path);
    await expect(a.fetch(url)).rejects.toMatchObject({ code: "payment_status_unknown" });
    expect(a.payments[0].status).not.toBe("settled");
    expect(a.reservedAmount).toBe(10000n);
  });
});

describe("attack: terms changed after restart", () => {
  it("different budget / payee allowlist on reopen with an existing session is rejected, nothing signed", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path);
    await a.fetch(url);
    a.close();
    let signed = 0;
    const signer: AgentOptions["signer"] = { address: account.address, signTypedData: async (d) => (signed++, account.signTypedData(d)) };
    expect(() => w.agent(path, { sessionBudget: 10_000_000n, signer })).toThrowError(
      expect.objectContaining({ code: "mismatch" }),
    );
    expect(signed).toBe(0);
  });

  it("server changes amount/payTo for an open resource: rejected without signing", async () => {
    for (const patch of [{ amount: "19999" }, { payTo: evil }] as const) {
      const { path } = sandbox();
      const w = new World();
      const id = await dropped(path, w);
      let signed = 0;
      const a = w.agent(path, {
        allowedPayTo: [payTo, evil],
        signer: { address: account.address, signTypedData: async (d) => (signed++, account.signTypedData(d)) },
      });
      const orig = w.fetch;
      (w as unknown as { fetch: unknown }).fetch = async (u: string, i?: RequestInit) => {
        const res = await (orig as typeof fetch)(u, i);
        if (res.status !== 402) return res;
        const req = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString());
        Object.assign(req.accepts[0], patch);
        return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodeX402Header(req) } });
      };
      // `a` captured w.fetch at creation; build a fresh agent that sees the mutated server.
      a.close();
      const b = w.agent(path, { allowedPayTo: [payTo, evil], signer: { address: account.address, signTypedData: async (d) => (signed++, account.signTypedData(d)) } });
      await expect(b.fetch(url)).rejects.toMatchObject({ code: "invalid_payment" });
      expect(signed).toBe(0);
      expect(b.payments).toHaveLength(1);
      expect(b.payments[0].id).toBe(id);
    }
  });

  it("a huge maxTimeoutSeconds is capped at 300s of chain time", async () => {
    const { path } = sandbox();
    const w = new World();
    w.maxTimeout = 600;
    const a = w.agent(path);
    await a.fetch(url);
    const rec = peek(w, path)[0];
    expect(BigInt(rec.validBefore) - w.now).toBe(300n);
  });

  it("validBefore comes from chain time, not the local clock", async () => {
    const { path } = sandbox();
    const w = new World();
    w.now = 5_000_000_000n; // far from Date.now()
    w.finalized = w.now;
    const a = w.agent(path);
    await a.fetch(url);
    expect(BigInt(peek(w, path)[0].validBefore)).toBe(5_000_000_055n);
  });

  it("no chain time means nothing is signed", async () => {
    const { path } = sandbox();
    const w = new World();
    w.chainDown = true;
    let signed = 0;
    const a = w.agent(path, { signer: { address: account.address, signTypedData: async (d) => (signed++, account.signTypedData(d)) } });
    await expect(a.fetch(url)).rejects.toMatchObject({ code: "invalid_payment" });
    expect(signed).toBe(0);
    expect(a.payments).toHaveLength(0);
  });
});

describe("attack: injection and cross-session reuse", () => {
  it("SQL metacharacters in the resource are stored verbatim and harm nothing", async () => {
    const { path } = sandbox();
    const w = new World();
    const evilUrl = `${base}/v1/q?x=');DROP TABLE payments;--&y="; DELETE FROM events;`;
    const a = w.agent(path);
    await a.fetch(evilUrl);
    a.close();
    const rows = peek(w, path);
    expect(rows).toHaveLength(1);
    expect(rows[0].resource).toBe(new URL(evilUrl).href);
    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='payments'").all()).toHaveLength(1);
    expect((db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c).toBeGreaterThan(3);
    db.close();
  });

  it("two sessions never produce the same nonce for identical terms", async () => {
    const w = new World();
    const a1 = sandbox(), a2 = sandbox();
    const x = w.agent(a1.path), y = w.agent(a2.path);
    await x.fetch(url);
    await y.fetch(url);
    expect(x.sessionId).not.toBe(y.sessionId);
    expect(x.payments[0].id).not.toBe(y.payments[0].id);
  });

  it("the same nonce always means the same terms (nonce collision with other terms is infeasible by construction)", () => {
    const seen = new Map<string, string>();
    const sid = ("0x" + "ab".repeat(32)) as Hex;
    for (let counter = 1; counter <= 40; counter++)
      for (const value of [1n, 10000n])
        for (const to of [payTo, evil]) {
          const t = { chainId: 1874, token: asset, from: account.address, to, value, validAfter: 0n, validBefore: 100n, resource: url, sessionId: sid, counter };
          const n = deriveNonce(t);
          const key = JSON.stringify([counter, value.toString(), to]);
          expect(seen.has(n) ? seen.get(n) : key).toBe(key);
          seen.set(n, key);
        }
    expect(seen.size).toBe(160);
  });
});

describe("attack: replay and rollback", () => {
  it("a pending authorization is never replayed after expiry", async () => {
    const { path } = sandbox();
    const w = new World();
    const id = await dropped(path, w);
    const a = w.agent(path);
    const before = w.submits.length;
    w.now += 10_000n;
    await expect(a.retry(id)).rejects.toMatchObject({ code: "payment_failed" });
    await a.recover();
    expect(w.submits.length).toBe(before);
  });

  it("restoring an old backup never signs a nonce with new terms; reconcile reveals the unknown spend", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path);
    await a.fetch(url);
    a.close();
    const backup = path + ".bak";
    // Fold the WAL into the main file so a plain file copy is a consistent backup.
    const db = new Database(path);
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    copyFileSync(path, backup);
    // Normal life continues: two more payments, with new chain time each.
    const termsByNonce = new Map<string, string>();
    const note = (list: ReturnType<typeof peek>) =>
      list.forEach((r) => {
        const t = JSON.stringify([r.payTo, r.amount, r.validAfter, r.validBefore, r.resource]);
        expect(termsByNonce.get(r.nonce) ?? t).toBe(t);
        termsByNonce.set(r.nonce, t);
      });
    const b = w.agent(path);
    w.now += 100n;
    await b.fetch(url2);
    w.now += 100n;
    await b.fetch(`${url}?third`);
    b.close();
    note(peek(w, path));
    // Attacker (or an operator mistake) restores the backup: whole-file rollback is undetectable here...
    copyFileSync(backup, path);
    for (const s of ["-wal", "-shm"]) if (existsSync(path + s)) rmSync(path + s); // stale sidecars
    const c = w.agent(path);
    expect(c.payments).toHaveLength(1); // rollback visible only by reconciling with chain
    // ...but the chain remembers spends the store forgot.
    expect((await c.reconcile()).length).toBe(2);
    // New work uses fresh chain time: new nonces, and none collides with a previously signed set.
    w.now += 100n;
    await c.fetch(url2);
    c.close();
    note(peek(w, path));
    // Every nonce ever submitted maps to exactly one set of terms.
    expect(w.used.size).toBe(4);
  });
});
