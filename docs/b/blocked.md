# Blocked

## zod advisory GHSA-mrhx-c7xc-m3w5 (high): memory use when validating very large arrays
- Reachable from every backend package, since all of them use zod 3.25.76 (and viem pulls it in through abitype). The fix is only published for zod 4 (`>=4.6.6`); there is no 3.x patch.
- Upgrading means moving the frozen shared schemas (`packages/shared`, off limits and frozen) from zod 3 to 4, which changes error shapes and the typed API for every package. That is a spec-level change, not a backend fix.
- Mitigation in place and tested: the relayer, facilitator and paid API cap request bodies at 16 KiB (the route-matrix tests assert 413 for larger bodies), and the paywall reads only a header limited by Node's header size cap. A 16 KiB body cannot hold an array big enough to exhaust memory. The merchant SDK validates only responses from the configured relayer and webhook bodies the merchant already received.
- Decision needed from the owner of `packages/shared`: schedule the zod 4 migration, or accept the risk with the mitigation above. Nothing else is blocked.
