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
