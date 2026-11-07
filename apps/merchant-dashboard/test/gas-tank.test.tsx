// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GasTank } from "../src/GasTank";

let root: Root, container: HTMLDivElement;
const HASH = "0x" + "ab".repeat(32);
const PAYOUT = "0xAbCdEf0000000000000000000000000000000001";
const RELAYER = "0x" + "11".repeat(20);
const base = {
  merchantId: "m", relayer: RELAYER, payout: PAYOUT, creditedWei: "5000000000000000000", spentWei: "1000000000000000000",
  balanceWei: "4000000000000000000", lowBalance: false, avgGasPerOrderWei: "1000000000000000", paymentsLeft: 4000, minConfirmations: 2, topUps: [],
};
const topUp = { txHash: HASH, from: PAYOUT, wei: "2500000000000000000", block: 5, creditedAt: 1700000000 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === name)!;
const input = (placeholder: string) => container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (b: HTMLElement) => act(async () => { b.click(); });

type Provider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
function wallet(over: Record<string, unknown> = {}): { provider: Provider; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      request: async (a) => {
        calls.push(a.method);
        const v = over[a.method];
        if (v && typeof v === "object" && "code" in v) throw v;
        if (a.method in over) return v;
        return ({ eth_requestAccounts: [PAYOUT.toLowerCase()], eth_chainId: "0x752", eth_sendTransaction: HASH } as Record<string, unknown>)[a.method];
      },
    },
  };
}

async function mount(account: object, opts: { post?: () => Response; provider?: Provider } = {}) {
  const f = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? opts.post!() : json(account)));
  vi.stubGlobal("fetch", f);
  await act(async () => root.render(<GasTank merchantUrl="/api/merchant" token="tok" provider={opts.provider} />));
  await flush();
  return f;
}

it("shows balance, payments left, credited vs spent and the explainer", async () => {
  await mount(base);
  const text = container.textContent!;
  expect(container.querySelector("[data-testid=gas-balance]")!.textContent).toBe("4 WBT");
  expect(container.querySelector("[data-testid=gas-left]")!.textContent).toBe("≈ 4000 payments left");
  expect(text).toContain("5 WBT");
  expect(text).toContain("1 WBT");
  expect(text).toContain("QuietPay's relayer pays the network gas for your customers' payments and refunds; your gas tank prepays it.");
  expect(container.querySelector("[data-testid=gas-low]")).toBeNull();
});

it("prompts to add gas when payments left is unknown", async () => {
  await mount({ ...base, paymentsLeft: null });
  expect(container.querySelector("[data-testid=gas-left]")!.textContent).toBe("add gas to estimate");
});

it("shows a low-balance warning banner", async () => {
  await mount({ ...base, lowBalance: true });
  expect(container.querySelector("[data-testid=gas-low]")!.textContent).toMatch(/running low/);
});

it("shows a negative balance with a minus", async () => {
  await mount({ ...base, balanceWei: "-1500000000000000" });
  expect(container.querySelector("[data-testid=gas-balance]")!.textContent).toBe("-0.0015 WBT");
});

it("renders the top-up history with a safe explorer link", async () => {
  await mount({ ...base, topUps: [topUp] });
  const row = container.querySelector("[data-testid=topup-row]")!;
  expect(row.textContent).toContain("2.5 WBT");
  expect(row.textContent).toContain("2023-11-14 22:13 UTC");
  const a = row.querySelector("a")!;
  expect(a.href).toBe(`https://explorer.testnet.whitechain.io/tx/${HASH}`);
  expect(a.rel).toContain("noopener");
  expect(a.target).toBe("_blank");
});

it("has a disabled card option and a faucet link", async () => {
  await mount(base);
  const card = [...container.querySelectorAll("button")].filter((b) => b.textContent === "Buy with card");
  expect(card).toHaveLength(1);
  expect(card[0]!.disabled).toBe(true);
  expect(container.textContent).toContain("Available on mainnet. On testnet, get free WBT from the Whitechain faucet");
  const faucet = [...container.querySelectorAll("a")].find((a) => a.textContent === "Whitechain faucet")!;
  expect(faucet.href).toBe("https://faucet.testnet.whitechain.io/");
  expect(faucet.target).toBe("_blank");
  expect(faucet.rel).toContain("noopener");
});

