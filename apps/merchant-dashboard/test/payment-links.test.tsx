// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PaymentLinksPanel } from "../src/PaymentLinksPanel";
import {
  createLink, deactivateLink, listLinks, mailtoUrl, PaymentLinksError, validateAmount, validateDescription, validateExpiryDays, validateTitle, whatsappUrl, type LinkView,
} from "../src/lib/payment-links";

let root: Root, container: HTMLDivElement;
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const link = (over: Partial<LinkView> = {}): LinkView => ({
  id: "lnk1", title: "Logo design", description: null, amount: "12.50", amountBase: "12500000", singleUse: true, status: "active",
  paidCount: 0, expiresAt: null, createdAt: "2026-11-01T10:00:00.000Z", lastPaidOrderId: null, duplicatePayments: 0, ...over,
});
const opts = (f: unknown) => ({ merchantUrl: "/api/merchant/", token: "tok", fetch: f as typeof fetch });

// ---- client ----
it("client maps 401, 503, network, malformed and missing token", async () => {
  await expect(listLinks(opts(vi.fn(async () => json({ error: "no" }, 401))))).rejects.toThrow(/session expired/);
  await expect(listLinks(opts(vi.fn(async () => json({ error: "Payment links are turned off." }, 503))))).rejects.toThrow("Payment links are turned off.");
  await expect(listLinks(opts(vi.fn(async () => { throw new Error("x"); })))).rejects.toThrow(/not reachable/);
  await expect(listLinks(opts(vi.fn(async () => json({}))))).rejects.toThrow(/malformed/);
  await expect(listLinks(opts(vi.fn(async () => json({ links: [{ nope: 1 }] }))))).rejects.toThrow(/malformed/);
  await expect(listLinks(opts(vi.fn(async () => new Response("<html>", { status: 502 }))))).rejects.toThrow("Request failed (502).");
  await expect(listLinks({ merchantUrl: "/m", token: "" })).rejects.toBeInstanceOf(PaymentLinksError);
  await expect(createLink(opts(vi.fn(async () => json({ ok: 1 }, 201))), { title: "a", amount: "1" })).rejects.toThrow(/malformed/);
});
it("createLink and deactivateLink send bearer-authenticated requests", async () => {
  const f = vi.fn(async (_u: unknown, _i?: RequestInit) => json(link(), 201));
  await createLink(opts(f), { title: "Logo", amount: "12.50", singleUse: false, expiresInDays: 7 });
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("/api/merchant/links");
  expect(init!.method).toBe("POST");
  expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok");
  expect(JSON.parse(init!.body as string)).toEqual({ title: "Logo", amount: "12.50", singleUse: false, expiresInDays: 7 });
  await deactivateLink(opts(f), "a/b");
  expect(f.mock.calls[1]![0]).toBe("/api/merchant/links/a%2Fb/deactivate");
  expect(f.mock.calls[1]![1]!.method).toBe("POST");
});

// ---- validation ----
it("validates title, amount, description and expiry edge cases", () => {
  expect(validateTitle("")).not.toBe("");
  expect(validateTitle("   ")).not.toBe("");
  expect(validateTitle("a")).toBe("");
  expect(validateTitle("a".repeat(80))).toBe("");
  expect(validateTitle("a".repeat(81))).not.toBe("");
  for (const ok of ["0.000001", "12.50", "1000000", "1000000.000000", "5"]) expect(validateAmount(ok)).toBe("");
  for (const bad of ["", "0", "0.0", "-1", "1.1234567", "1000000.01", "1e3", "abc", ".5", "1,5", "1."]) expect(validateAmount(bad)).not.toBe("");
  expect(validateDescription("x".repeat(280))).toBe("");
  expect(validateDescription("x".repeat(281))).not.toBe("");
  expect(validateExpiryDays("")).toBe("");
  expect(validateExpiryDays("1")).toBe("");
  expect(validateExpiryDays("90")).toBe("");
  for (const bad of ["0", "91", "-1", "1.5", "abc"]) expect(validateExpiryDays(bad)).not.toBe("");
});

it("builds encoded WhatsApp and email share URLs", () => {
  const url = "https://pay.example/pay/lnk1?a=1&b=2";
  const wa = whatsappUrl("Logo & more", "12.50", url);
  expect(wa.startsWith("https://wa.me/?text=")).toBe(true);
  const text = decodeURIComponent(wa.slice("https://wa.me/?text=".length));
  expect(text).toContain("Logo & more");
  expect(text).toContain("12.50");
  expect(text).toContain(url);
  expect(wa).not.toContain(" ");
  expect(wa.split("?").length).toBe(2);
  const m = mailtoUrl("Logo & more", "12.50", url);
  expect(m.startsWith("mailto:?subject=")).toBe(true);
  const params = new URLSearchParams(m.slice("mailto:?".length));
  expect(params.get("subject")).toContain("Logo & more");
  expect(params.get("body")).toContain(url);
  expect(params.get("body")).toContain("12.50");
});

