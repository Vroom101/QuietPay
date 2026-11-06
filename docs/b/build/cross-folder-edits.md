# Cross-folder edits (edits outside packages/relayer, merchant-sdk, facilitator, apps/paid-api)

## w5 (customer-facing refund status)
- apps/demo-store/server/app.ts: edited (server side only). Adds the order status token on POST /api/checkout (response header `Quietpay-Order-Token`; JSON body unchanged because existing tests pin its exact shape), the refund branch of POST /webhooks/quietpay (relayer-confirmed, monotonic), a 64 KiB bodyLimit on the webhook route, an optional redacting logger, and the token check on GET /api/orders/:id/paid.
- apps/demo-store/server/customer-refunds.ts, customer-refund-routes.ts, customer-refund-migrations.ts: new.
- apps/demo-store/test/*: new test files only (build-customer-refunds.test.ts, helpers-customer-refunds.ts, features/customer-refunds.feature.test.ts).
- packages/shared/src/schemas.ts: additive exports (see shared-additions.md). packages/shared/test/build-customer-refund-status.test.ts: new.
- Decision (item 7, GET /api/orders/:id/paid): orders created through the new checkout have a stored token hash; for them the token header is required. A missing or wrong token gets exactly the unknown-order answer of this legacy route (200 {"paid":false}) rather than a 404, because an existing test (server.test.ts "does not mark an order paid...") asserts `paid:false` on a checkout-created order without a token, and the identical-to-unknown answer leaks nothing. Orders with no stored token (legacy, or paid only via webhook) keep the old behaviour. The new refund-status route uses the uniform 404 as designed.