it("validates the amount before enabling the wallet button", async () => {
  await mount(base);
  expect(button("Send WBT from MetaMask").disabled).toBe(true);
  await type(input("1.5"), "0");
  expect(button("Send WBT from MetaMask").disabled).toBe(true);
  await type(input("1.5"), "1e3");
  expect(button("Send WBT from MetaMask").disabled).toBe(true);
  expect(container.textContent).toContain("at most 18 decimals");
  await type(input("1.5"), "0.25");
  expect(button("Send WBT from MetaMask").disabled).toBe(false);
});

it("explains which wallet to use when MetaMask has another account selected", async () => {
  const w = wallet({ eth_requestAccounts: ["0x" + "99".repeat(20)] });
  const f = await mount(base, { provider: w.provider });
  await type(input("1.5"), "1");
  await click(button("Send WBT from MetaMask"));
  await flush();
  expect(container.querySelector("[role=alert]")!.textContent).toBe(`Switch MetaMask to your payout wallet ${PAYOUT}: only top-ups from it are credited`);
  expect(w.calls).not.toContain("eth_sendTransaction");
  expect(f.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
});

it("shows a cancellation when the user rejects in MetaMask", async () => {
  const w = wallet({ eth_sendTransaction: { code: 4001 } });
  await mount(base, { provider: w.provider });
  await type(input("1.5"), "1");
  await click(button("Send WBT from MetaMask"));
  await flush();
  expect(container.querySelector("[role=alert]")!.textContent).toBe("Cancelled in MetaMask");
});

it("sends from MetaMask, waits for confirmations with retries, then shows the credited amount", async () => {
  const answers = [
    () => json({ error: { code: "topup_not_found", message: "n" } }, 404),
    () => json({ error: { code: "topup_unconfirmed", message: "u" } }, 409),
    () => json({ topUp, account: { ...base, balanceWei: "6500000000000000000", topUps: [topUp] } }, 201),
  ];
  const w = wallet();
  const f = await mount(base, { provider: w.provider, post: () => answers.shift()!() });
  vi.useFakeTimers();
  await type(input("1.5"), "2.5");
  await click(button("Send WBT from MetaMask"));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(w.calls).toEqual(["eth_requestAccounts", "eth_chainId", "eth_sendTransaction"]);
  expect(container.querySelector("[role=status]")!.textContent).toBe("Waiting for 2 confirmations…");
  const posts = () => f.mock.calls.filter(([, i]) => i?.method === "POST");
  expect(posts()).toHaveLength(1);
  expect(JSON.parse(posts()[0]![1]!.body as string)).toEqual({ txHash: HASH });
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(posts()).toHaveLength(2);
  expect(container.querySelector("[role=status]")!.textContent).toBe("Waiting for 2 confirmations…");
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(posts()).toHaveLength(3);
  expect(container.querySelector("[role=status]")!.textContent).toBe("Added 2.5 WBT");
  expect(container.querySelector("[data-testid=gas-balance]")!.textContent).toBe("6.5 WBT");
  expect(container.querySelectorAll("[data-testid=topup-row]")).toHaveLength(1);
});

it("credits a pasted hash, and rejects a malformed one without calling the server", async () => {
  const f = await mount(base, { post: () => json({ topUp, account: { ...base, topUps: [topUp] } }, 201) });
  await type(input("0x…"), "0x123");
  await click(button("Credit"));
  expect(container.querySelector("[role=alert]")!.textContent).toMatch(/0x followed by 64 hex/);
  expect(f.mock.calls.filter(([, i]) => i?.method === "POST")).toHaveLength(0);
  await type(input("0x…"), ` ${HASH} `);
  await click(button("Credit"));
  await flush();
  expect(container.querySelector("[role=status]")!.textContent).toBe("Added 2.5 WBT");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("shows the server's message for a wrong-sender top-up", async () => {
  await mount(base, { post: () => json({ error: { code: "topup_wrong_sender", message: "That transfer came from another wallet." } }, 403) });
  await type(input("0x…"), HASH);
  await click(button("Credit"));
  await flush();
  expect(container.querySelector("[role=alert]")!.textContent).toBe("That transfer came from another wallet.");
});

it("shows a load error when the gas account cannot be read", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code: "gas_not_configured", message: "Gas tank not available." } }, 503)));
  await act(async () => root.render(<GasTank merchantUrl="/api/merchant" token="tok" />));
  await flush();
  expect(container.querySelector("[role=alert]")!.textContent).toBe("Gas tank not available.");
});
