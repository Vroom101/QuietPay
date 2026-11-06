import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

test("checks out from the catalog and shows a receipt after a signed webhook", async ({ page, request }) => {
  await page.goto("/");
  const notebook = page.getByText("Dot Notebook", { exact: true }).locator("..");
  await notebook.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("link", { name: "Checkout", exact: true }).click();
  await page.getByRole("button", { name: "Pay 8.50 USDT", exact: true }).click();
  await page.locator("quietpay-checkout").getByRole("button", { name: "Pay 8.50 USDT", exact: true }).click();

  await expect(page).toHaveURL(/\/success\/0x[0-9a-f]{64}$/);
  await expect(page.getByTestId("shop-status")).toContainText("confirming your payment");

  // The mock relayer settles orders but does not deliver webhooks.
  const orderId = new URL(page.url()).pathname.split("/").pop();
  const orderResponse = await request.get(`http://localhost:8787/v1/orders/${orderId}`);
  expect(orderResponse.ok()).toBe(true);
  const order = await orderResponse.json();
  expect(order).toMatchObject({ status: "settled", amount: "8500000" });
  await run(process.execPath, ["--import", "tsx", "scripts/simulate-webhook.ts", order.id, order.amount], {
    env: { ...process.env, PORT: "3001", QUIETPAY_MERCHANT_ID: "", QUIETPAY_WEBHOOK_SECRET: "dev-webhook-secret" },
  });

  await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
  await expect(page.getByText("8.50", { exact: true })).toBeVisible();
  await expect(page.getByText(order.txHash, { exact: true })).toBeVisible();
});
