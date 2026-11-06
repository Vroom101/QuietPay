# Weak-test sweep: relayer, merchant-sdk, facilitator, paid-api (read-only)

Scope: `packages/relayer/test`, `packages/merchant-sdk/test`, `packages/facilitator/test`, `apps/paid-api/test`.
Format: `file:line | smell | verdict | reason`.

## Config check

- No `vitest.config.*` exists anywhere in the repo. Each package's `test` script is `vitest run` (relayer, paid-api confirmed).
- No `retry` setting in any vitest config, package.json, or CLI flag. Retry is 0 (vitest default).
- CI (`.github/workflows/ci.yml`) installs Foundry, runs `forge build` in `contracts/`, then `pnpm test`. So the anvil artifacts and `anvil` binary should exist in CI. A skip there is therefore a real gap, not a normal path.

## skip / only / todo

packages/relayer/test/chain-anvil.test.ts:34 | describe.skipIf(!hasAnvil) | KEEP (flag) | Legit only if anvil is absent locally. No CI guard, so if `anvil` is missing on the CI runner the whole suite silently skips. Add the same `if (process.env.CI && !hasAnvil) throw` guard that the facilitator suite has.
packages/relayer/test/e2e-anvil.test.ts:38 | describe.skipIf(!haveArtifacts) | FIX | Skips when `contracts/out/*.json` is missing. No CI guard. A failed or misplaced `forge build` would make the end-to-end on-chain test pass vacuously in CI. Add `if (process.env.CI && !haveArtifacts) throw`.
packages/relayer/test/pentest-round3.test.ts:383 | describe.skipIf(!haveArtifacts) | FIX | Same as e2e-anvil:38. This is the malicious-payer on-chain suite, so a silent skip hides real security coverage. Add the CI throw.
packages/facilitator/test/anvil.test.ts:59 | describe.skipIf(!ready) | KEEP | Legitimate: skips only when contracts or anvil are absent locally. It already throws when `CI` is set and the prerequisites are missing (line 56-57), so it cannot silently skip in CI.

Totals: skip 0, .only 0, it.todo 0, skipIf 4 (1 KEEP with flag, 2 FIX, 1 KEEP).

## Tests with no expect / expect(true) / snapshot-only

- No test block in the 4 dirs lacks an assertion. A scripted scan of 331 test blocks found every one with `expect`, `assert`, `toThrow`, `rejects` or `resolves`.
- No `expect(true)`.
- No `toMatchSnapshot` or `toMatchInlineSnapshot`.

Totals: no-expect 0, expect(true) 0, snapshot 0.

## Mocks the function it claims to test

packages/relayer/test/hardening-r3.test.ts:431 | svc.reconcile stub | KEEP | Stubs the reconcile dependency of `startReconciler`, which is the function under test. Correct boundary.
packages/relayer/test/preflight.test.ts:2-3 | vi.mock("viem") replaces createPublicClient | KEEP | The mock replaces only the RPC transport. `preflight` itself runs for real. Acceptable boundary mock.
packages/relayer/test/chain-extensions.test.ts:7-9 | vi.fn readContract/getBlockNumber | KEEP | Fakes the chain client that `chainExtensions` consumes. The SUT is the extension logic.
packages/facilitator/test/helpers.ts:101 | chain.getReceipt override | KEEP | Test-double for the chain boundary, used by facilitator service tests.

Totals: 0 real SUT mocks found. 4 boundary stubs reviewed and kept.

## Hard-coded ports

packages/relayer/test/chain-anvil.test.ts:10 | PORT = 18571 | FIX | Fixed port for anvil. Parallel vitest workers or a stale anvil from a crashed run will collide. Pick a free port or derive it per run.
packages/relayer/test/e2e-anvil.test.ts:35 | PORT = 18545 | FIX | Same collision risk as chain-anvil:10.
packages/relayer/test/e2e-anvil.test.ts:60 | hookServer .listen(18546) | FIX | Fixed webhook receiver port, hard-coded into the webhookUrl at line 129. Use `listen(0)` and read the bound port, as relayer/test/chain.test.ts:25 already does.
packages/relayer/test/pentest-round3.test.ts:371 | PORT = 18557 | FIX | Same as chain-anvil:10.
packages/facilitator/test/anvil.test.ts:52 | rpc = "http://127.0.0.1:20545" | FIX | Fixed anvil port, and the spawn at line 73-74 uses the same literal. Collides with any other run.
packages/facilitator/test/anvil.test.ts:175 | apiUrl "http://127.0.0.1:20547" | FIX | Fixed paid-API port. The facilitator is already listened on port 0 at line 178 and the API is not. Inconsistent. Use `listen({port:0})` and the returned URL.
packages/facilitator/test/anvil.test.ts:197 | api.listen({ port: 20547 }) | FIX | Same as :175. This is the one most likely to collide across parallel runs.

