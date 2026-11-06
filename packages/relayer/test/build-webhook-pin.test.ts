import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/db.js";
import { WebhookWorker } from "../src/webhooks.js";
import { pinnedPost, resolveDeliveryTarget, makePinnedLookup } from "../src/webhook-pin.js";

const PUBLIC = "203.0.113.5"; // TEST-NET-3: classified public, never routable from a test box

const resolverOf = (...answers: string[][]) => {
  let n = 0;
  const calls: string[] = [];
  const fn = async (host: string) => {
    calls.push(host);
    const a = answers[Math.min(n++, answers.length - 1)]!;
    return a.map((address) => ({ address }));
  };
  return Object.assign(fn, { calls });
};

describe("resolveDeliveryTarget (validate once, return the addresses to pin)", () => {
  it("returns the validated public addresses", async () => {
    const r = await resolveDeliveryTarget("https://shop.example.com/hook", false, resolverOf([PUBLIC, "198.51.100.7"]));
    expect(r).toEqual({ problem: null, addresses: [PUBLIC, "198.51.100.7"] });
  });

  const bad: [string, string[]][] = [
    ["IPv4-mapped IPv6 loopback", ["::ffff:127.0.0.1"]],
    ["IPv4-mapped IPv6 metadata", ["::ffff:169.254.169.254"]],
    ["IPv4-mapped IPv6 private (hex form)", ["::ffff:7f00:1"]],
    ["IPv6 link-local", ["fe80::1"]],
    ["AWS/GCP metadata", ["169.254.169.254"]],
    ["private 10/8", ["10.1.2.3"]],
    ["loopback", ["127.0.0.1"]],
    ["unique local", ["fd00::1"]],
    ["public first, private second", [PUBLIC, "10.0.0.9"]],
    ["public first, metadata last", [PUBLIC, "198.51.100.7", "169.254.169.254"]],
    ["public first, IPv4-mapped loopback last", [PUBLIC, "::ffff:127.0.0.1"]],
  ];
  it.each(bad)("refuses a host resolving to %s", async (_n, addrs) => {
    const r = await resolveDeliveryTarget("https://shop.example.com/hook", false, resolverOf(addrs));
    expect(r.problem).not.toBeNull();
    expect(r.addresses).toEqual([]);
  });

  it("allowPrivate permits private but never link-local or metadata", async () => {
    expect((await resolveDeliveryTarget("http://shop.example.com/", true, resolverOf(["10.0.0.9"]))).problem).toBeNull();
    expect((await resolveDeliveryTarget("http://shop.example.com/", true, resolverOf(["169.254.169.254"]))).problem).not.toBeNull();
  });

  it("a name that does not resolve is refused (nothing to pin)", async () => {
    const miss = async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    const r = await resolveDeliveryTarget("https://nope.example.com/", false, miss);
    expect(r.problem).not.toBeNull();
  });

  it("static policy still applies first", async () => {
    expect((await resolveDeliveryTarget("http://127.0.0.1/", false, resolverOf([PUBLIC]))).problem).not.toBeNull();
  });
});

describe("makePinnedLookup", () => {
  it("answers only with the pinned addresses, for the pinned host only", async () => {
    const lk = makePinnedLookup("shop.example.com", [PUBLIC, "2001:db8::1"]);
    const single = await new Promise<[string, number]>((res, rej) => lk("shop.example.com", {}, (e, a, f) => (e ? rej(e) : res([a as string, f as number]))));
    expect(single).toEqual([PUBLIC, 4]);
    const all = await new Promise<{ address: string; family: number }[]>((res, rej) => lk("shop.example.com", { all: true }, (e, a) => (e ? rej(e) : res(a as never))));
    expect(all.map((x) => x.address)).toEqual([PUBLIC, "2001:db8::1"]);
    const other = await new Promise<unknown>((res) => lk("evil.example.com", {}, (e) => res(e)));
    expect(other).toBeInstanceOf(Error);
  });
});

