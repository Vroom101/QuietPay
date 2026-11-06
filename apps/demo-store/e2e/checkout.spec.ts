import { expect, test } from "@playwright/test";

test("retries a delayed or failed receipt check using the same order ID", async ({ page }) => {
  const orderId = `0x${"33".repeat(32)}`;
  let status = 200;
  let paid = false;
  await page.clock.install();
  await page.route(`**/api/orders/${orderId}/paid`, (route) => route.fulfill({
    status, json: paid ? { paid: true, amount: "8500000", paidAt: 1_800_000_000 } : { paid: false },
  }));
  await page.goto(`/success/${orderId}`);
  await expect(page.getByRole("heading", { name: "Processing payment" })).toBeVisible();
  await page.clock.fastForward(12_100);
  await expect(page.getByTestId("shop-status")).toContainText("still waiting for confirmation");
  status = 503;
  await page.getByRole("button", { name: "Check payment status" }).click();
  await expect(page.getByTestId("shop-status")).toContainText("couldn't check");
  await expect(page.getByLabel("Order ID")).toHaveText(orderId);
  status = 200;
  paid = true;
  await page.getByRole("button", { name: "Check payment status" }).click();
  await page.clock.runFor(700);
  await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
  await expect(page).toHaveURL(`/success/${orderId}`);
});

test("checks out from the catalog and shows a receipt after a signed webhook", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Dot Notebook to cart", exact: true }).click();
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your cart" })).toBeVisible();
  await page.getByRole("button", { name: "Add one Dot Notebook" }).click();
  await expect(page.getByLabel("Order summary")).toContainText("17.00 USDT");
  await page.getByRole("button", { name: "Remove one Dot Notebook" }).click();
  await page.getByRole("link", { name: "Proceed to checkout" }).click();
  await page.getByRole("radio", { name: "USDT", exact: true }).check();
  await page.getByRole("button", { name: "Review payment details", exact: true }).click();
  await expect(page.locator("quietpay-checkout").getByText("Merchant relay fee")).toBeVisible();
  await page.locator("quietpay-checkout").getByRole("button", { name: "Pay 8.50 USDT", exact: true }).click();

  await expect(page).toHaveURL(/\/success\/0x[0-9a-f]{64}$/);
  await expect(page.getByTestId("shop-status")).toContainText("confirming your payment");

  const orderId = new URL(page.url()).pathname.split("/").pop();
  const orderResponse = await request.get(`http://localhost:8787/v1/orders/${orderId}`);
  expect(orderResponse.ok()).toBe(true);
  const order = await orderResponse.json();
  expect(order).toMatchObject({ status: "settled", amount: "8500000" });
  await expect(page.getByRole("heading", { name: "Payment receipt" })).toBeVisible();
  await page.getByRole("button", { name: "View payment details" }).click();
  await expect(page.getByText("8.50", { exact: true })).toBeVisible();
  await expect(page.getByText(order.txHash, { exact: true })).toBeVisible();
});

test("reviews a stablecoin quote and receives a clearly labeled demo receipt", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Add Dot Notebook to cart", exact: true }).click();
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  await page.getByRole("link", { name: "Proceed to checkout" }).click();
  await expect(page.getByRole("radio", { name: "Stablecoin Demo" })).toBeChecked();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "Review payment details" }).click();
  await expect(page.getByText("8.40 USDT", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm 8.50 DEMO" }).click();
  await expect(page.getByRole("heading", { name: "Demo receipt" })).toBeVisible();
  await expect(page.getByText("Simulated conversion complete. No funds moved.")).toBeVisible();
  await page.getByRole("link", { name: "View orders" }).click();
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Items ordered" })).toContainText("Dot Notebook");
  await page.reload();
  await page.getByRole("link", { name: "View payment details" }).click();
  await expect(page.getByText("8.40 USDT", { exact: true })).toBeVisible();
});
