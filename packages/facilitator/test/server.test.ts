import { describe, it, expect } from "vitest";
import { buildServer } from "@quietpay/relayer/core";
import { registerFacilitator } from "../src/server.js";
import { setup } from "./helpers.js";
describe("facilitator HTTP surface", () => {
  it("publishes supported kinds and requires resource-server credentials", async () => {
    const e = setup(),
      app = buildServer(e.svc);
    await registerFacilitator(app, e.service);
    try {
      expect((await app.inject({ url: "/supported" })).json()).toMatchObject({
        kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:1874" }],
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/verify",
            payload: await e.request(),
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/settle",
            payload: await e.request(),
            headers: { authorization: "Bearer wrong" },
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: "Bearer test-key" };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/verify",
            payload: await e.request(),
            headers,
          })
        ).json().isValid,
      ).toBe(true);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/settle",
            payload: {},
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/settle",
            payload: await e.request(),
            headers,
          })
        ).json().success,
      ).toBe(true);
    } finally {
      await app.close();
      e.db.close();
    }
  });
});
