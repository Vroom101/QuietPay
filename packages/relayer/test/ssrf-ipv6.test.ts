/**
 * SSRF filter: IPv6 transition / translation ranges that can reach IPv4 (or tunnel) targets.
 * Local only, no network. Every test asserts the SAFE behaviour.
 */
import { describe, expect, it } from "vitest";
import { classifyIp, deliveryTargetProblem, webhookUrlProblem } from "../src/webhooks.js";

describe("SSRF: IPv6 transition ranges", () => {
  const refusedUrls = [
    // 6to4 2002::/16 (embeds 127.0.0.1 / 169.254.169.254 / a public v4)
    "http://[2002:7f00:1::]/",
    "http://[2002:a9fe:a9fe::1]/",
    "http://[2002:5db8:d822::1]/",
    // Teredo 2001::/32
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/",
    "http://[2001::1]/",
    // NAT64 local-use 64:ff9b:1::/48
    "http://[64:ff9b:1::7f00:1]/",
    "http://[64:ff9b:1:ffff::a9fe:a9fe]/",
    // IPv4-translated ::ffff:0:a.b.c.d
    "http://[::ffff:0:127.0.0.1]/",
    "http://[::ffff:0:169.254.169.254]/",
    "http://[::ffff:0:93.184.216.34]/",
    "http://[0:0:0:0:ffff:0:7f00:1]/",
  ];
  it.each(refusedUrls)("refuses %j even with private targets allowed", (u) => {
    expect(webhookUrlProblem(u, false)).not.toBeNull();
    expect(webhookUrlProblem(u, true)).not.toBeNull();
  });

  it.each(["2002:7f00:1::", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::a9fe:a9fe", "::ffff:0:127.0.0.1", "::ffff:0:8.8.8.8"])(
    "classifyIp(%j) is forbidden",
    (ip) => {
      expect(classifyIp(ip)).toBe("forbidden");
    },
  );

  it("delivery re-check refuses names resolving to transition addresses", async () => {
    for (const addr of ["2002:7f00:1::", "2001:0:53aa:64c:0:0:0:1", "64:ff9b:1::a00:5", "::ffff:0:10.0.0.5"]) {
      expect(await deliveryTargetProblem("https://hooks.example.com/x", true, async () => [{ address: addr }])).not.toBeNull();
    }
  });

  it("ordinary public IPv6 and well-known NAT64 to a public v4 stay allowed", () => {
    expect(webhookUrlProblem("https://[2606:4700:4700::1111]/hook", false)).toBeNull();
    expect(webhookUrlProblem("https://[2001:4860:4860::8888]/hook", false)).toBeNull(); // 2001:4860::/32, not Teredo
    expect(webhookUrlProblem("https://[64:ff9b::5db8:d822]/hook", false)).toBeNull();
  });
});