// ---- panel ----
const mount = async () => { await act(async () => root.render(<PaymentLinksPanel merchantUrl="/api/merchant" token="t" />)); await flush(); };
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const byText = (sel: string, t: string) => [...container.querySelectorAll(sel)].find((e) => e.textContent!.trim() === t);
const setVal = async (sel: string, v: string, proto: object = HTMLInputElement.prototype) => act(async () => {
  const el = container.querySelector(sel)!;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const submit = async () => { await act(async () => { container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); }); await flush(); };

it("shows the explainer, statuses, times paid, receipts and duplicate warning", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ links: [
    link({ id: "a", title: "Active one" }),
    link({ id: "b", title: "Paid one", status: "paid", paidCount: 1, lastPaidOrderId: "ord_7", duplicatePayments: 2 }),
    link({ id: "c", title: "Off one", status: "deactivated", singleUse: false }),
    link({ id: "d", title: "Old one", status: "expired" }),
  ] })));
  await mount();
  const text = container.textContent!;
  expect(text).toContain("No website needed: send a link, your customer pays in USDT with no gas, and the money goes to your payout wallet.");
  for (const s of ["Active", "Paid", "Deactivated", "Expired"]) expect(container.querySelector(`[data-status="${s.toLowerCase()}"]`)!.textContent).toBe(s);
  expect(text).toContain("One-time");
  expect(text).toContain("Reusable");
  expect(text).toContain("2 extra payments to refund");
  const receipt = byText("a", "View receipt") as HTMLAnchorElement;
  expect(receipt.getAttribute("href")).toMatch(/\/success\/ord_7$/);
  expect(receipt.getAttribute("rel")).toBe("noopener noreferrer");
  expect(container.querySelectorAll('[data-testid="duplicate-warning"]').length).toBe(1);
  // Deactivate only for active links.
  expect([...container.querySelectorAll("button")].filter((b) => b.textContent === "Deactivate").length).toBe(1);
});

it("uses singular wording for one extra payment", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ links: [link({ duplicatePayments: 1 })] })));
  await mount();
  expect(container.textContent).toContain("1 extra payment to refund");
});

it("shows the 503 message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Payment links are turned off for this store." }, 503)));
  await mount();
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("Payment links are turned off for this store.");
});

it("validates then creates a link and shows share actions", async () => {
  const f = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === "POST" ? json(link({ id: "new1", title: "Logo & design", amount: "12.50", singleUse: false }), 201) : json({ links: [] }));
  vi.stubGlobal("fetch", f);
  await mount();
  await submit();
  expect(container.textContent).toContain("Title must be 1 to 80 characters.");
  await setVal('input[name="title"]', "Logo & design");
  await setVal('input[name="amount"]', "0");
  await submit();
  expect(container.textContent).toContain("Amount must be greater than 0.");
  await setVal('input[name="amount"]', "12.50");
  await setVal('input[name="expiry"]', "99");
  await submit();
  expect(container.textContent).toContain("Expiry must be");
  await setVal('input[name="expiry"]', "7");
  await click(container.querySelector('input[name="kind"][value="reusable"]'));
  await submit();
  const post = f.mock.calls.find((c) => c[1]?.method === "POST")!;
  expect(JSON.parse(post[1]!.body as string)).toEqual({ title: "Logo & design", amount: "12.50", singleUse: false, expiresInDays: 7 });
  const created = container.querySelector('[data-testid="new-link"]')!;
  expect(created).toBeTruthy();
  expect((created.querySelector("input[readonly]") as HTMLInputElement).value).toMatch(/\/pay\/new1$/);
  const wa = byText('[data-testid="new-link"] a', "Share on WhatsApp") as HTMLAnchorElement;
  const url = (created.querySelector("input[readonly]") as HTMLInputElement).value;
  expect(wa.href).toBe(`https://wa.me/?text=${encodeURIComponent(`Pay 12.50 USDT for Logo & design: ${url}`)}`);
  expect(wa.target).toBe("_blank");
  expect(wa.rel).toBe("noopener noreferrer");
  const mail = byText('[data-testid="new-link"] a', "Email") as HTMLAnchorElement;
  expect(mail.getAttribute("href")!.startsWith("mailto:?subject=")).toBe(true);
  const open = byText('[data-testid="new-link"] a', "Open") as HTMLAnchorElement;
  expect(open.href).toBe(url);
  expect(open.rel).toBe("noopener noreferrer");
  expect(open.target).toBe("_blank");
  // The new link also appears in the list.
  expect(container.textContent).toContain("Logo & design");
});

it("shows a server error from create", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => init?.method === "POST" ? json({ error: "Too many links." }, 429) : json({ links: [] })));
  await mount();
  await setVal('input[name="title"]', "x");
  await setVal('input[name="amount"]', "1");
  await submit();
  expect(container.textContent).toContain("Too many links.");
});

it("copies the link to the clipboard", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("fetch", vi.fn(async () => json({ links: [link()] })));
  await mount();
  await click(byText("button", "Copy link"));
  expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/pay\/lnk1$/));
  expect(container.textContent).toContain("Link copied.");
});

it("deactivate needs confirmation and can be cancelled", async () => {
  const f = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === "POST" ? json(link({ status: "deactivated" })) : json({ links: [link()] }));
  vi.stubGlobal("fetch", f);
  await mount();
  await click(byText("button", "Deactivate"));
  expect(f.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  expect(container.textContent).toContain("Customers will no longer be able to pay");
  await click(byText("button", "Cancel"));
  expect(container.textContent).not.toContain("Customers will no longer be able to pay");
  expect(f.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  await click(byText("button", "Deactivate"));
  await click(byText("button", "Yes, deactivate"));
  const post = f.mock.calls.find((c) => c[1]?.method === "POST")!;
  expect(post[0]).toBe("/api/merchant/links/lnk1/deactivate");
  expect(container.querySelector('[data-status="deactivated"]')!.textContent).toBe("Deactivated");
  expect(byText("button", "Deactivate")).toBeUndefined();
});

it("shows an error when deactivate fails", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => init?.method === "POST" ? json({ error: "nope" }, 500) : json({ links: [link()] })));
  await mount();
  await click(byText("button", "Deactivate"));
  await click(byText("button", "Yes, deactivate"));
  expect(container.querySelector('[role="alert"]')!.textContent).toBe("nope");
  expect(container.querySelector('[data-status="active"]')).toBeTruthy();
});
