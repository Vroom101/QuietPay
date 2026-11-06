# Requirement-to-test map: packages/relayer and packages/merchant-sdk

Paths are relative to `C:\Users\avane\Desktop\QuietPay-b\`. Assertions were confirmed by reading each test body. No tests were run.

Totals: KEEP 26, WEAK 5, MISSING 2.

| Req | Test file | Test name | Verdict | Note |
|---|---|---|---|---|
| R1 | packages/relayer/test/guards.test.ts | order_expired once the order has expired | KEEP | Also covers order_not_found (line 17) and expired payer window (line 36); asserts code and zero broadcasts. |
| R2 | packages/relayer/test/guards.test.ts | bad_signature for a signature by someone else | KEEP | Also covers amount-signed-differently (line 53), wrong nonce (line 61) and window over 10 min (line 69). |
| R3 | packages/relayer/test/guards.test.ts | amount_mismatch when the client echoes a different price | KEEP | Asserts code and zero broadcasts. |
| R4 | packages/relayer/test/guards.test.ts | fee_over_cap when the merchant lowered its cap after the order was created | WEAK | Cap check is proven. The fee==value rejection (service.ts:283, invalid_amount) has no relayer test; shared/test/shared.test.ts:304 covers only the mock server. pentest.test.ts "extra fee/payout/merchantId/value fields in the relay body are ignored" shows the body fee is not used. |
| R5 | packages/relayer/test/guards.test.ts | relayer_paused when the router is paused on chain | KEEP | Sets chain.paused and asserts relayer_paused with zero sends. |
| R6 | packages/relayer/test/guards.test.ts | rate_limited when a payer exceeds the per-payer cap | KEEP | Second 25 USDT order against a 30 USDT cap is refused; one send only. |
| R7 | packages/relayer/test/guards.test.ts | rate_limited after too many requests from one client | KEEP | Service-level per-client limiter, not HTTP. pentest-round9.test.ts:204 also checks 429. |
| R8 | packages/relayer/test/guards.test.ts | simulation_failed when eth_call reverts | KEEP | Zero sends on failure; a retry succeeds once the simulation passes. Also "valid-looking requests that fail simulation never get broadcast". |
| R9 | packages/relayer/test/guards.test.ts | relayer_paused when gas price is over MAX_GAS_PRICE | KEEP | Gas price 1 gwei against a 0.5 gwei cap; zero sends. |
| R10 | packages/relayer/test/guards.test.ts | relayer_paused once the hourly loss budget is exhausted | KEEP | Exactly two relays fit; third refused; budget frees after an hour. |
| R11 | packages/relayer/test/round4-coverage.test.ts | fills the gap with a zero-value self-transfer at a bumped gas price, never re-sends the pay tx, and ends tx_not_sent with no revert charged | KEEP | Gap recovery at the service level. The NonceManager unit test (hardening-r3.test.ts "hands out sequential nonces...") only covers sequencing and resync. |
| R12 | packages/relayer/test/hardening-r3.test.ts | settles an order whose tracker gave up (receipt timeout) and never double-settles | KEEP | Pending stays pending with no receipt, then settles once; asserts settled_at and one webhook. |
| R13 | packages/relayer/test/guards.test.ts | a repeated relay/pay for the same order returns the same hash and broadcasts once | KEEP | Asserts equal txHash and chain.sent length 1. Service-level, not HTTP. |
| R14 | packages/relayer/test/hardening-r3.test.ts | crash after persist, before send: a fresh process rebroadcasts the persisted bytes at max age and settles once | KEEP | Asserts one signed tx, one accepted tx, one payment.settled. The rebroadcast is the same bytes, and only after max age. |
| R15 | packages/relayer/test/hardening-r3.test.ts | uncertain broadcast the node never saw: broadcast_unknown (public: pending), never released, no second signature | KEEP | Send-level RPC error stays unsettled with one signature. Receipt-side outage is covered by R12's test. FakeChain.receiptFails is used only in refunds tests. |
| R16 | (none) | (none) | MISSING | No reorg test. grep for reorg, removed and blockHash finds only a load-balanced-RPC comment at pentest-round4.test.ts:251. Nearest is hardening-r3 "a tx failed as not-mined that lands later is settled after all", which tests the opposite direction. |
| R17 | packages/relayer/test/server.test.ts | signs every attempt, retries failures with backoff, then stops after success | KEEP | Calls verifyWebhookSignature on each attempt's body and header. |
| R18 | packages/relayer/test/server.test.ts | signs every attempt, retries failures with backoff, then stops after success | KEEP | Backoff steps (5 s, then 30 s) and stop-after-success asserted. "gives up after the maximum attempts" (same file) asserts 7 attempts. |
| R19 | packages/relayer/test/refunds.test.ts | settles partial and full refunds without overwriting the original payment hash | WEAK | payment.refunded is proven by WebhookEvent.parse, which requires id (line 49). payment.settled id is checked only in e2e-anvil.test.ts, which is skipIf without artifacts. guards.test.ts "moves pending -> settled and queues a webhook" checks type only. server.test.ts:113 is vacuous if id is undefined. payment.failed has no id check. |
| R20 | packages/relayer/test/server.test.ts | metrics and pause need the operator token, and pause blocks relaying | KEEP | 401 without token; pause yields 503 relayer_paused; zero sends. Also guards.test.ts "relayer_paused when the operator pauses the relayer". |
| R21 | packages/relayer/test/server.test.ts | metrics and pause need the operator token, and pause blocks relaying | KEEP | Operator-only access asserted; body checked for paused and rejected.relayer_paused. Does not check full response shape. |
| R22 | packages/relayer/test/server.test.ts | returns frozen codes with matching HTTP status through the API | WEAK | Only amount_mismatch is checked over HTTP here. Other HTTP checks cover bad_signature, relayer_paused, order_not_found, already_settled (e2e-anvil, skipped without artifacts) and rate_limited (pentest-round9). Only error.code is asserted, never message. shared/test/shared.test.ts "has the nine frozen codes..." checks the table, not server output. |
| R23 | packages/relayer/test/refunds.test.ts | checks signer balance before spending gas | WEAK | Calls svc.refunds.submit directly, not /v1/relay/refund. Asserts insufficient_refund_balance and zero prepareRefund calls. Does not assert refund row, spend or webhook unchanged. The check is on token refundBalance, despite the test name. |
| R24 | packages/relayer/test/pentest-round8.test.ts | R8-R1a: on chain 1874 a non-official USDT_ADDRESS must be refused at startup | KEEP | loadConfig rejects a non-qualifying token, router (R8-R1b) and pair (R8-R1c). The same file's baseline test loads the qualifying config, so the rejection comes from the token. Its header comment says the relayer never calls assertQualifyingConfig, but config.ts:133 does, so the comment is stale. |
| R24 | packages/relayer/test/pentest-round9.test.ts | [held] CHAIN_ID spellings cannot reach another chain: 0x752 / ' 1874' are 1874; 31337, 1874.5, '' are refused | KEEP | Chain-id side of the startup refusal. shared/test/shared.test.ts "rejects the wrong chain" tests the function directly. |
| S1 | packages/merchant-sdk/test/sdk.test.ts | sends the API key and returns a validated order | KEEP | Asserts URL, Bearer header, body and order id. |
| S2 | packages/merchant-sdk/test/sdk.test.ts | reads an order without an API key | KEEP | Asserts status "created" and no headers. |
| S3 | packages/merchant-sdk/test/refund.test.ts | signs the remaining amount with the exact authorization and sends no key | KEEP | Recovers the signer from the typed data and checks the key is not sent. |
| S4 | packages/merchant-sdk/test/sdk.test.ts | rejects timestamps older than five minutes | KEEP | now+301 throws, now+299 passes. Future-skew and the exact 300 s boundary are not asserted. |
| S5 | packages/shared/test/pentest.test.ts | uses a constant-time compare (timingSafeEqual), not === | WEAK | Regex over the source of shared/src/webhook.ts, not a behavioral test. The SDK delegates to shared verifyWebhookSignature, which does use timingSafeEqual (webhook.ts:89). No merchant-sdk test. |
| S6 | packages/merchant-sdk/test/sdk.test.ts | rejects a tampered body, wrong secret and missing header | KEEP | Tampered amount rejected; asserts WebhookVerificationError. |
| S7 | packages/merchant-sdk/test/sdk.test.ts | rejects a tampered body, wrong secret and missing header | KEEP | Wrong secret rejected in the same test. |
| S8 | (none) | (none) | MISSING | verifyWebhook (merchant-sdk/src/index.ts:128) keeps no seen-id store. merchant-sdk/test/pentest-round7.test.ts:33 and pentest-round8.test.ts cover the time window, not id dedupe. server.test.ts:112 only comments that receivers dedupe. |
| S9 | packages/merchant-sdk/test/sdk.test.ts | maps relayer errors to QuietpayApiError with the frozen code | KEEP | Asserts instance type, code order_not_found and status 404. |

## MISSING ids
- R16 (reorg after pending)
- S8 (replayed webhook id)


# Requirement-to-test map: packages/facilitator and apps/paid-api

Scope: packages/facilitator/test, apps/paid-api/test, packages/shared/test/x402.test.ts. Paths are relative to C:\Users\avane\Desktop\QuietPay-b. Out-of-scope references are noted where they prove a requirement.

| Req | Test file | Test name | Verdict | Note |
|---|---|---|---|---|
| F1 /supported | packages/facilitator/test/server.test.ts | facilitator HTTP surface > publishes supported kinds and requires resource-server credentials | KEEP | toMatchObject on kinds[0] (x402Version 2, exact, eip155:1874). |
| F2 /verify | packages/facilitator/test/server.test.ts | facilitator HTTP surface > publishes supported kinds and requires resource-server credentials | KEEP | 401 without key and with wrong key; isValid true with key. |
| F3 /settle | packages/facilitator/test/server.test.ts | facilitator HTTP surface > publishes supported kinds and requires resource-server credentials | KEEP | 400 on empty body; success true on valid payload with key. Service-level: service.test.ts "settles once, confirms the exact transfer and prevents completed-payment replay". |
| F4 unique key payer+nonce | none | none | MISSING | UNIQUE(payer,nonce) exists in packages/relayer/src/db.ts:211 but no test asserts it. Settle with same payer+nonce and different fingerprint (service.ts:274-277 returns payment_replayed) is also untested. |
| F5 unique key tx hash | none | none | MISSING | tx_hash TEXT UNIQUE in packages/relayer/src/db.ts:209 has no test. |
| F6 payment_replayed error | packages/facilitator/test/service.test.ts | exact EVM facilitator > settles once, confirms the exact transfer and prevents completed-payment replay | KEEP | Second settle after completed delivery returns errorReason payment_replayed; also verify on used nonce in "rejects expired/future windows, wrong signatures, used nonces and insufficient funds". |
| F7 delivered-time recorded | apps/paid-api/test/app.test.ts | paid API over real HTTP > delivers only after settlement and rejects completed-payment replay | KEEP | vi.waitFor asserts delivered_at equals e.clock.t in x402_payments. |
| F8 wrong network rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects mismatched amount, recipient, network, asset, resource and requirements | KEEP | Mutates payload accepted.network to eip155:1; asserts isValid false only, not the specific reason. |
| F9 wrong asset rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects mismatched amount, recipient, network, asset, resource and requirements | KEEP | Sets paymentRequirements.asset to router; asserts isValid false only. |
| F10 wrong amount rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects mismatched amount, recipient, network, asset, resource and requirements | KEEP | Sets authorization value "1" and requirement amount "1"; asserts isValid false and no prepared tx. |
| F11 wrong recipient rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects mismatched amount, recipient, network, asset, resource and requirements | KEEP | Sets authorization.to to router; asserts isValid false. |
| F12 expired authorization rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects expired/future windows, wrong signatures, used nonces and insufficient funds | KEEP | validBefore = now-1 and validAfter = now+1 both asserted false. Settle-time expiry check (service.ts:361-367) is not covered. |
| F13 FRONT-RUN: third party consumes authorization, our tx reverts but transfer arrived | none | none | MISSING | No test. Code gap: finish() (service.ts:401-434) marks any non-matching or reverted receipt as failed and never checks authorizationState; verify only checks it before send. |
| F14 shared nonce and gas accounting with checkout relayer | packages/facilitator/test/anvil.test.ts | real x402 payment path and shared checkout wallet > settles paid HTTP calls, prevents replay, shares nonce/gas accounting and verifies agent ledger entries | KEEP | Real chain assertions: nonce adjacency (|diff|=1), payAttempts record, spend row count 1. Conditional: describe.skipIf(!ready) needs anvil on PATH and compiled contracts. anvil was not on PATH in this shell, so I did not run it. |
| F15 restart safety, no double send | packages/facilitator/test/service.test.ts | exact EVM facilitator > recovers uncertain sends after reopening the shared database | KEEP | Asserts row becomes settled and prepared length is 1. Restart is simulated by db.serialize() copy, not a process restart. |
| F16 concurrent double settle | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects concurrent identical redemption while one transfer settles | KEEP | Promise.all of two settles: exactly one success, one payment_replayed, one sent tx. Delivery-side concurrency is also in apps/paid-api/test/app.test.ts "never delivers twice for concurrent identical requests". |
| F17 loss budget applies to x402 path | packages/facilitator/test/service.test.ts | exact EVM facilitator > keeps pending agent reservations counted after an hour | KEEP | Asserts second settle errorReason budget_exceeded and one sent tx. The earlier test "shares pause, gas caps, payer caps and hourly loss limits" asserts only success false for lossBudgetWei:1n, not the reason. |
| F18 webhook/resource URL SSRF checks | none in scope | none in scope | MISSING | No SSRF test in facilitator or paid-api. x402.test.ts "refuses a public URL with credentials or an ambiguous path" is credential/path validation, not SSRF. Webhook SSRF is covered out of scope by packages/relayer/test/pentest-round2.test.ts "pentest r2: SSRF filter bypass attempts (held)". Resource URL is operator config with no SSRF filter. |
| P1 402 with v2 headers and no data | apps/paid-api/test/app.test.ts | paid API over real HTTP > advertises both priced resources with canonical v2 challenges and no data | KEEP | Checks 402, decoded x402Version 2, network eip155:1874, body equals JSON, handler not called, nothing sent. |
| P2 delivers only after settlement | apps/paid-api/test/app.test.ts | paid API over real HTTP > delivers only after settlement and rejects completed-payment replay | KEEP | Response is 200 only with PAYMENT_RESPONSE success true; delivered_at recorded. |
| P3 rejects replay of completed payment | apps/paid-api/test/app.test.ts | paid API over real HTTP > delivers only after settlement and rejects completed-payment replay | KEEP | Second request with same headers returns 402 with error payment_replayed; handler called once. |
| P4 wrong price rejected | packages/facilitator/test/service.test.ts | exact EVM facilitator > rejects mismatched amount, recipient, network, asset, resource and requirements | WEAK | Proven only at facilitator service level. No apps/paid-api test sends a wrong-amount payload over HTTP, and the paywall (packages/merchant-sdk/src/paywall.ts) has no test in scope. |
| P5 wrong resource rejected | apps/paid-api/test/app.test.ts | paid API over real HTTP > rejects malformed and wrong-resource payloads without invoking the resource | KEEP | /v1/quote payload sent to /v1/signal returns 400; handler not called; nothing sent. |
| P6 never delivers twice per payment | apps/paid-api/test/app.test.ts | paid API over real HTTP > never delivers twice for concurrent identical requests | KEEP | Concurrent requests give [200, 402]; handler called once; one send. Also "allows one redelivery after resource execution fails following settlement" (handler called after 503, then 402). |
| P7 never delivers before confirmed settlement | apps/paid-api/test/app.test.ts | paid API over real HTTP > returns a pending hash with no data, then delivers without charging twice | KEEP | settlement_pending returns 402 with no data (handler not called). Unknown status returns 503 with no invite: "does not invite a new payment when settlement status is unknown". |

## Counts

- KEEP: 20 (F1, F2, F3, F6, F7, F8, F9, F10, F11, F12, F14, F15, F16, F17, P1, P2, P3, P5, P6, P7)
- WEAK: 1 (P4)
- MISSING: 4 (F4, F5, F13, F18)

