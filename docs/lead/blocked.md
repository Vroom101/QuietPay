# Blocked and pending items

| Item | Status | What is needed |
| --- | --- | --- |
| Live payment with the official USDT (Phase 3 Task 3) | **pending: unfunded** | Official test USDT `0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7` in the payer wallet `0x30Ab1c2f5d1D8794FdFE60EFa412F80D03037478` (about 5 USDT). Keep its WBT at zero. The token has no public faucet and the run never mints or substitutes a token. |
| Live refund with the official USDT (Phase 3 Task 4) | **pending: unfunded** | Official test USDT in the refund signer wallet `0xeF70298c52b917d2301F7331bfe7038550d2CD5d`, and the payment above. |
| Live indexer sample for the qualifying router (Phase 4 real run) | **pending** on the two items above | The sample export needs a real payment and refund on the qualifying router. Only anvil tests run until then. |
| `main` is red in A's and B's packages | **by design until they merge** | `packages/relayer/src/service.ts` needs `fee` in `computePayNonce`; `apps/merchant-dashboard` test expects the old two-decimal format. Listed in `docs/lead/shared-change.md`. Lead does not edit their folders. |
| Leftover stand-in token reference | A/B folder | `packages/relayer/test/e2e-anvil.test.ts` (listed for B). |