describe("pinnedPost: DNS rebinding", () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  it("public at validation, private (127.0.0.1) at connect: the private host is never contacted and delivery fails", async () => {
    let hits = 0;
    srv = createServer((_q, s) => {
      hits += 1;
      s.end("ok");
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    // First lookup (validation): public. Any later lookup (what fetch() would do): loopback.
    const resolver = resolverOf([PUBLIC], ["127.0.0.1"]);
    const target = await resolveDeliveryTarget(`http://rebind.example.com:${port}/hook`, false, resolver);
    expect(target.problem).toBeNull();
    await expect(
      pinnedPost(`http://rebind.example.com:${port}/hook`, target.addresses, { headers: {}, body: "{}", timeoutMs: 400 }),
    ).rejects.toBeTruthy();
    expect(hits).toBe(0);
    expect(resolver.calls).toHaveLength(1); // the connection never re-resolves
  });

  it("connects to the pinned address, keeps the Host header, does not follow redirects", async () => {
    const seen: { host?: string; path?: string }[] = [];
    srv = createServer((q, s) => {
      seen.push({ host: q.headers.host, path: q.url });
      s.writeHead(302, { location: "http://127.0.0.1:1/x" });
      s.end();
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const res = await pinnedPost(`http://hook.example.com:${port}/a?b=1`, ["127.0.0.1"], { headers: { "x-t": "1" }, body: "{}", timeoutMs: 2000 });
    expect(res.status).toBe(302);
    expect(seen).toEqual([{ host: `hook.example.com:${port}`, path: "/a?b=1" }]);
  });

  it("times out a tarpit", async () => {
    srv = createServer(() => undefined);
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    await expect(pinnedPost(`http://t.example.com:${port}/`, ["127.0.0.1"], { headers: {}, body: "{}", timeoutMs: 150 })).rejects.toBeTruthy();
  });
});

describe("WebhookWorker default delivery path is pinned", () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  function seed(db: Db, url: string) {
    const merchant = "0x" + "01".repeat(32);
    db.raw
      .prepare(
        "INSERT INTO orders (id,merchant_id,amount,fee,payout,status,nonce,created_at,expires_at) VALUES ('0xo1',?, '1','0','1','settled','0xn',1,99999999999)",
      )
      .run(merchant);
    db.raw
      .prepare("INSERT INTO deliveries (id,order_id,url,body,attempts,next_attempt_at) VALUES ('d1','0xo1',?,'{}',0,0)")
      .run(url);
  }

  it("rebinding to loopback after validation is not delivered and counts as a failed attempt", async () => {
    let hits = 0;
    srv = createServer((_q, s) => {
      hits += 1;
      s.end("ok");
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const db = new Db(":memory:");
    seed(db, `http://rebind.example.com:${port}/hook`);
    const w = new WebhookWorker(db, "master-secret-1234567", () => 1000, undefined, undefined, {
      lookup: resolverOf([PUBLIC], ["127.0.0.1"]),
      timeoutMs: 300,
      pinConnections: true,
    });
    expect(await w.tick()).toBe(0);
    expect(hits).toBe(0);
  });

  it("delivers to the validated address when allowPrivate is on (local dev) and signs the body", async () => {
    let got: { sig?: string | string[]; body: string } | undefined;
    srv = createServer((q, s) => {
      let b = "";
      q.on("data", (c) => (b += c));
      q.on("end", () => {
        got = { sig: q.headers["quietpay-signature"], body: b };
        s.end("ok");
      });
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const db = new Db(":memory:");
    seed(db, `http://localhost:${port}/hook`);
    const w = new WebhookWorker(db, "master-secret-1234567", () => 1000, undefined, undefined, {
      allowPrivate: true,
      pinConnections: true,
      lookup: async () => [{ address: "127.0.0.1" }],
    });
    expect(await w.tick()).toBe(1);
    expect(got?.body).toBe("{}");
    expect(got?.sig).toBeTruthy();
  });
});
