import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, pad, toHex, type Address, type Hex } from "viem";
import {
  decodeX402Header,
  encodeX402Header,
  X402Payload,
} from "@quietpay/shared";
import {
  createAgent,
  AUTHORIZATION_USED_TOPIC,
  TRANSFER_TOPIC,
  type AgentOptions,
  type ChainEvidence,
  type FacilitatorLookup,
  type FacilitatorStatus,
  type ReceiptEvidence,
  type StoreConfig,
} from "../src/index.js";

export const account = privateKeyToAccount(("0x" + "11".repeat(32)) as Hex);
export const asset = "0x2222222222222222222222222222222222222222" as Address;
export const payTo = "0x3333333333333333333333333333333333333333" as Address;
export const evil = "0x4444444444444444444444444444444444444444" as Address;
export const SECRET = "test-store-secret-0123456789";
export const base = "https://api.example";

export function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), "b-build-w7-"));
  return {
    dir,
    path: join(dir, "agent", "state.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    },
  };
}

const addrTopic = (a: string) => pad(a as Hex, { size: 32 });
export class World {
  now = 1_000_000n;
  finalized = 1_000_000n;
  used = new Map<string, Hex>();
  cancelled = new Set<string>();
  receipts = new Map<Hex, ReceiptEvidence>();
  submits: { nonce: Hex; idem: string | null; sig: Hex }[] = [];
  mode: "settle" | "reject" | "drop" | "pending" = "settle";
  fac: { status: FacilitatorStatus; transaction?: Hex } | "down" = {
    status: "unknown",
  };
  amount = "10000";
  maxTimeout = 60;
  chainDown = false;
  private n = 0;
  readonly unauthRequests: string[] = [];

  settle(nonce: Hex, to: Address = payTo, value = this.amount, payer = account.address): Hex {
    const tx = keccak256(toHex(`tx-${++this.n}-${nonce}`));
    this.used.set(nonce.toLowerCase(), tx);
    this.receipts.set(tx, {
      success: true,
      logs: [
        {
          address: asset,
          topics: [AUTHORIZATION_USED_TOPIC, addrTopic(payer), nonce],
          data: "0x",
        },
        {
          address: asset,
          topics: [TRANSFER_TOPIC, addrTopic(payer), addrTopic(to)],
          data: pad(toHex(BigInt(value)), { size: 32 }),
        },
      ],
    });
    return tx;
  }
  /** Mark nonce used by someone else's tx with no matching Transfer (like cancelAuthorization). */
  cancel(nonce: Hex): Hex {
    const tx = keccak256(toHex(`cancel-${++this.n}-${nonce}`));
    this.used.set(nonce.toLowerCase(), tx);
    this.cancelled.add(nonce.toLowerCase());
    this.receipts.set(tx, {
      success: true,
      logs: [
        {
          address: asset,
          topics: ["0x" + "ee".repeat(32) as Hex, addrTopic(account.address), nonce],
          data: "0x",
        },
      ],
    });
    return tx;
  }

  chain: ChainEvidence = {
    latestTimestamp: async () => {
      if (this.chainDown) throw new Error("rpc down");
      return this.now;
    },
    finalizedTimestamp: async () => {
      if (this.chainDown) throw new Error("rpc down");
      return this.finalized;
    },
    authorizationUsedAtFinalized: async (_t, _p, nonce) => {
      if (this.chainDown) throw new Error("rpc down");
      return this.used.has(nonce.toLowerCase());
    },
    findAuthorizationUsedTx: async (_t, _p, nonce) =>
      this.used.get(nonce.toLowerCase()) ?? null,
    getReceipt: async (tx) => this.receipts.get(tx) ?? null,
    listUsedNonces: async () => [...this.used.keys()] as Hex[],
  };
  facilitator: FacilitatorLookup = {
    status: async () => {
      if (this.fac === "down") throw new Error("facilitator down");
      return this.fac;
    },
  };

  challenge(url: string) {
    return new Response("{}", {
      status: 402,
      headers: {
        "PAYMENT-REQUIRED": encodeX402Header({
          x402Version: 2,
          resource: { url },
          accepts: [
            {
              scheme: "exact",
              network: "eip155:1874",
              asset,
              amount: this.amount,
              payTo,
              maxTimeoutSeconds: this.maxTimeout,
              extra: {
                name: "Tether USD",
                version: "1",
                assetTransferMethod: "eip3009",
                paymentFlow: "upfront",
              },
            },
          ],
        }),
      },
    });
  }
  fetch = (async (url: string, init?: RequestInit) => {
    const header = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    if (!header) {
      this.unauthRequests.push(url);
      return this.challenge(url);
    }
    const p = decodeX402Header(header, X402Payload);
    const nonce = p.payload.authorization.nonce as Hex;
    this.submits.push({
      nonce,
      idem: new Headers(init?.headers).get("Idempotency-Key"),
      sig: p.payload.signature as Hex,
    });
    const reply = (r: Record<string, unknown>, status = 200) =>
      new Response('{"ok":true}', {
        status,
        headers: { "PAYMENT-RESPONSE": encodeX402Header(r) },
      });
    if (this.mode === "drop") throw new Error("connection reset");
    if (this.mode === "reject")
      return reply(
        { success: false, errorReason: "invalid_signature", transaction: "", network: "eip155:1874" },
        402,
      );
    const tx = this.used.get(nonce.toLowerCase()) ?? this.settle(nonce, p.payload.authorization.to as Address, p.payload.authorization.value);
    if (this.mode === "pending")
      return reply({
        success: false,
        errorReason: "settlement_pending",
        transaction: tx,
        network: "eip155:1874",
      }, 402);
    return reply({
      success: true,
      transaction: tx,
      payer: account.address,
      network: "eip155:1874",
    });
  }) as unknown as typeof fetch;

  config(path: string, patch: Partial<StoreConfig> = {}): StoreConfig {
    return {
      path,
      secret: SECRET,
      chain: this.chain,
      facilitator: this.facilitator,
      ...patch,
    };
  }
  agent(path: string, patch: Partial<AgentOptions> = {}, store: Partial<StoreConfig> = {}) {
    return createAgent({
      signer: {
        address: account.address,
        signTypedData: (d) => account.signTypedData(d),
      },
      chainId: 1874,
      asset,
      domainName: "Tether USD",
      domainVersion: "1",
      allowedOrigins: [base],
      allowedPayTo: [payTo],
      perCallLimit: 20000n,
      sessionBudget: 30000n,
      fetch: this.fetch,
      store: this.config(path, store),
      ...patch,
    });
  }
}
export const url = `${base}/v1/quote`;
export const url2 = `${base}/v1/other`;
