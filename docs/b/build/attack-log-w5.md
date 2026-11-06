# Attack log, stream w5 (customer refund status)
Tests: apps/demo-store/test/build-customer-refunds.test.ts (each attack asserts the secure outcome and fails if the attack worked).
| Finding | Severity | Status |
|---|---|---|
| IDOR: order A read with B's token / no token / unknown id (distinguishable 403 vs 404) | High | Fixed: uniform 404, identical body and headers |
| Token guessing via query string, 31-byte and wrong tokens, duplicate header | High | Fixed: header only, 400 for query token, constant-time digest compare incl. dummy digest |
| Rate-limit bypass using many addresses of one IPv6 /64 | Medium | Fixed: /64 key; failures cost 2 |
| Per-order lockout of the real customer by an attacker | Medium | Mitigated: per-order budget only throttles failed attempts; a valid token is never blocked by it |
| Timing oracle unknown vs wrong token | Low | Fixed (dummy digest); median-ratio test |
| Response leaks secrets/ids (api key, secret, refundSigner, payout, merchantId, refundId, event ids, token hash) | High | Fixed: allowlisted new object, schema .strict() parse before send |
| Mass assignment via checkout body / webhook data | Medium | Rejected: fields ignored, tested |
| Refund replay / reorder / early refund / over-paid / unknown order | High | Fixed: monotonic merge, pending_events, 400 on over-paid or unknown order |
| Tampered body / 301 s timestamp reaching JSON.parse or handler | High | Rejected: HMAC over raw string first (spy proves no parse, no getOrder) |
| Huge / deeply nested webhook body | Medium | Fixed: 64 KiB body limit on the webhook route; nested signed bodies 400 |
| Concurrent duplicate events | Medium | Fixed: id claimed before await; upsert on (order_id, refund_index) |
| Existing: /paid returns payer and txHash for any order id | High | Fixed for tokened orders (see cross-folder-edits.md) |
Not found / rejected: token in Referer (mitigated by Referrer-Policy: no-referrer and header-only transport).
