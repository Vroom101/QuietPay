# Attack log (Lead surface, this run)

Earlier rounds on the relayer, widget and demo store are in `pentest-round-1.md`. This log covers the Lead components.
"Clean" means not found by these methods, not proven safe.

| Round | Angle | Component | Tools / attacker | Finding | Severity | Status |
|---|---|---|---|---|---|---|
| L1-R0 | invariants | PaymentRouter | new `PaymentRouterInvariants.t.sol` (128k calls x 3 invariants, pay/refund/donate/warp) | none: router balance equals donations, receipts consistent, relayer earns only fees | n/a | clean |
| L3/L4-R1 | logic, funds flow | indexer, verifier | Opus read-only review | net clamped to zero hid the relay fee lost on a full refund | High (misleads reader) | fixed: `net_usdt` unclamped, ef71f9d |
| L3/L4-R1 | logic | verifier | Opus | omitting `--payto` after stripping deposit rows and re-hashing the sidecar gave OK | High | fixed: sidecar pins router, usdt, payTo; `config_mismatch`, f70a2f2 |
| L3/L4-R1 | logic | verifier | Opus | shrunk range / `confirmations: 0` verified as plain OK | Medium | fixed: `OK (unanchored)` unless `--from/--to/--min-confirmations` given |
| L3/L4-R1 | logic | indexer | Opus | a refund of a payment before `fromBlock` never appears in a later range | High as claimed, accepted as design | documented limitation + pinning test (rows are placed at the `Paid` block) |
| L3/L4-R1 | hardening | indexer, verifier | Opus | `RefundSignerChanged` not in the event-set hash | Low | open (see blocked.md) |
| L3/L4-R1 | hardening | verifier | Opus | quoted CSV cells accepted; `--rpc2` compares ledger logs only; same-tx deposit hiding by a contract relayer | Low | open (see blocked.md) |
| L3/L4-R1 | rejected | indexer, verifier | Opus | fake token / look-alike contract forging a row | n/a | rejected: both filter by router and USDT address |
| L1-R1/R3 | logic, token behaviour | PaymentRouter | Opus read-only | payout legs not balance-checked; plain Ownable lock; zero ids accepted | Low x3 | accepted, pinned in ExpectedLimitations.t.sol, no redeploy |
| L-R9 | integration, DoS | relayer | Opus attacker (other session) | throttle locked out valid merchant/operator; one merchant's slow webhook delayed all | Medium/Low | fixed, round-9 commit |
| L-R10 | DoS, fairness | relayer | Opus | webhook backlog starvation, shared host cap, credential cache fill | Medium/Low x3 | fixed |
| L-R11 | refund, keystore, Lead surface | verifier, shared scripts | Opus | forged terminal output via CSV cells in the human report | Medium | fixed (report escapes control/bidi chars) |
| L-R11 | operator | first-refund.mjs, fund guard, qualify-check | Opus | refund script accepted any router; fund guard allowed contract recipients; qualify-check missed .env.* and `KEY: "0x.."` | Low x4 | fixed |
| T1a-c | logic | indexer, verifier | finish run | RefundSignerChanged absent from hash; lax CSV; --rpc2 logs-only | Low x3 | fixed (hashVersion 2, strict cells, rpc2 covers head/timestamps/transfers) |
| L2-R2 | economics, gas | PaymentRouter | Opus read-only | payer can make relayer burn >2x gas via post-simulation transfer/cancel; dust refunds; no maxRelayFee setter | Medium/Low | accepted, pinned in ExpectedLimitations.t.sol, off-chain bounds |
| T3-R2 | economics, DoS | indexer, verifier | Opus | page never regrows; catch-up loses progress; per-row header calls; quadratic compare; forged range scan; non-atomic export | Medium x3, Low x3 | fixed |
