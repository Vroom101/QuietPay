import type { MerchantRefundView } from "@quietpay/shared";

export function decimalAmount(value: string): bigint | undefined {
  if (!/^(0|[1-9][0-9]{0,71})(\.[0-9]{1,6})?$/.test(value)) return undefined;
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return amount > 0n ? amount : undefined;
}
export function preciseUsdt(value: string | bigint) {
  const amount = BigInt(value);
  return `${amount / 1000000n}.${(amount % 1000000n).toString().padStart(6, "0")}`;
}
export function refundProblem(
  state: MerchantRefundView,
  input: string,
): string | undefined {
  if (
    state.requests.some((r) =>
      ["submitting", "unknown", "pending"].includes(r.status),
    ) ||
    state.refunds.some((r) => r.status === "pending")
  )
    return "A refund is being processed. Wait for its status before creating another.";
  const remaining =
    BigInt(state.context.amountPaid) - BigInt(state.context.refunded);
  if (remaining === 0n) return "This payment has been fully refunded.";
  const amount = decimalAmount(input);
  if (amount === undefined)
    return "Enter a positive amount with up to 6 decimal places.";
  if (amount > remaining)
    return "Amount exceeds the remaining refundable balance.";
  if (amount > BigInt(state.context.refundBalance))
    return "Refund wallet balance is too low. Fund the wallet before continuing.";
  return undefined;
}