Totals: 7 hard-coded ports, 0 KEEP. 5 are anvil RPC or webhook ports that the anvil suites own.

## Fixed setTimeout sleeps / pause() instead of polling

packages/relayer/test/guards.test.ts:221 | await setTimeout 10ms, then check | FIX | Waits for async relay settlement with a fixed 10 ms sleep. Flaky under load. Poll `svc.getOrder(id).status` with a bounded deadline.
packages/relayer/test/guards.test.ts:237 | setTimeout 10ms, then status === "settled" | FIX | Same as :221.
packages/relayer/test/guards.test.ts:242 | setTimeout 10ms, then status === "failed" and retry | FIX | Same as :221.
packages/relayer/test/server.test.ts:89 | setTimeout 10ms before status read | FIX | Same pattern. Poll the order status.
packages/relayer/test/server.test.ts:124 | setTimeout 10ms before queued webhook check | FIX | Same pattern. Poll the delivery queue.
packages/relayer/test/recovery.test.ts:5 | flush = setTimeout(0), line 19 | FIX | Macrotask flush after recoverPending(). Only works if the recovery is all microtask-driven. Await the promise that recovery returns, or poll.
packages/relayer/test/refunds.test.ts:11 | flush = setTimeout(0) | FIX | Same as recovery.test.ts:5.
packages/relayer/test/pentest-round3.test.ts:401 | readiness loop, 50 x setTimeout 200 | FIX | The anvil readiness loop falls through silently if anvil never answers, and the tests then fail with an unclear error. Throw on exhaustion (as facilitator anvil.test.ts:80 does).
packages/relayer/test/chain-anvil.test.ts:43 | readiness loop, 50 x setTimeout 200 | FIX | Same silent fall-through as pentest-round3:401. Throw on exhaustion.
packages/relayer/test/e2e-anvil.test.ts:50 | readiness loop, 50 x setTimeout 200, `break` on ok | FIX | Same silent fall-through. Throw if `r.ok` is never true.
packages/relayer/test/e2e-anvil.test.ts:179 | poll 100 x setTimeout 100 for status "settled" | KEEP | Bounded poll with an assertion immediately after (line 181). Fails loudly if it never settles.
packages/relayer/test/pentest-round3.test.ts:401/458/478 | waitFinal and wall-clock wait loops (setTimeout 200) | KEEP | Bounded polls. waitFinal (lines 455-463) is a condition poll. Line 478 waits for real chain time to pass validBefore, which is the point of that test.
packages/relayer/test/pentest-round2.test.ts:19 | tick = setTimeout 10 | FIX | Helper used after fire-and-forget calls. Same race as guards.test. Replace with a condition poll.
packages/relayer/test/pentest.test.ts:20 | tick = setTimeout 10 | FIX | Same as pentest-round2:19.
packages/relayer/test/pentest.test.ts:500 | fake fetch with 30 ms delay | KEEP | The delay is the fake endpoint's latency in a concurrency test. The assertion (calls === 1) is deterministic, not a wait.
packages/relayer/test/pentest-round3.test.ts:25, round4:19, round5:19, round6:23, round4-coverage:21 | tick = setTimeout 15 helpers | FIX | Same class as pentest-round2:19. Grouped row: these are one helper per file, used across 65 call sites in 13 relayer files.
packages/relayer/test/hardening-r3.test.ts:19, 437 | tick + vi.useFakeTimers | KEEP | Fake timers for the reconciler interval test, with a comment explaining why. Good pattern.
packages/facilitator/test/service.test.ts:160 | setTimeout 0 flush | FIX | Relies on the settle promise finishing in the same macrotask. Await the settle promise directly or poll.
packages/facilitator/test/service.test.ts:256 | setTimeout 0 flush before recover | FIX | Same as :160.
packages/facilitator/test/anvil.test.ts:58 | pause() = setTimeout 25 in a 60-iteration readiness loop | KEEP | Bounded poll that throws "Anvil failed to start" on exhaustion (line 85). Correct.
packages/facilitator/test/anvil.test.ts:265 | pause() in tx-poll loop | KEEP | Bounded loop that throws when the agent tx never arrives (line 268-270).
packages/facilitator/test/anvil.test.ts:362 | pause() in 100-iteration settle poll | KEEP | Bounded. Assertion on :365 (`status === "settled"`) fails loudly afterwards.

