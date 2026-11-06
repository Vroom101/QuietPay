# Model usage (backend audit run 2)

| Time (IST) | Model | Purpose | Outcome |
|---|---|---|---|
| 22:11 | Opus (1 of 7) | F13 design gate | Hypothesis right but top-level calldata decode is brittle; bind by AuthorizationUsed log, else trace, else state flip + Transfer + decode; ambiguous goes to a new `unresolved` state; UNIQUE (tx,logIndex) claim across sources; confirm depth N before delivery; external settlement recorded with zero facilitator gas. |
| 22:00 | Haiku x3 | B1 requirement maps and weak-test sweep | Drafts; F13 verified by main model. |
| 00:10 | Opus (2 and 3 of 7) | Round A (facilitator, paid API, shared wallet; read-only) and round B (fresh eyes; spec and public interfaces only) | Running; results logged in attack-log.md. |
