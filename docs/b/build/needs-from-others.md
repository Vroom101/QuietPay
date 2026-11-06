# Needs from other streams / UI

## w5 (demo-store UI, owned by someone else; no src edits were made)
1. apps/demo-store/src (checkout page): read the `Quietpay-Order-Token` RESPONSE HEADER of POST /api/checkout and keep it in memory or sessionStorage (never in a URL). The JSON body is unchanged.
2. Anything that polls GET /api/orders/:id/paid for a new order must send `Quietpay-Order-Token: <token>`; without it the answer is `{"paid":false}` forever.
3. A refund-status panel can call GET /api/orders/:id/refund-status with the same header (200 body is the CustomerRefundStatus schema; 404 {"error":"not_found"}; 429 rate_limited). Do not put the token in the query string (400).
4. The token is shown once; if a customer loses it there is no recovery path yet (order_access.rotated_at is reserved for a future rotate endpoint).
