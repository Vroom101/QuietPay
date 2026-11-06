// REAL end-to-end in a browser on the Whitechain testnet (chain 1874, official USDT). It spends test USDT:
//   1. a customer pays the cheapest item (8.50 USDT) from a MetaMask-style wallet (gasless; the relayer pays gas)
//   2. the merchant signs in to the dashboard with their wallet (personal_sign challenge) and refunds 3.00 USDT
//   3. the customer's receipt shows the partial refund (token-protected endpoint)
//   4. the merchant refunds the remainder; the receipt shows "Fully refunded"
// Run against the stack from deploy/dev-stack.mjs:
//   CHROME_PATH=<chrome.exe> node --env-file=<gitignored env> deploy/browser-e2e-real.mjs
// Needs PAYER_PRIVATE_KEY, MERCHANT_PAYOUT_PRIVATE_KEY and RPC_URL. Nothing from the env is printed. The refund is paid
// by the merchant refund wallet configured on the store server.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(resolve(root, "apps/demo-store/package.json"))("@playwright/test");
const STORE = process.env.STORE_URL ?? "http://localhost:5173";
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:5174";
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8790";
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const rpcUrl = need("RPC_URL");
const payer = privateKeyToAccount(need("PAYER_PRIVATE_KEY"));
const merchant = privateKeyToAccount(need("MERCHANT_PAYOUT_PRIVATE_KEY"));

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rpc = async (method, params) => {
  const j = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const usdtBalance = async (a) => BigInt(await rpc("eth_call", [{ to: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7", data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const wbt = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
const fmt = (b) => `${b / 1_000_000n}.${(b % 1_000_000n).toString().padStart(6, "0")}`;

async function tab(browser, acct) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.exposeFunction("__wallet", async (method, params) => {
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [acct.address.toLowerCase()];
      case "eth_chainId": return "0x752";
      case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
      case "eth_call": return rpc("eth_call", params);
      case "personal_sign": return acct.signMessage({ message: params[0] });
      case "eth_signTypedData_v4": {
        const t = JSON.parse(params[1]);
        const { EIP712Domain: _d, ...types } = t.types;
        return acct.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
      }
      default: throw new Error(`unsupported ${method}`);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__wallet(method, params ?? []) }; });
  return { page, ctx };
}

const waitFor = async (fn, what, ms = 120_000, step = 1000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(step); }
};
const order = async (id) => (await fetch(`${RELAYER}/v1/orders/${id}`)).json();

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const before = { payerUsdt: await usdtBalance(payer.address), payerWbt: await wbt(payer.address) };
  console.log(`payer ${payer.address} USDT ${fmt(before.payerUsdt)}, WBT ${before.payerWbt} wei`);

  // 1. customer pays
  const cust = await tab(browser, payer);
  await cust.page.goto(`${STORE}/shop`);
  await cust.page.getByRole("button", { name: "Add Dot Notebook to cart", exact: true }).click();
  await cust.page.getByRole("link", { name: "View cart", exact: true }).click();
  await cust.page.getByRole("link", { name: /Proceed to checkout/ }).click();
  await cust.page.getByRole("button", { name: /Review payment details/ }).click();
  await cust.page.getByTestId("pay-wallet").click();
  await cust.page.waitForURL(/\/success\/0x[0-9a-f]{64}/i, { timeout: 150_000 });
  const orderId = cust.page.url().match(/0x[0-9a-fA-F]{64}/)[0];
  check("customer paid from the wallet and landed on the receipt page", true, orderId.slice(0, 14) + "...");
  await cust.page.getByRole("heading", { name: "Payment receipt" }).waitFor({ timeout: 120_000 }).then(
    () => check("the shop confirmed the payment (signed webhook verified by the SDK)", true),
    () => check("the shop confirmed the payment (signed webhook verified by the SDK)", false, "receipt heading never appeared"),
  );
  const paid = await order(orderId);
  check("order is settled on the relayer with the official USDT on chain 1874", paid.status === "settled" && paid.checkout?.chainId === 1874, `status ${paid.status}`);
  const afterPay = { payerUsdt: await usdtBalance(payer.address), payerWbt: await wbt(payer.address) };
  check("customer paid no gas (WBT unchanged)", afterPay.payerWbt === before.payerWbt);
  check("customer USDT dropped by exactly the order amount", before.payerUsdt - afterPay.payerUsdt === BigInt(paid.amount), `${fmt(before.payerUsdt - afterPay.payerUsdt)}`);

  // 2. merchant signs in with their wallet and refunds 3.00
  const mer = await tab(browser, merchant);
  await mer.page.goto(DASH);
  await mer.page.getByRole("button", { name: /Sign in with MetaMask/ }).click();
  await mer.page.getByTestId("wallet-chip").waitFor({ timeout: 30_000 }).then(
    () => check("merchant signed in with their wallet (EIP-4361 style challenge)", true),
    () => check("merchant signed in with their wallet (EIP-4361 style challenge)", false, "no wallet chip in the header"),
  );
  await mer.page.getByRole("button", { name: "Transactions", exact: true }).click();
  const refundButton = mer.page.getByRole("button", { name: "Refund", exact: true }).first();
  await refundButton.waitFor({ timeout: 30_000 });
  check("the new order is listed on the merchant dashboard", true);
  await refundButton.click();
  const doRefund = async (amountText) => {
    if (amountText === "remaining") await mer.page.getByRole("button", { name: "Use remaining amount" }).click();
    else await mer.page.getByLabel("Refund amount (USDT)").fill(amountText);
    await mer.page.getByRole("button", { name: "Review refund" }).click();
    await mer.page.getByRole("button", { name: "Confirm refund" }).click();
  };
  await doRefund("3.00");
  await waitFor(async () => BigInt((await order(orderId)).refunded ?? "0") === 3_000_000n, "3.00 refund to settle");
  check("partial refund of 3.00 USDT settled on chain", true);

  // 3. the customer's receipt shows it
  await cust.page.reload();
  await cust.page.getByTestId("refund-status").waitFor({ timeout: 60_000 }).then(
    async () => {
      const t = (await cust.page.getByTestId("refund-status").textContent()) ?? "";
      check("customer receipt shows 'Partially refunded' with the refunded amount", /Partially refunded/.test(t) && /3\.0/.test(t), t.replace(/\s+/g, " ").slice(0, 90));
    },
    () => check("customer receipt shows 'Partially refunded' with the refunded amount", false, "section not shown"),
  );

  // 4. refund the remainder
  await mer.page.getByRole("button", { name: /Use remaining amount/ }).waitFor({ timeout: 60_000 }).catch(() => {});
  await doRefund("remaining");
  await waitFor(async () => (await order(orderId)).status === "refunded", "order to become refunded");
  check("remaining refund settled: order is fully refunded", true);
  await cust.page.reload();
  await cust.page.getByTestId("refund-status").getByText(/Fully refunded/).waitFor({ timeout: 60_000 }).then(
    () => check("customer receipt shows 'Fully refunded'", true),
    () => check("customer receipt shows 'Fully refunded'", false),
  );
  const end = { payerUsdt: await usdtBalance(payer.address) };
  check("customer ends with all of their USDT back (the relayer fee is the merchant's)", end.payerUsdt === before.payerUsdt, `${fmt(end.payerUsdt)} vs ${fmt(before.payerUsdt)}`);
  await cust.ctx.close(); await mer.ctx.close();
} catch (e) {
  check("run completed without an unexpected error", false, String(e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 200));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll real end-to-end checks passed");
process.exit(failed ? 1 : 0);
