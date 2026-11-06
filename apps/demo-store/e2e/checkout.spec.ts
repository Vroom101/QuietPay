import { expect, test } from "@playwright/test";

test("checks out from the catalog and shows a receipt after a signed webhook", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add Dot Notebook to cart", exact: true }).click();
  await page.getByRole("link", { name: "Checkout", exact: true }).click();
  await page.getByRole("button", { name: "Continue to pay", exact: true }).click();
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
  await page.getByRole("link", { name: "Checkout", exact: true }).click();
  await page.getByLabel("Pay with", { exact: true }).selectOption("demo-stablecoin");
  await page.getByLabel("Enter amount").fill("10.00");
  await expect(page.getByText("10.00 DEMO", { exact: true })).toBeVisible();
  await expect(page.getByText("10.00 USDT", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to pay" })).toBeDisabled();
  await page.getByRole("button", { name: "Use order total" }).click();
  await expect(page.getByLabel("Enter amount")).toHaveValue("8.50");
  await page.getByRole("button", { name: "Continue to pay" }).click();
  await expect(page.getByText("8.40 USDT", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Confirm 8.50 DEMO" }).click();
  await expect(page.getByRole("heading", { name: "Demo receipt" })).toBeVisible();
  await expect(page.getByText("Simulated conversion complete. No funds moved.")).toBeVisible();
  await page.getByRole("link", { name: "View orders" }).click();
  await expect(page.getByRole("heading", { name: "Your orders" })).toBeVisible();
  await expect(page.getByText("Demo complete")).toBeVisible();
  await page.reload();
  await page.getByRole("link", { name: "Payment details" }).click();
  await expect(page.getByText("8.40 USDT", { exact: true })).toBeVisible();
});
