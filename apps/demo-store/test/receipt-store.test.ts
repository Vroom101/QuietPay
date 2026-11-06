import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@quietpay/merchant-sdk";
import { orderSettled, webhookSettled } from "@quietpay/shared/fixtures";
import { signWebhook } from "@quietpay/shared/webhook";
import { buildApp } from "../server/app.js";
const apps: ReturnType<typeof buildApp>[] = [], dirs: string[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); for (const d of dirs.splice(0)) rmSync(d,{ recursive: true, force: true }); });
const secret = "merchant-receipt-test-secret";
const request = () => { const body = JSON.stringify(webhookSettled); return { method: "POST" as const, url: "/webhooks/quietpay", payload: body, headers: { "content-type": "application/json", "quietpay-signature": signWebhook(secret,body) } }; };
function setup(path: string, confirmed = true) {
  const getOrder = vi.fn(async () => ({ ...orderSettled, status: confirmed ? "settled" as const : "pending" as const }));
  const app = buildApp({ ...sdk, getOrder }, { baseUrl: "http://relayer.test", apiKey: "test", merchantId: webhookSettled.data.merchantId as `0x${string}`, webhookSecret: secret, receiptDatabasePath: path });
  apps.push(app); return { app, getOrder };
}
describe("durable merchant receipts with main's settlement checks", () => {
  it("retains verified receipts and event deduplication after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(),"qp-merge-receipt-")); dirs.push(dir);
    const path = join(dir,"receipts.db"), first = setup(path);
    expect((await first.app.inject(request())).statusCode).toBe(200);
    expect(first.getOrder).toHaveBeenCalledOnce();
    await first.app.close(); apps.splice(apps.indexOf(first.app),1);
    const second = setup(path);
    expect((await second.app.inject({ url: `/api/orders/${orderSettled.id}/paid` })).json()).toMatchObject({ paid: true, txHash: orderSettled.txHash });
    expect((await second.app.inject(request())).json().duplicate).toBe(true);
    expect(second.getOrder).not.toHaveBeenCalled();
  });
  it("never records a signed settlement event as paid when the relayer still reports pending", async () => {
    const { app } = setup(":memory:",false);
    await app.inject(request());
    expect((await app.inject({ url: `/api/orders/${orderSettled.id}/paid` })).json()).toEqual({ paid: false });
  });
});
