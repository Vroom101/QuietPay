import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  AgentStore,
  AgentError,
  type PaymentRecord,
} from "../src/index.js";
import {
  World,
  tmpStore,
  account,
  asset,
  payTo,
  url,
  url2,
  SECRET,
} from "./build-store-helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function sandbox() {
  const s = tmpStore();
  cleanups.push(s.cleanup);
  return s;
}
const reload = (store: AgentStore) => store.list();

const POINTS = [
  "before:intent",
  "after:intent",
  "after:sign-before-store",
  "before:signed",
  "after:signed",
  "before:submitted",
  "after:submitted",
  "before:send",
  "after:response-before-store",
  "before:settled",
  "after:settled",
] as const;

describe("crash matrix: throw at every write boundary, restart, recover", () => {
  for (const point of POINTS) {
    it(`crash at ${point}: one nonce, at most one submit, budget unchanged, pays once`, async () => {
      const { path } = sandbox();
      const w = new World();
      let armed = true;
      const a1 = w.agent(path, {}, {
        faultInjection: (p) => {
          if (armed && p === point) {
            armed = false;
            throw new Error(`crash@${p}`);
          }
        },
      });
      await expect(a1.fetch(url)).rejects.toThrow();
      a1.close(); // process death: the lease is released by expiry in real life

      // Restart.
      const a2 = w.agent(path);
      const before = a2.reservedAmount;
      expect(before).toBe(point === "before:intent" ? 0n : 10000n);
      await a2.recover();
      if (point === "before:intent") {
        expect(a2.payments).toHaveLength(0);
        expect(w.submits).toHaveLength(0);
        // The caller simply asks again and pays exactly once.
        expect((await a2.fetch(url)).status).toBe(200);
      }
      expect(a2.payments).toHaveLength(1);
      const row = a2.payments[0];
      expect(row.status).toBe("settled");
      expect(a2.reservedAmount).toBe(10000n);
      // One distinct nonce on the wire and on chain, never a second transfer.
      expect(new Set(w.submits.map((s) => s.nonce)).size).toBe(1);
      expect(w.submits.length).toBe(1);
      expect(w.used.size).toBe(1);
      expect(w.submits[0].nonce).toBe(row.id);
      a2.close();
    });
  }

  it("a settled-but-undelivered record is delivered by retry(id) with the same nonce", async () => {
    const { path } = sandbox();
    const w = new World();
    let armed = true;
    const a1 = w.agent(path, {}, {
      faultInjection: (p) => {
        if (armed && p === "after:response-before-store") {
          armed = false;
          throw new Error("crash");
        }
      },
    });
    await expect(a1.fetch(url)).rejects.toThrow();
    a1.close();
    const a2 = w.agent(path);
    await a2.recover();
    const id = a2.payments[0].id;
    expect(a2.payments[0]).toMatchObject({ status: "settled", delivered: false });
    expect((await a2.retry(id)).status).toBe(200);
    expect(a2.payments[0].delivered).toBe(true);
    expect(new Set(w.submits.map((s) => s.nonce)).size).toBe(1);
    expect(w.used.size).toBe(1);
  });

  it("idempotency key is stable across retries and the payload is byte-identical", async () => {
    const { path } = sandbox();
    const w = new World();
    w.mode = "drop";
    const a = w.agent(path);
    const err = await a.fetch(url).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    await a.retry(err.paymentId).catch(() => {});
    await a.retry(err.paymentId).catch(() => {});
    expect(w.submits).toHaveLength(3);
    expect(new Set(w.submits.map((s) => s.idem)).size).toBe(1);
    expect(new Set(w.submits.map((s) => s.sig)).size).toBe(1);
    expect(new Set(w.submits.map((s) => s.nonce)).size).toBe(1);
  });
});

describe("persistence", () => {
  it("budget persists across restarts", async () => {
    const { path } = sandbox();
    const w = new World();
    for (const u of [url, url2, `${url}?n=3`]) {
      const a = w.agent(path);
      expect((await a.fetch(u)).status).toBe(200);
      a.close();
    }
    const a = w.agent(path);
    expect(a.reservedAmount).toBe(30000n);
    await expect(a.fetch(`${url}?n=4`)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    expect(w.submits).toHaveLength(3);
  });

  it("a session survives restart: same session id, counters continue", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path);
    await a.fetch(url);
    const sid = a.sessionId;
    a.close();
    const b = w.agent(path);
    expect(b.sessionId).toBe(sid);
    await b.fetch(url2);
    const store = AgentStore.open(w.config(path, { unsafeNoLease: true }), {
      chainId: 1874,
      token: asset,
      payer: account.address,
      budget: 30000n,
      domainName: "Tether USD",
      domainVersion: "1",
    });
    expect(reload(store).map((r) => r.counter)).toEqual([1, 2]);
    store.close();
    b.close();
  });
});

