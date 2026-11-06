# Ledger and CSV export

`packages/indexer` turns on-chain events into an accounting ledger and a reproducible CSV. It reads **chain data only**
(never the facilitator's or relayer's database), so anyone can recompute the same file from the same blocks.

## Sources

1. **Router events**: `Paid`, `Refunded`, plus `MerchantRegistered`, `PayoutChanged` and `RelayerSet` for the operator view.
2. **Pay-to deposits (`payto_transfer`)**: USDT `Transfer(from, to, value)` where `to` is `FACILITATOR_PAYTO`. These are
   recorded as deposits. They are **not** proof of an x402 API purchase (see below).

## Row rules

**Router** (one row per `(merchantId, orderId)`):

| Column | Rule |
| --- | --- |
| `gross_usdt` | `Paid.value` |
| `relay_fee_usdt` | `Paid.fee` |
| `refunded_usdt` | latest `Refunded.totalRefunded` (0 if none) |
| `net_usdt` | `value - fee - refunded`; negative (e.g. `-0.050000`) after a refund beyond `value - fee`, because the relay fee is not returned |
| `status` | `settled`, `partially_refunded` (0 < refunded < value) or `refunded` (refunded >= value) |
| `tx_hash`, `block`, `log_index` | from the `Paid` log |

**payto_transfer** (one row per qualifying Transfer): `order_id` and `merchant_id` empty, fee and refunded `0.000000`,
`net_usdt` = gross, `status` = `settled`. The `source` value is `payto_transfer`, never `x402`.

A bare USDT transfer to the pay-to address is recorded as a **deposit**. It is **NOT** proof of an x402 API payment:
the token transfer alone says nothing about which API call, if any, it paid for. Proof of an x402 payment needs the
facilitator's settlement authorization records, which the verifier will check in a later step. Until then, read these
rows as deposits into the pay-to address.

Amounts are decimal strings with exactly as many places as the token has (6 for the official USDT, read from `token.json`,
never hardcoded), built from integer base units (no floating point).

### The double-count rule

A router payment also emits a USDT `Transfer`, and a merchant payout may be the same address as `FACILITATOR_PAYTO`.
A Transfer is recorded as a `payto_transfer` deposit **only if** its `from` is not the router (decision T1d, `decisions.md`). A pay-to address equal to the router is refused.
This is tested in unit tests, on anvil with the real router, and on the live testnet
(the router's 4.95 payout transfer to the facilitator address is excluded in the sample).

## Finalization

A block is final after `CONFIRMATIONS` blocks (default 12). Only final blocks are stored, and the cursor only moves to a
finalized block, so a reorg inside the unfinalized window cannot leave stale rows: those blocks are simply read again
once they are final. Finalized rows are never deleted. If the stored cursor block's hash no longer matches the chain, a
reorg deeper than `CONFIRMATIONS` happened and the indexer stops with an error rather than guessing.

## Idempotency and rebuild

Raw events are keyed by `(tx_hash, log_index)`, so re-running `index` adds nothing. The ledger table is derived from raw
events; `rebuild` wipes and recomputes it and gives identical rows.

## RPC

`eth_getLogs` in pages of at most 1,000 blocks from the router's deploy block (`deployments.json`, `deployBlock`).
The Ankr testnet endpoint answers wider ranges with `-32062`; the indexer halves the page and retries, and backs off
exponentially on rate limits.

## Commands

```
cd packages/indexer
export RPC_URL=... CHAIN_ID=1874 USDT_ADDRESS=0x.. ROUTER_ADDRESS=0x.. FACILITATOR_PAYTO=0x.. \
       DATABASE_PATH=./indexer.db CONFIRMATIONS=12
pnpm cli index                                   # catch up once
pnpm cli watch                                   # loop (POLL_SECONDS, default 5)
pnpm cli rebuild                                 # recompute the ledger from raw events
pnpm cli export --from N --to M --out out.csv    # writes out.csv and out.csv.meta.json
```

On chain 1874 the CLI accepts only the qualifying router and the official USDT (`assertQualifyingConfig`).

`FACILITATOR_PAYTO` is optional; without it only router rows are produced. `export` clamps `--to` to the finalized
cursor, so non-final blocks are never included. Set `GENERATED_AT` to pin the sidecar timestamp for byte-identical sidecars.

## CSV and sidecar

Columns, in order: `date_utc, source, order_id, merchant_id, payer, gross_usdt, relay_fee_usdt, refunded_usdt, net_usdt,
status, tx_hash, block, log_index`. Sorted by `block` then `log_index`, `\n` line endings, standard CSV quoting,
`date_utc` is the block timestamp in ISO 8601 UTC. A router row is placed at its `Paid` block, and refunds are applied up
to the export's `--to` block.

`export.meta.json`: `{fromBlock, toBlock, confirmations, eventSetHash, generatedAt}`. `eventSetHash` is the SHA-256 of
the sorted `tx_hash:log_index` lines, one per line, for every raw event stored in `[fromBlock, toBlock]` (including
router operator events and the Transfers to the facilitator address, even those excluded by the double-count rule).

## For the verifier

Reuse the pure functions from `@quietpay/indexer`: `decodeRouterLog`, `decodeTransferLog`, `buildLedgerRows`, `toCsv`
(and `eventSetHash`). They take events as arguments and share no storage.

## Samples

- **Live sample (chain data):** `docs/lead/samples/live-sample.csv` and `.meta.json`, exported from the qualifying router, blocks 12351795-12361516. One router row: 1.000000 gross, 0.050000 fee, 0.500000 refunded, 0.450000 net, `partially_refunded`, from the live payment and refund in `live-usdt.md`. Re-exported on 2026-11-06 in the new sidecar format (`router`, `usdt`, `payTo: null`); the CSV is unchanged and it verifies with `--no-payto`.
- **Synthetic sample (format only):** `docs/lead/samples/synthetic-sample.csv` and `.meta.json` are generated from
  hand-made logs by `packages/indexer/scripts/make-synthetic-sample.ts`. They are **not** chain data. They show a partly
  refunded router row, a plain `payto_transfer` deposit row, and the double-count rule (a router payout to the facilitator address is counted
  once, as router). Dates look odd because the fake chain uses made-up block timestamps.

## Limits

Testnet only. A confirmation depth is a setting, not a proof of finality. The ledger shows what the chain shows; it does
not convert currency or claim custody. `net_usdt` is the merchant's result and is NOT clamped: a full refund gives `-fee`,
because the router lets a refund reach the gross value while the relay fee is not returned.

## Added in the finish run (2026-11-06)
- The indexer database remembers the pay-to address (or none) it was indexed with. Exporting with a different pay-to is refused: re-index from a fresh database. Databases created before this change count as "no pay-to".
- Catch-up commits in chunks of 20,000 blocks, so a late failure keeps earlier progress. The page size grows back after a run of good pages. Exports are written atomically.
