// REAL payment-link run in a browser against the stack from deploy/dev-stack.mjs (Whitechain Sepolia, official USDT).
// It spends 1 test USDT, gaslessly:
//   1. the merchant signs in to the dashboard with their wallet and creates a one-time 1 USDT payment link (Billing)
//   2. a customer opens the link (no store, no cart), pays with their wallet and lands on the receipt
//   3. the link shows as Paid in the dashboard, and opening it again says it was already paid
//   CHROME_PATH=<chrome.exe> node --env-file=<gitignored env> deploy/browser-paylink-real.mjs
// Needs PAYER_PRIVATE_KEY, MERCHANT_PAYOUT_PRIVATE_KEY and RPC_URL. Nothing from the env is printed.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(resolve(root, "apps/demo-store/package.json"))("@playwright/test");
const DASH = process.env.DASHBOARD_URL ?? "http://localhost:5174";
const STORE = process.env.STORE_URL ?? "http://localhost:5173";
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const rpcUrl = need("RPC_URL");
const payer = privateKeyToAccount(need("PAYER_PRIVATE_KEY"));
const merchant = privateKeyToAccount(need("MERCHANT_PAYOUT_PRIVATE_KEY"));

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };
const rpc = async (method, params) => {
  const j = await (await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};
const usdt = async (a) => BigInt(await rpc("eth_call", [{ to: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7", data: "0x70a08231" + a.slice(2).toLowerCase().padStart(64, "0") }, "latest"]));
const nonce = async (a) => BigInt(await rpc("eth_getTransactionCount", [a, "latest"]));

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

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  const before = { usdt: await usdt(payer.address), nonce: await nonce(payer.address) };

  // 1. merchant creates a link
  const mer = await tab(browser, merchant);
  await mer.page.goto(DASH);
  await mer.page.getByRole("button", { name: /Sign in with MetaMask/ }).click();
  await mer.page.getByTestId("wallet-chip").waitFor({ timeout: 30_000 });
  await mer.page.getByRole("button", { name: "Billing", exact: true }).click();
  const title = `Logo design ${new Date().toISOString().slice(11, 19)}`;
  await mer.page.getByLabel("What is it for?").fill(title);
  await mer.page.getByLabel("Amount (USDT)").first().fill("1.00");
  await mer.page.getByLabel("Description (optional)").fill("Invoice for one logo, sent over WhatsApp");
  await mer.page.getByRole("button", { name: "Create payment link" }).last().click();
  await mer.page.getByTestId("new-link").waitFor({ timeout: 20_000 });
  const url = await mer.page.getByTestId("new-link").getByLabel("Payment link").inputValue();
  check("merchant created a one-time 1 USDT payment link", /\/pay\/link_[0-9a-f]+$/.test(url), url);
  const share = await mer.page.getByTestId("new-link").getByRole("link", { name: /WhatsApp/ }).getAttribute("href");
  check("the link can be shared on WhatsApp", !!share && share.startsWith("https://wa.me/?text=") && share.includes(encodeURIComponent(url)));

  // 2. customer pays through the link
  const cust = await tab(browser, payer);
  await cust.page.goto(url.replace(/^https?:\/\/[^/]+/, STORE));
  await cust.page.getByRole("heading", { name: title }).waitFor({ timeout: 20_000 });
  const shown = ((await cust.page.locator("body").textContent()) ?? "").replace(/\s+/g, " ");
  check("customer sees the merchant, what it is for and the amount", /Quiet Store/.test(shown) && /1\.0+ ?USDT/.test(shown), shown.slice(0, 120));
  await cust.page.getByRole("button", { name: /Pay with stablecoin/ }).click();
  await cust.page.getByTestId("pay-wallet").click({ timeout: 30_000 });
  await cust.page.waitForURL(/\/success\/0x[0-9a-f]{64}/i, { timeout: 150_000 });
  await cust.page.getByRole("heading", { name: "Payment receipt" }).waitFor({ timeout: 120_000 }).then(
    () => check("customer paid and landed on the receipt", true),
    () => check("customer paid and landed on the receipt", false),
  );
  const after = { usdt: await usdt(payer.address), nonce: await nonce(payer.address) };
  check("customer paid exactly 1 USDT and no gas", before.usdt - after.usdt === 1_000_000n && after.nonce === before.nonce);

  // 3. link is paid
  let paid = false;
  for (let i = 0; i < 20 && !paid; i++) {
    await mer.page.reload();
    await mer.page.getByRole("button", { name: "Billing", exact: true }).click();
    const row = mer.page.locator("li, tr").filter({ hasText: title }).first();
    await row.waitFor({ timeout: 20_000 }).catch(() => {});
    paid = /Paid/.test((await row.textContent()) ?? "");
    if (!paid) await mer.page.waitForTimeout(2000);
  }
  check("dashboard shows the link as Paid", paid);
  await cust.page.goto(url.replace(/^https?:\/\/[^/]+/, STORE));
  await cust.page.getByText(/already been paid/i).waitFor({ timeout: 20_000 }).then(
    () => check("opening the one-time link again says it was already paid (no second charge)", true),
    () => check("opening the one-time link again says it was already paid (no second charge)", false),
  );
  await cust.ctx.close(); await mer.ctx.close();
} catch (e) {
  check("run completed without an unexpected error", false, String(e.message).replace(/https?:\/\/\S+/g, "<url>").slice(0, 240));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll real payment-link checks passed");
process.exit(failed ? 1 : 0);
