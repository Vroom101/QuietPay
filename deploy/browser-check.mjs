// Drives the REAL storefront UI in Chromium against the running demo stack (deploy/dev-stack.mjs) with an injected
// MetaMask-style wallet, and verifies the frontend -> store -> SDK -> relayer wiring.
//   node --env-file=<gitignored env file> deploy/browser-check.mjs
// Needs PAYER_PRIVATE_KEY and RPC_URL in the env. Nothing from the env is printed. No funds move: the final relay call
// of scenario B is intercepted and answered by this script.
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "apps/demo-store/package.json"));
const { chromium } = require("@playwright/test");
const STORE = process.env.STORE_URL ?? "http://localhost:5173";
const RELAYER = process.env.RELAYER_URL ?? "http://127.0.0.1:8790";
const need = (k) => { const v = process.env[k]; if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const rpcUrl = need("RPC_URL");
const payerKey = need("PAYER_PRIVATE_KEY");

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`); if (!ok) failed += 1; };

async function rpc(method, params) {
  const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Opens a browser tab whose window.ethereum is a MetaMask stand-in backed by `key` (signing happens here, in Node). */
async function openWithWallet(browser, key) {
  const acct = privateKeyToAccount(key);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const calls = [];
  await page.exposeFunction("__wallet", async (method, params) => {
    calls.push(method);
    switch (method) {
      case "eth_requestAccounts": case "eth_accounts": return [acct.address.toLowerCase()];
      case "eth_chainId": return "0x752";
      case "wallet_switchEthereumChain": case "wallet_addEthereumChain": return null;
      case "eth_call": return rpc("eth_call", params);
      case "eth_signTypedData_v4": {
        const t = JSON.parse(params[1]);
        const { EIP712Domain: _d, ...types } = t.types;
        return acct.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message: t.message });
      }
      default: throw new Error(`unsupported ${method}`);
    }
  });
  await page.addInitScript(() => { window.ethereum = { isMetaMask: true, request: ({ method, params }) => window.__wallet(method, params ?? []) }; });
  return { page, acct, calls, close: () => ctx.close() };
}

async function toCheckout(page) {
  await page.goto(`${STORE}/shop`);
  await page.getByRole("button", { name: "Add Dot Notebook to cart", exact: true }).click();
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  await page.getByRole("link", { name: /Proceed to checkout/ }).click();
  await page.getByRole("button", { name: /Review payment details/ }).click();
}

// CHROME_PATH lets you reuse an installed Chromium when Playwright's own download is a different build.
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
try {
  // A. an empty wallet: the payer is told exactly what is missing BEFORE any signature is requested.
  {
    const w = await openWithWallet(browser, generatePrivateKey());
    await toCheckout(w.page);
    await w.page.getByTestId("pay-wallet").click();
    const alert = w.page.getByRole("alert");
    await alert.waitFor({ timeout: 20_000 });
    const text = (await alert.textContent()) ?? "";
    check("A: empty wallet gets a clear balance message", /has 0 USDT/.test(text) && /needs 8\.5 USDT/.test(text), text.slice(0, 120));
    check("A: nothing was signed", !w.calls.includes("eth_signTypedData_v4"));
    await w.close();
  }

  // B. a funded wallet: the UI creates a real order through the store + SDK, the wallet signs, the relay call is captured.
  {
    const w = await openWithWallet(browser, payerKey);
    let relayBody;
    await w.page.route("**/v1/relay/pay", async (route) => {
      relayBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ orderId: relayBody.orderId, status: "pending" }) });
    });
    await toCheckout(w.page);
    const amountShown = await w.page.getByText(/8\.500000 USDT/).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check("B: the store created an order through the SDK and the widget shows the exact amount", amountShown);
    await w.page.getByTestId("pay-wallet").click();
    for (let i = 0; i < 100 && !relayBody; i++) await new Promise((r) => setTimeout(r, 200));
    check("B: the wallet was asked to sign exactly one typed message", w.calls.filter((c) => c === "eth_signTypedData_v4").length === 1);
    check("B: the browser sent the payment to the relayer", !!relayBody);
    if (relayBody) {
      check("B: payer is the connected wallet", relayBody.payer?.toLowerCase() === w.acct.address.toLowerCase());
      const order = await (await fetch(`${RELAYER}/v1/orders/${relayBody.orderId}`)).json();
      const c = order.checkout;
      const recovered = await recoverTypedDataAddress({
        domain: { name: c.domain.name, version: c.domain.version, chainId: c.chainId, verifyingContract: c.token },
        types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        primaryType: "ReceiveWithAuthorization",
        message: { from: relayBody.payer, to: c.router, value: BigInt(c.value), validAfter: BigInt(relayBody.validAfter), validBefore: BigInt(relayBody.validBefore), nonce: c.nonce },
        signature: relayBody.signature,
      });
      check("B: the signature recovers to the wallet over the router's own order data", recovered.toLowerCase() === w.acct.address.toLowerCase());
      check("B: the order is for the official USDT and the qualifying router on chain 1874", c.chainId === 1874 && c.token.toLowerCase() === "0xcedfb56113143d55b2358b8cfbb0deb5ad2f55a7" && c.router.toLowerCase() === "0xb9d475cdd817900b45c356169c6fdc379b942d82");
    }
    await w.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : "\nAll browser checks passed");
process.exit(failed ? 1 : 0);
