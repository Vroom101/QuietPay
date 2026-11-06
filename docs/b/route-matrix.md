# Route matrix (read-only audit of C:\Users\avane\Desktop\QuietPay-b)

Sources: `packages/relayer/src/server.ts` (buildServer), `packages/facilitator/src/server.ts` (registerFacilitator, mounted on the same Fastify instance by `packages/facilitator/src/main.ts:27-28`), `apps/paid-api/src/app.ts` (buildPaidApi). Fastify 5.12.8 (installed).

Abbreviations: "Merchant key" = `merchantFromKey` (relayer server.ts:135). "Operator" = `operatorOnly` (server.ts:148). "Resource-server key" = facilitator inline preHandler (facilitator server.ts:12-36) plus `merchant()` helper (server.ts:37-38); it uses the same `cfg.apiKeys` map as relayer merchant keys. "Failed-auth limiter" = `authFailLimiter` 10/min per IP (relayer server.ts:62-64).

## Relayer (packages/relayer/src/server.ts), bodyLimit 16384 bytes (line 28)

| Service | Method | Path | Line | Auth (helper) | Public | bodyLimit | Reads JSON body | Rate limit / throttle | CORS (from onRequest, server.ts:34-36) |
|---|---|---|---|---|---|---|---|---|---|
| relayer | GET | /v1/health | 164 | none | yes | 16 KiB (server.ts:28) | no | healthLimiter 60/min/IP (L163, L165) | ACAO *, allow-headers `content-type, authorization`, allow-methods `GET, POST, OPTIONS` |
| relayer | POST | /v1/orders | 171 | Merchant key (`merchantFromKey`, L173) | no | 16 KiB | yes (`CreateOrderRequest.parse`, L175) | ordersLimiter 120/min/IP (L170, L172), then failed-auth limiter | same as above |
| relayer | GET | /v1/orders | 183 | Merchant key (L185) | no | 16 KiB | no | ordersLimiter 120/min/IP (L184) | same |
| relayer | GET | /v1/orders/:id | 190 | **none** | yes | 16 KiB | no | **none at route**; no limiter | same |
| relayer | POST | /v1/relay/pay | 192 | **none** | yes | 16 KiB | yes (`RelayPayRequest.parse`, L193) | service-level `ipLimiter` (service.ts:376) only | same |
| relayer | GET | /v1/orders/:id/refund-context | 197 | Merchant key (L198) | no | 16 KiB | no | failed-auth limiter only | same |
| relayer | GET | /v1/orders/:id/refunds | 202 | Merchant key (L203) | no | 16 KiB | no | failed-auth limiter only | same |
| relayer | POST | /v1/relay/refund | 207 | Merchant key (L208) | no | 16 KiB | yes (`RelayRefundRequest.parse`, L210) | refunds.ts:52 limiter per IP and per merchant (after auth) | same |
| relayer | GET | /v1/refunds/:id | 212 | Merchant key (L213) | no | 16 KiB | no | failed-auth limiter only | same |
| relayer | GET | /v1/metrics | 218 | Operator (`operatorOnly`, L219) | no | 16 KiB | no | failed-auth limiter only | same |
| relayer | POST | /v1/admin/pause | 223 | Operator (L224) | no | 16 KiB | yes (`AdminPauseRequest.parse`, L225) | failed-auth limiter only | same |
| relayer | ALL | any path, method OPTIONS | onRequest L37 | none (short-circuit 204) | yes | n/a | no | none | same |
| relayer | any | unmatched route | default | none | yes | n/a | no | none | default Fastify 404 (no setNotFoundHandler) |

Hooks and handlers (relayer):
- onRequest hook, server.ts:33-38: sets CORS headers on every response (L34-36); returns 204 for any OPTIONS request (L37), before routing.
- setErrorHandler, server.ts:40-56: QuietpayError to its status and body (L41); ZodError to 400 `amount_mismatch` or `bad_signature` (L42-46); 4xx Fastify errors to 400/415 with fixed text (L49-53); anything else to 500 `simulation_failed` (L55).
- No setNotFoundHandler anywhere in the three files.

## Facilitator (packages/facilitator/src/server.ts), registered on the relayer app (main.ts:27-28), so it inherits the 16 KiB limit and the relayer onRequest CORS hook

| Service | Method | Path | Line | Auth (helper) | Public | bodyLimit | Reads JSON body | Rate limit / throttle | CORS (inherited from relayer onRequest) |
|---|---|---|---|---|---|---|---|---|---|
| facilitator | GET | /supported | 49 | none (preHandler returns early for GET, L13) | yes | 16 KiB (inherited) | no | none (L13 skips GET) | ACAO *, `content-type, authorization`, `GET, POST, OPTIONS` |
| facilitator | POST | /verify | 65 | Resource-server key (preHandler L23-35; `merchant()` L37-38) | no | 16 KiB (inherited) | yes (`FacilitatorRequest.safeParse`, L66) | `RateLimiter(rateLimitPerMinute)` keyed by `req.ip`, L11 and L14, checked before auth | same |
| facilitator | POST | /settle | 73 | Resource-server key (L23-35, L84) | no | 16 KiB (inherited) | yes (L74) | same as /verify (L14) | same |
| facilitator | POST | /v1/x402/delivery/claim | 86 | Resource-server key (L87-90) | no | 16 KiB (inherited) | yes (`FacilitatorRequest.parse`, L88) | same (L14) | same |
| facilitator | POST | /v1/x402/delivery/complete | 93 | Resource-server key (L100) | no | 16 KiB (inherited) | yes (z.object, L94-96) | same (L14) | same |
| facilitator | POST | /v1/x402/delivery/release | 93 | Resource-server key (L100) | no | 16 KiB (inherited) | yes (L94-96) | same (L14) | same |
| facilitator | POST | /v1/x402/delivery/renew | 93 | Resource-server key (L100) | no | 16 KiB (inherited) | yes (L94-96) | same (L14) | same |

