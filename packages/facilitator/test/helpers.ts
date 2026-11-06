import {
  buildAgentAuthorization,
  makePaidPolicies,
  type FacilitatorRequest,
} from "@quietpay/shared";
import type {
  ChainPort,
  TransferArgs,
  PreparedTx,
  TxReceipt,
  ExternalSettlement,
} from "@quietpay/relayer/core";
import {
  makeEnv,
  MERCHANT_ID,
  PAYOUT,
  USDT,
  payer,
} from "../../relayer/test/helpers.js";
import { FacilitatorService } from "../src/service.js";
import type { Hex } from "viem";
export { MERCHANT_ID, payer };
export const nonce = (n: number) =>
  ("0x" + n.toString(16).padStart(64, "0")) as Hex;
export function setup(
  over: Parameters<typeof makeEnv>[0] = {},
  options: { waitMs?: number } = {},
) {
  const e = makeEnv(over),
    chain: ChainPort = e.chain;
  const policies = makePaidPolicies({
    baseUrl: "https://api.test",
    merchantId: MERCHANT_ID,
    payTo: PAYOUT,
    asset: USDT,
    chainId: 1874,
    name: "Tether USD",
    version: "1",
  });
  const state = {
    balance: 100_000_000n,
    used: new Set<string>(),
    hold: false,
    never: false,
    simulationFails: false,
    broadcastFails: false,
    missingLog: false,
    /** A third party submits the signed authorization first: when we broadcast, the nonce is already used and our tx reverts. */
    frontRun: false,
    /** On the Nth simulateTransfer call the nonce is already used (the foreign tx landed before we sent). */
    usedAtSimulateCall: 0,
    simulateCalls: 0,
    /** What the chain reports about a non-facilitator tx that consumed the nonce. */
    external: { kind: "none" } as ExternalSettlement,
    externalLookups: 0,
    sent: [] as PreparedTx[],
    prepared: [] as { tx: PreparedTx; args: TransferArgs }[],
    release: undefined as (() => void) | undefined,
  };
  chain.getTokenBalance = async () => state.balance;
  chain.authorizationUsed = async (_payer, n) => state.used.has(n);
  chain.simulateTransfer = async (args) => {
    state.simulateCalls++;
    if (state.usedAtSimulateCall && state.simulateCalls >= state.usedAtSimulateCall) {
      state.used.add(args.nonce);
      throw new Error("authorization is used");
    }
    if (state.simulationFails) throw new Error("simulation failed");
    return 100_000n;
  };
  chain.findExternalSettlement = async () => {
    state.externalLookups++;
    return state.external;
  };
  chain.prepareTransfer = async (args, gas, gasPrice, replacementNonce) => {
    const tx: PreparedTx = {
      hash: nonce(10000 + state.prepared.length),
      raw: nonce(10000 + state.prepared.length),
      nonce:
        replacementNonce ?? e.chain.signed.length + state.prepared.length,
      gas,
      gasPrice,
    };
    state.prepared.push({ tx, args });
    return tx;
  };
  const broadcast = e.chain.broadcast.bind(e.chain);
  chain.broadcast = async (raw) => {
    const prepared = state.prepared.find((p) => p.tx.raw === raw);
    if (!prepared) return broadcast(raw);
    if (!state.sent.some((t) => t.hash === prepared.tx.hash))
      state.sent.push(prepared.tx);
    if (state.frontRun) state.used.add(prepared.args.nonce);
    if (state.broadcastFails) throw new Error("Lost send response");
    return prepared.tx.hash;
  };
  const receipt = (hash: Hex): TxReceipt => {
    const p = state.prepared.find((p) => p.tx.hash === hash)!;
    state.used.add(p.args.nonce);
    if (state.frontRun)
      return {
        status: "reverted",
        blockNumber: 2n,
        gasUsed: 60000n,
        effectiveGasPrice: p.tx.gasPrice,
        transfers: [],
      };
    return {
      status: "success",
      blockNumber: 1n,
      gasUsed: 100000n,
      effectiveGasPrice: p.tx.gasPrice,
      transfers: state.missingLog
        ? []
        : [
            {
              token: USDT,
              from: p.args.from,
              to: p.args.to,
              value: p.args.value,
              logIndex: 0,
            },
          ],
    };
  };
  const get = e.chain.getReceipt.bind(e.chain),
    wait = e.chain.waitForReceipt.bind(e.chain);
  chain.getReceipt = async (hash) =>
    state.prepared.some((p) => p.tx.hash === hash)
      ? state.hold
        ? null
        : receipt(hash)
      : get(hash);
  chain.waitForReceipt = async (hash) => {
    if (!state.prepared.some((p) => p.tx.hash === hash)) return wait(hash);
    if (state.never)
      return new Promise((resolve) => {
        state.release = () => resolve(receipt(hash));
      });
    if (state.hold) throw new Error("receipt pending");
    return receipt(hash);
  };
  const service = new FacilitatorService(e.svc, {
    policies,
    settlementWaitMs: options.waitMs ?? 20,
    leaseSeconds: 3,
  });
  const request = async (n = 1): Promise<FacilitatorRequest> => {
    const a = {
      from: payer.address,
      to: PAYOUT,
      value: "10000",
      validAfter: "0",
      validBefore: String(e.clock.t + 55),
      nonce: nonce(n),
    };
    const signature = await payer.signTypedData(
      buildAgentAuthorization({
        from: a.from,
        to: a.to,
        value: 10000n,
        validAfter: 0n,
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      }),
    );
    return {
      x402Version: 2,
      paymentRequirements: policies[0]!.requirements,
      paymentPayload: {
        x402Version: 2,
        resource: policies[0]!.resource,
        accepted: policies[0]!.requirements,
        payload: { authorization: a, signature },
      },
    };
  };
  return { ...e, chain, state, policies, service, request };
}
