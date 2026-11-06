# Open items carried into the finish run
- RefundSignerChanged missing from the event set and hash (no hashVersion).
- parseCsvLine tolerance of quotes / formula prefixes.
- --rpc2 covers ledger logs only (not head, timestamps, settlement Transfers).
- Same-transaction pay-to deposit hidden by the double-count rule (needs design decision).
- Router mutation sweep incomplete (killed for low memory); forge coverage stack-too-deep; no Slither.
- Rounds R2/R4 (router, indexer, verifier) and R5 (whole surface) not run.
- Handoff refresh, stray hardening-r3.test.ts note for B.