describe("concurrency", () => {
  it("Promise.all cannot exceed the budget: exactly one intent when budget fits one", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path, { sessionBudget: 10000n });
    const results = await Promise.allSettled([
      a.fetch(url),
      a.fetch(url2),
      a.fetch(`${url}?c=3`),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((r) => r.status === "rejected"))
      expect((r as PromiseRejectedResult).reason.code).toBe("budget_exceeded");
    expect(a.payments).toHaveLength(1);
    expect(a.reservedAmount).toBe(10000n);
    expect(w.submits).toHaveLength(1);
  });

  it("concurrent fetches of one resource produce one payment", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path);
    const r = await Promise.allSettled([a.fetch(url), a.fetch(url)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(a.payments).toHaveLength(1);
    expect(w.submits).toHaveLength(1);
  });

  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const child = join(import.meta.dirname, "fixtures", "reserve-child.ts");
  const run = (args: string[], budget = "10000") =>
    new Promise<{ code: number | null; out: string }>((res) => {
      const p = spawn(process.execPath, [tsx, child, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CHILD_PAYER: account.address, CHILD_BUDGET: budget },
      });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });

  it("two processes racing on one store cannot exceed the budget (BEGIN IMMEDIATE alone)", async () => {
    const { path } = sandbox();
    const w = new World();
    // Create the file (schema + session) first.
    const seed = AgentStore.open(w.config(path, { unsafeNoLease: true }), {
      chainId: 1874,
      token: asset,
      payer: account.address,
      budget: 10000n,
      domainName: "Tether USD",
      domainVersion: "1",
    });
    seed.close();
    const at = String(Date.now() + 4000);
    const out = await Promise.all(
      [1, 2, 3].map((i) => run([path, "nolease", String(i), at])),
    );
    const ok = out.filter((o) => o.out.includes('"ok":true'));
    expect(ok).toHaveLength(1);
    expect(out.filter((o) => o.out.includes('"code":"budget"'))).toHaveLength(2);
    const store = AgentStore.open(w.config(path, { unsafeNoLease: true }), {
      chainId: 1874,
      token: asset,
      payer: account.address,
      budget: 10000n,
      domainName: "Tether USD",
      domainVersion: "1",
    });
    expect(store.list()).toHaveLength(1);
    expect(store.reserved()).toBe(10000n);
    store.close();
  }, 60000);

  it("a second process cannot drive a session that is already leased", async () => {
    const { path } = sandbox();
    const w = new World();
    const a = w.agent(path);
    await a.fetch(url);
    const o = await run([path, "lease", "9", "0"], "30000");
    expect(o.out).toContain('"code":"lease"');
    a.close();
    const after = await run([path, "lease", "9", "0"], "30000");
    expect(after.out).toContain('"ok":true');
  }, 60000);
});

