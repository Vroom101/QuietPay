#!/usr/bin/env node
// Post-deploy smoke test for the relayer/facilitator. Plain Node 20, no dependencies, never prints a secret.
//
//   SMOKE_BASE_URL=https://quietpay-relayer.onrender.com \
//   SMOKE_API_KEY=<merchant api key> SMOKE_MERCHANT_ID=0x<bytes32> \
//   SMOKE_CHAIN_ID=1874 SMOKE_ROUTER=0xb9D475cdd817900B45C356169c6FdC379B942d82 \
//   node deploy/smoke.mjs
//
// Checks: GET /v1/health reports the expected chain id and router, a relayer address and paused:false;
// POST /v1/orders with the API key creates an order; a wrong key is refused (401); an oversize body is refused (413).
// Exit code 0 only when every check passes. Creating the order is the only write (a 'created' order that nobody pays expires).

const base = (process.env.SMOKE_BASE_URL ?? "").replace(/\/+$/, "");
const apiKey = process.env.SMOKE_API_KEY ?? "";
const merchantId = process.env.SMOKE_MERCHANT_ID ?? "";
const wantChain = Number(process.env.SMOKE_CHAIN_ID ?? "1874");
const wantRouter = (process.env.SMOKE_ROUTER ?? "0xb9D475cdd817900B45C356169c6FdC379B942d82").toLowerCase();
const amount = process.env.SMOKE_AMOUNT ?? "1000000";
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "15000");

if (!base || !apiKey || !/^0x[0-9a-fA-F]{64}$/.test(merchantId)) {
  console.error("set SMOKE_BASE_URL, SMOKE_API_KEY and SMOKE_MERCHANT_ID (0x + 64 hex)");
  process.exit(2);
}

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: String(e?.message ?? e).slice(0, 200) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function call(path, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { ...init, signal: ctl.signal, redirect: "manual" });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}
const post = (body, key) =>
  call("/v1/orders", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body,
  });

await check("health: chain id, router, relayer address, paused:false", async () => {
  const r = await call("/v1/health");
  assert(r.status === 200, `status ${r.status}`);
  const h = r.json ?? {};
  assert(h.ok === true, "ok is not true");
  assert(h.chainId === wantChain, `chainId ${h.chainId} != ${wantChain}`);
  assert(typeof h.router === "string" && h.router.toLowerCase() === wantRouter, `router ${h.router} != ${wantRouter}`);
  assert(/^0x[0-9a-fA-F]{40}$/.test(h.relayer ?? ""), "relayer address missing");
  assert(h.paused === false, `paused is ${h.paused}`);
  return `chain ${h.chainId}, router ${h.router}, relayer ${h.relayer}, block ${h.blockNumber}`;
});

await check("create an order with the API key", async () => {
  const r = await post(JSON.stringify({ merchantId, amount }), apiKey);
  assert(r.status === 201, `status ${r.status}`);
  assert(r.json?.status === "created" && typeof r.json?.id === "string", "unexpected order body");
  return `order ${r.json.id}`;
});

await check("a wrong API key is refused", async () => {
  const r = await post(JSON.stringify({ merchantId, amount }), "smoke-wrong-key-smoke-wrong-key");
  assert(r.status === 401 || r.status === 429, `status ${r.status}`);
  return `status ${r.status}`;
});

await check("an oversize body is refused", async () => {
  const r = await post(JSON.stringify({ merchantId, amount, pad: "x".repeat(200 * 1024) }), apiKey);
  assert(r.status === 413, `status ${r.status}`);
  return "status 413";
});

await check("an error body reveals no stack or path", async () => {
  const r = await call("/v1/does-not-exist");
  assert(r.status === 404, `status ${r.status}`);
  assert(!/node_modules|\.ts:\d+|[A-Za-z]:\\/.test(r.text), "error body looks like it leaks internals");
  return "ok";
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
}
console.log(failed === 0 ? "smoke: all checks passed" : `smoke: ${failed} check(s) failed`);
// Set the exit code and let the event loop drain: process.exit() with sockets open can crash Node on Windows.
process.exitCode = failed === 0 ? 0 : 1;
