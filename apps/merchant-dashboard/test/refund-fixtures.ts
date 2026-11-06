import { token, type MerchantRefundView } from "@quietpay/shared";
import { orderSettled } from "@quietpay/shared/fixtures";
export function refundState(): MerchantRefundView {
  return {
    context: {
      orderId: orderSettled.id,
      merchantId: orderSettled.merchantId,
      payer: orderSettled.payer!,
      refundSigner: "0x3333333333333333333333333333333333333333",
      amountPaid: "25000000",
      refunded: "5000000",
      refundIndex: 1,
      refundBalance: "6000000",
      chainId: token.chainId,
      token: token.address,
      router: orderSettled.checkout.router,
      domain: token.eip712Domain,
    },
    refunds: [],
    requests: [],
  };
}
