import type { Db } from "@quietpay/relayer/core";
export interface PaymentRow {
  id: string;
  payer: string;
  nonce: string;
  merchant_id: string;
  resource: string;
  pay_to: string;
  amount: string;
  fingerprint: string;
  request: string;
  status: "settling" | "settled" | "failed";
  tx_hash: string | null;
  error_reason: string | null;
  created_at: number;
  delivered_at: number | null;
  delivery_attempts: number;
  lease_token: string | null;
  lease_until: number | null;
}
export class PaymentStore {
  constructor(readonly db: Db) {}
  get(id: string) {
    return this.db.raw
      .prepare("SELECT * FROM x402_payments WHERE id=?")
      .get(id) as PaymentRow | undefined;
  }
  pending() {
    return this.db.raw
      .prepare("SELECT * FROM x402_payments WHERE status='settling'")
      .all() as PaymentRow[];
  }
  insert(row: PaymentRow) {
    this.db.raw
      .prepare(
        `INSERT INTO x402_payments
    (id,payer,nonce,merchant_id,resource,pay_to,amount,fingerprint,request,status,tx_hash,error_reason,created_at,delivered_at,delivery_attempts,lease_token,lease_until)
    VALUES (@id,@payer,@nonce,@merchant_id,@resource,@pay_to,@amount,@fingerprint,@request,@status,@tx_hash,@error_reason,@created_at,@delivered_at,@delivery_attempts,@lease_token,@lease_until)`,
      )
      .run(row);
  }
  failed(id: string, reason: string) {
    this.db.raw
      .prepare(
        "UPDATE x402_payments SET status='failed',error_reason=? WHERE id=? AND status='settling'",
      )
      .run(reason, id);
  }
}