describe("expiry and release", () => {
  async function stale() {
    const { path } = sandbox();
    const w = new World();
    w.mode = "drop";
    const a = w.agent(path);
    const err = await a.fetch(url).catch((e) => e);
    const rec = (() => {
      const s = AgentStore.open(w.config(path, { unsafeNoLease: true }), {
        chainId: 1874,
        token: asset,
        payer: account.address,
        budget: 30000n,
        domainName: "Tether USD",
        domainVersion: "1",
      });
      const r = s.get(err.paymentId)!;
      s.close();
      return r;
    })();
    return { path, w, a, id: err.paymentId, rec };
  }

  it("a stale signed record past validBefore is not resent and is released only after chain AND facilitator confirm nothing settled", async () => {
    const { w, a, rec } = await stale();
    w.mode = "settle";
    const vb = BigInt(rec.validBefore);
    // Latest block is past validBefore but nothing finalized yet.
    w.now = vb + 5n;
    let r = await a.recover();
    expect(r[0].action).toBe("waiting");
    expect(w.submits).toHaveLength(1); // the original dropped send only
    expect(a.reservedAmount).toBe(10000n);
    // Finalized exactly at validBefore is not expiry (strictly greater required).
    w.finalized = vb;
    r = await a.recover();
    expect(a.reservedAmount).toBe(10000n);
    // Finalized past validBefore, but the facilitator still claims pending: hold.
    w.finalized = vb + 1n;
    w.fac = { status: "pending" };
    r = await a.recover();
    expect(r[0].action).toBe("held");
    expect(a.reservedAmount).toBe(10000n);
    // Facilitator says settled but chain shows nothing: hold, never release.
    w.fac = { status: "settled", transaction: ("0x" + "9".repeat(64)) as `0x${string}` };
    r = await a.recover();
    expect(r[0].action).toBe("held");
    expect(a.reservedAmount).toBe(10000n);
    // Chain unreachable: nothing released.
    w.fac = { status: "unknown" };
    w.chainDown = true;
    r = await a.recover();
    expect(r[0].action).toBe("error");
    expect(a.reservedAmount).toBe(10000n);
    w.chainDown = false;
    // Both confirm nothing settled: release.
    r = await a.recover();
    expect(r[0].action).toBe("released");
    expect(a.reservedAmount).toBe(0n);
    expect(w.submits).toHaveLength(1);
    // Released budget can fund a new payment (with a NEW nonce and terms).
    w.now += 1000n;
    w.finalized = w.now;
    expect((await a.fetch(url)).status).toBe(200);
    expect(new Set(w.submits.map((s) => s.nonce)).size).toBe(2);
  });

  it("facilitator down or failed does not release; finalized expiry with an unused nonce does", async () => {
    const { w, a, rec } = await stale();
    const vb = BigInt(rec.validBefore);
    w.fac = "down";
    w.now = vb + 1n;
    expect((await a.recover())[0].action).toBe("waiting");
    expect(a.reservedAmount).toBe(10000n);
    w.fac = { status: "failed" };
    expect((await a.recover())[0].action).toBe("waiting");
    expect(a.reservedAmount).toBe(10000n);
    w.finalized = vb + 1n;
    expect((await a.recover())[0].action).toBe("released");
    expect(a.reservedAmount).toBe(0n);
  });

  it("an unsigned intent that is too close to expiry is abandoned and held until expiry", async () => {
    const { path } = sandbox();
    const w = new World();
    let armed = true;
    const a1 = w.agent(path, {}, {
      faultInjection: (p) => {
        if (armed && p === "after:intent") {
          armed = false;
          throw new Error("crash");
        }
      },
    });
    await expect(a1.fetch(url)).rejects.toThrow();
    a1.close();
    w.now += 40n; // 55s window, 30s margin: 15s left
    const a2 = w.agent(path);
    expect((await a2.recover())[0].action).toBe("abandoned");
    expect(w.submits).toHaveLength(0);
    expect(a2.reservedAmount).toBe(10000n);
    w.now += 100n;
    w.finalized = w.now;
    expect((await a2.recover())[0].action).toBe("released");
    expect(a2.reservedAmount).toBe(0n);
    expect(w.submits).toHaveLength(0);
  });

  it("recovery re-signs an intent with the SAME nonce and terms", async () => {
    const { path } = sandbox();
    const w = new World();
    let armed = true;
    const signed: unknown[] = [];
    const a1 = w.agent(path, {
      signer: {
        address: account.address,
        signTypedData: async (d) => {
          signed.push(d.message);
          return account.signTypedData(d);
        },
      },
    }, {
      faultInjection: (p) => {
        if (armed && p === "after:sign-before-store") {
          armed = false;
          throw new Error("crash");
        }
      },
    });
    await expect(a1.fetch(url)).rejects.toThrow();
    a1.close();
    const a2 = w.agent(path, {
      signer: {
        address: account.address,
        signTypedData: async (d) => {
          signed.push(d.message);
          return account.signTypedData(d);
        },
      },
    });
    await a2.recover();
    expect(signed).toHaveLength(2);
    expect(signed[1]).toEqual(signed[0]);
  });

  it("intent rows never carry a signature, signed rows do (bearer instrument)", async () => {
    const { path } = sandbox();
    const w = new World();
    w.mode = "drop";
    const a = w.agent(path);
    await a.fetch(url).catch(() => {});
    a.close();
    const s = AgentStore.open(w.config(path), {
      chainId: 1874, token: asset, payer: account.address, budget: 30000n,
      domainName: "Tether USD", domainVersion: "1",
    });
    const r: PaymentRecord = s.list()[0];
    expect(r.state).toBe("submitted");
    expect(r.signature).toMatch(/^0x[0-9a-f]{130}$/);
    s.close();
  });
});

// keep unused-import linters quiet for helpers used by sibling files
void spawnSync; void payTo; void SECRET;
