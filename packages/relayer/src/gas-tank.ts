import type { Hex } from "viem";
import { QuietpayError, type CreditGasTopUpResponse, type GasAccount, type GasTopUp } from "@quietpay/shared";
import type { RelayerService } from "./service.js";

/** Listed top-ups and the "low" threshold (balance below this many average paid orders of gas). */
export const GAS_TOPUPS_LISTED = 50;
export const LOW_BALANCE_ORDERS = 20n;

/**
 * Merchant gas tank: prepaid gas credit. A merchant sends native WBT from their registered payout wallet to the
 * relayer address and submits the tx hash; the relayer verifies it on chain and credits it. Balance = credited -
 * spent (all-time gas of the merchant's orders). It is ADVISORY ONLY: a low or negative balance never blocks,
 * delays or rejects a payment or refund.
 */
export class GasTank {
  constructor(private readonly svc: RelayerService) {}

  private minConfirmations(): number {
    return this.svc.cfg.gasTopupMinConfirmations ?? 2;
  }

  private toTopUp(r: { tx_hash: string; from_addr: string; wei: string; block: number; credited_at: number }): GasTopUp {
    return { txHash: r.tx_hash, from: r.from_addr, wei: r.wei, block: r.block, creditedAt: r.credited_at };
  }

  async account(merchantId: string): Promise<GasAccount> {
    const { db, chain } = this.svc;
    const reg = await chain.getMerchant(merchantId as Hex);
    const credited = db.gasCreditedWei(merchantId);
    const { spentWei, paidOrders } = db.gasSpentByMerchant(merchantId);
    const balance = credited - spentWei;
    const avg = paidOrders > 0 ? spentWei / BigInt(paidOrders) : 0n;
    const lowBalance = balance <= 0n || (avg > 0n && balance < LOW_BALANCE_ORDERS * avg);
    const paymentsLeft = avg === 0n ? null : balance <= 0n ? 0 : Number(balance / avg);
    return {
      merchantId: merchantId.toLowerCase(),
      relayer: chain.relayerAddress,
      payout: reg.payout,
      creditedWei: credited.toString(),
      spentWei: spentWei.toString(),
      balanceWei: balance.toString(),
      lowBalance,
      avgGasPerOrderWei: avg.toString(),
      paymentsLeft,
      minConfirmations: this.minConfirmations(),
      topUps: db.gasTopUps(merchantId, GAS_TOPUPS_LISTED).map((r) => this.toTopUp(r)),
    };
  }

  async credit(merchantId: string, txHash: Hex): Promise<CreditGasTopUpResponse> {
    const { db, chain, cfg } = this.svc;
    const hash = txHash.toLowerCase() as Hex;
    // A hash is credited once, to one merchant, ever: a repeat (by anyone) is refused before any RPC work.
    if (db.hasGasTopUp(hash)) throw new QuietpayError("topup_already_credited");
    const tx = await chain.getNativeTransfer(hash);
    if (!tx) throw new QuietpayError("topup_not_found");
    if (tx.chainId !== cfg.chainId) throw new QuietpayError("topup_invalid");
    if (tx.status !== "success") throw new QuietpayError("topup_invalid");
    if (!tx.to || tx.to.toLowerCase() !== chain.relayerAddress.toLowerCase()) throw new QuietpayError("topup_invalid");
    if (tx.value <= 0n) throw new QuietpayError("topup_invalid");
    const reg = await chain.getMerchant(merchantId as Hex);
    if (tx.from.toLowerCase() !== reg.payout.toLowerCase()) throw new QuietpayError("topup_wrong_sender");
    if (tx.confirmations < this.minConfirmations()) throw new QuietpayError("topup_unconfirmed");
    const row = { txHash: hash, merchantId, from: tx.from, wei: tx.value, block: Number(tx.blockNumber), creditedAt: this.svc.now() };
    if (!db.insertGasTopUp(row)) throw new QuietpayError("topup_already_credited");
    return {
      topUp: { txHash: hash, from: tx.from.toLowerCase(), wei: tx.value.toString(), block: row.block, creditedAt: row.creditedAt },
      account: await this.account(merchantId),
    };
  }
}
