# Mutation sample (B3)

43 hand-picked mutants across relayer `service.ts`, `ratelimit.ts`, `server.ts`, facilitator `service.ts` and the merchant-sdk paywall, run one at a time in a scratch copy of the repo (resumable runner, results kept outside the repo). A mutant is killed when the owning package's suite (plus facilitator and paid-api for `server.ts`) fails.

First clean pass: 25 killed, 18 survived. Of those, 4 were runner artefacts (route-matrix tests live in the facilitator package; the runner now runs it for `server.ts` mutants) and 11 were real test gaps, each closed by a new test (`mutation-kills.test.ts` in relayer and facilitator, `audit-b2.test.ts` in merchant-sdk): amount mismatch, validAfter boundary, merchant isolation, payee mismatch, pause race during simulation, finish idempotence on a failed row, payer cap boundary, expiry boundary, refunded re-pay, per-order rate limit, refused delivery claim.

Final: **38 killed, 5 survivors, all justified as equivalent or defence in depth** (no input changes the observable outcome):

| Mutant | Why it survives |
|---|---|
| R10 drop `isAddress(payer)` | A non-address payer fails the signature recovery check immediately after with the same `bad_signature`. |
| R12 only `settled` blocks re-pay | The claim step (`claimForRelay`) refuses refunded and partially refunded orders with the same `already_settled`. |
| F7 ignore pause in `sendLocked` | The broadcast itself is guarded again by `!svc.localPaused` (service.ts, send path), so nothing is sent; only the error label differs. |
| F8a / F8b drop a replay check | The unique `(payer, nonce)` index and the post-lock check give the same `payment_replayed`; the property test shows one broadcast per authorization. |

A survivor list of zero is not claimed: these five are judged equivalent by reading, not proven.
