# Shared-change protocol

`contracts/` and `packages/shared` are owned by Lead. If you need a change there:

1. Open an issue or note in `docs/<owner>/decisions.md` stating the exact change.
2. Lead makes the change on `main` and tags if the spec shape changes.
3. Merge `main` into your branch. Never edit the shared folder on your branch.

Never hand-edit `pnpm-lock.yaml` conflicts; regenerate with `pnpm install`.
Never copy the ABI by hand; it is generated from the Foundry build into `packages/shared/src/abi`.
