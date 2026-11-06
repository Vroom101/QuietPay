# Model usage (this run)
| Time (UTC) | Model | Purpose | Outcome |
|---|---|---|---|
| 2026-11-06 | opus | L3/L4 R1 attack + net semantics | 2 High (prior-range refund, payto-less verify), 1 Medium (unanchored OK), 5 Low; net should be negative-capable |
| 2026-11-06 | opus | PaymentRouter R1/R3 attack | 0 Critical/High; 3 Low accepted as limitations (no redeploy) |
| 2026-11-06 | opus | T1d double-count design gate | hypothesis confirmed, narrowest rule from != router |
| 2026-11-06 | opus | router R2 | 0 Critical/High, 1 Medium + 2 Low accepted |
| 2026-11-06 | opus | router R4 (operator/supply chain) | 1 High (owner powers, documented), 2 Medium, 3 Low |
| 2026-11-06 | opus | indexer+verifier R2 and R4 | R2: 6 DoS holes; R4: 9 holes incl. High RPC-key leak; all fixed |
