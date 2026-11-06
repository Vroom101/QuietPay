# Deployment state (read-only `cast` checks, chain 1874, 2026-11-06)

| Fact | Value |
|---|---|
| Chain id | 1874 |
| Router | `0xb9D475cdd817900B45C356169c6FdC379B942d82`, deploy block 12351795, source verified (explorer) |
| `router.token()` | `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` (official test USDT) |
| Paused | false |
| Owner | `0x1E009f4fecE682514fCD5F284CaDdB1f46b10e2D` (deployer key; see the Lead's README note on owner powers) |
| Relayer | `0x5e97E3E39ba9DaBbc1297392a2eE62A139F1ceeA`, `isRelayer` = true |
| Demo merchant `0x1d3fd9d6...54ac` | payout `0x8DEA71e7930b45648Dc9d2E8fEc742F56B329425`, refund signer `0xeF70298c52b917d2301F7331bfe7038550d2CD5d`, maxRelayFee 100000 (0.1 USDT) |
| WBT | relayer 50.30, owner 1.68, refund signer 50.0, payer 0.00000001 (dust, below the gas of one transfer) |
| USDT | payer 99.5, refund signer 99.5, payout 0.95 |

Everything needed is already on chain: no transaction was sent in this step.
Decision: the payer's "zero WBT" requirement means "cannot pay gas". The payer holds 9.99e-9 WBT (dust that cannot cover a transfer), and exact zero is not reachable after the earlier sweep. Preflight must compare the payer's WBT with the cost of one transfer, not with exact zero.
