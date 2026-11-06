# Status

## CP0 (shared specs)
- `packages/shared` has zod schemas, error enum, typed-data builders, webhook signing, fixtures and a mock relayer. Tagged `shared-v1`.
- Token facts read from the live USDT; primary path is `receiveWithAuthorization` (see `token-gate.md`).
- Router written with 25 passing Foundry tests; on-chain gasless execution still pending a funded key.