Totals: 19 fixed-sleep or pause hits. 10 FIX as individual rows, 1 grouped FIX (tick helpers across 13 relayer files), 4 KEEP-ish polls and fake-latency cases, 3 KEEP for the facilitator anvil loops. The 3 readiness loops (chain-anvil:43, e2e-anvil:50, pentest-round3:401) need a throw on timeout.

## Date.now / real-clock dependence

packages/relayer/test/pentest-round9.test.ts:345-347 | wall-clock assertion: `waited < 2*timeoutMs + 150` (350 ms) against Date.now | FIX | Timing assertion on real time. It will flake under a loaded runner (the team's own hardening-r3 comment describes exactly this failure). Assert on the delivery order or the number of tarpit attempts, not on elapsed ms.
packages/relayer/test/pentest-round3.test.ts:457-466 | `Date.now()` deadline and `wall()` | KEEP | waitFinal is a bounded poll (30 s). `wall()` is needed because the chain validates against real time. Note the test is real-time bound (up to a few seconds).
packages/relayer/test/pentest-round3.test.ts:478 | while (wall() <= validBefore) sleep 200 | KEEP | Intentional real-time wait so the deadline passes before the block is mined. Documented in the test. Slow but deterministic in intent.
packages/relayer/test/e2e-anvil.test.ts:136 | now = Math.floor(Date.now()/1000) with wall-30 / +300 window | KEEP | Generous validity window on a real chain. Low flake risk.
packages/facilitator/test/anvil.test.ts:219, 318 | Date.now() validBefore | KEEP | Same as e2e-anvil:136. Generous window.

Totals: 5 hits (1 FIX, 4 KEEP).

## Extra: weak assertions (not in the requested list, but found)

packages/merchant-sdk/test/sdk.test.ts:34 | bare `.rejects.toThrow()` (no message or class) | FIX | Passes for any throw, including a crash. Assert on the validation message or QuietpayApiError.
packages/merchant-sdk/test/sdk.test.ts:96 | bare `.rejects.toThrow()` on listOrders | FIX | Same. Check the server-only key error text.
packages/merchant-sdk/test/refund.test.ts:61 | bare `.rejects.toThrow()` | FIX | Same.
packages/merchant-sdk/test/pentest-round7.test.ts:24, 35, 38, 44, 51, 63, 68, 74, 99, 107, 115, 123 | bare `.toThrow()` / `.rejects.toThrow()` on security rejections | FIX (grouped) | Each is a security boundary. A bare throw can pass for the wrong reason (e.g. a TypeError). Pin the error type or message in at least the forged-signature and SSRF cases.
packages/facilitator/test/anvil.test.ts:350 | `expect(checkout.txHash).toBeTruthy()` | FIX | Any non-empty string passes. Use a hash regex `/^0x[0-9a-f]{64}$/`.
packages/relayer/test/guards.test.ts:191 | `expect(a.txHash).toBeDefined()` | FIX | Same as facilitator anvil:350.
packages/relayer/test/recovery.test.ts:15 | `expect(row.raw_tx).toBeTruthy()` | FIX | Weak. Assert the raw tx matches the signed bytes.
packages/relayer/test/refunds.test.ts:108 | `expect(db.attempts(r.id)[0]?.raw).toBeDefined()` | FIX | Weak. Assert the stored attempt equals the sent raw bytes.

## Top 5 FIX items (priority order)

1. packages/relayer/test/e2e-anvil.test.ts:38 and packages/relayer/test/pentest-round3.test.ts:383 (plus chain-anvil.test.ts:34): `skipIf` with no CI guard. Add `if (process.env.CI && !prereq) throw`, as facilitator/test/anvil.test.ts:56 does. These are the on-chain security suites and can go silently vacuous.
2. packages/relayer/test/pentest-round9.test.ts:345-347: wall-clock `waited < 350 ms` assertion, which flakes under load. Assert on behaviour instead.
3. packages/relayer/test/guards.test.ts:221, 237, 242 and packages/relayer/test/server.test.ts:89, 124: fixed 10 ms sleeps before state checks. Replace with a bounded condition poll.
4. Readiness loops at packages/relayer/test/chain-anvil.test.ts:43, e2e-anvil.test.ts:50, pentest-round3.test.ts:401: they fall through silently on timeout. Throw after the last attempt, as facilitator/test/anvil.test.ts:85 does.
5. Hard-coded ports: packages/facilitator/test/anvil.test.ts:175 and :197 (20547), packages/relayer/test/e2e-anvil.test.ts:60 (18546). Switch to `listen({port:0})` and read the bound port, as relayer/test/chain.test.ts:25 does.