Hooks and handlers (facilitator):
- preHandler, server.ts:12-36 (child plugin scope, L10): non-GET only; 429 `rate_limited` on limiter miss (L14-22); 401 `unauthorized` when the bearer key is not in `apiKeys` (L23-35). Plain Map lookup (L25), not the constant-time scan the relayer uses (relayer server.ts:128-133).
- setErrorHandler, server.ts:39-48: every error becomes 400 (L41). It overrides the relayer handler for these routes, so QuietpayError status codes and the 415/413 mapping are lost. Oversized bodies return 400, not 413.
- Unmatched paths fall through to the relayer's default 404.

## paid-api (apps/paid-api/src/app.ts), no bodyLimit set (Fastify default), no rate limiter

| Service | Method | Path | Line | Auth (helper) | Public | bodyLimit | Reads JSON body | Rate limit / throttle | CORS (app.ts:18-27, 43) |
|---|---|---|---|---|---|---|---|---|---|
| paid-api | GET | /health | 30 | none | yes | not set (Fastify default) | no | none | ACAO *, allow-headers `content-type, PAYMENT-SIGNATURE`, allow-methods `GET, OPTIONS` |
| paid-api | GET | /v1/quote | 40 (via policies, shared/src/x402.ts:205) | x402 payment gate, `paywall` (merchant-sdk/src/paywall.ts:25, 47); PAYMENT-SIGNATURE header, no API key | yes (paid) | not set | no | none | ACAO * (L18, L43), expose headers (L24-26, L44-47) |
| paid-api | GET | /v1/signal | 40 (via policies, shared/src/x402.ts:206) | x402 payment gate (same) | yes (paid) | not set | no | none | same |
| paid-api | OPTIONS | any path | onRequest L28 | none (204) | yes | n/a | no | none | same |
| paid-api | any | unmatched route | default | none | yes | n/a | no | none | default Fastify 404; no setErrorHandler, no setNotFoundHandler |

Notes: paid-api registers one GET per x402 policy (app.ts:31-84), so the paths come from `makePaidPolicies` (shared/src/x402.ts:204-206). Handler errors are caught and returned as fixed 503 `resource_unavailable` (app.ts:69-81). Paywall challenge responses (paywall.ts:52-70) echo only policy data, not request input.

## Route counts
- Relayer: 11 routes (1 GET health, 2 orders POST/GET, 1 GET orders/:id, 1 POST relay/pay, 1 GET refund-context, 1 GET refunds list, 1 POST relay/refund, 1 GET refunds/:id, 1 GET metrics, 1 POST admin/pause) plus the OPTIONS hook.
- Facilitator: 7 routes (GET /supported, POST /verify, POST /settle, POST /v1/x402/delivery/claim, and POST complete/release/renew).
- paid-api: 3 routes (GET /health, GET /v1/quote, GET /v1/signal), plus the OPTIONS hook.

## Observations

1. **Unauthenticated routes that read or write state.**
   - POST `/v1/relay/pay` (relayer server.ts:192) is public. It calls `svc.relayPay` (service.ts:336), which signs and relays transactions. Its only throttle is the service-level `ipLimiter` (service.ts:376), with no route-level limiter.
   - GET `/v1/orders/:id` (server.ts:190) is public, has no limiter, and returns `svc.getOrder` (service.ts:173-176) for any order ID.
   - GET `/v1/health` (server.ts:164) is public but limited to 60/min per IP. It makes RPC calls.
   - GET `/supported` (facilitator server.ts:49) is public and not rate-limited, but it reads config only.
   - GET `/v1/quote` and `/v1/signal` (paid-api) are public by design and gated by x402 payment.

2. **Authenticated routes behind wildcard CORS.** The relayer onRequest hook (server.ts:34) sets `access-control-allow-origin: *` and allows the `authorization` header on every route. That covers merchant routes (server.ts:171-216), operator routes `/v1/metrics` (L218) and `/v1/admin/pause` (L223), and the facilitator resource-server routes `/verify`, `/settle`, and the delivery routes (facilitator server.ts:65-103), since they share the same app. The wildcard does not allow cookies, but any page that holds a key can call these endpoints cross-origin.

3. **Routes with no explicit body limit, and error messages that echo input.**
   - The relayer and facilitator routes inherit the 16 KiB limit (server.ts:28). The paid-api app sets no bodyLimit (app.ts:16), so it uses Fastify's default of 1 MiB. Its GET routes read no body, so the impact is low.
   - Echo of user input: none of the three apps sets setNotFoundHandler, so unmatched routes get Fastify's default 404 body `Route ${method}:${url} not found` (fastify 5.12.8 `lib/four-oh-four.js:56`). That reflects attacker-controlled method and path, in relayer, facilitator, and paid-api alike.
   - The relayer's error handler (server.ts:40-56) sends fixed messages only. The facilitator error handler (server.ts:39-48) does too, but it places `PaymentError.reason` into `error.code` (L44).
