# Independent ledger verifier

`packages/verifier` (`@quietpay/verifier`) checks a ledger export (the CSV and its `.meta.json` sidecar from
`pnpm cli export`) against the chain, without trusting the tool that produced it. It does **not** read the indexer's
database or talk to the relayer. Its only inputs are an RPC URL, the router address, the USDT address, the reader's
explicit pay-to expectation (`--payto 0x..` or `--no-payto`), and the CSV path.

```
pnpm --filter @quietpay/verifier cli verify --csv FILE --rpc URL --router 0x.. --usdt 0x.. (--payto 0x.. | --no-payto) \
     [--meta FILE] [--report FILE] [--json]
```

- `--meta` defaults to `FILE.meta.json`. `--report` (the JSON report) defaults to `FILE.verify.json`. `--json` prints the
  JSON instead of the human report.
- One of `--payto` / `--no-payto` is **required**. Pass `--payto <address>` when the export was made with
  `FACILITATOR_PAYTO`, and `--no-payto` when it was made without one. Omitting both exits `2` with
  `missing pay-to expectation` before any chain call; passing both, or a flag twice, is also a usage error. The
  programmatic API is the same: `verifyLedger({ ..., expectedPayTo: "0x.." | null })` is required with no default
  (the old `payTo: "0x.."` is a deprecated spelling of an address expectation), and a caller that leaves it out gets a
  report with `ok: false` and the single issue `payto_expectation_missing`.
- Relative paths are resolved from the directory you run the command in.
- Exit codes: `0` everything matches, `1` mismatch, `2` usage, config or RPC error. **pnpm turns any non-zero exit into
  1.** For the exact codes, run the entry point directly, for example
  `packages/verifier/node_modules/.bin/tsx packages/verifier/src/cli.ts verify ...`. Either way, the JSON report's `ok`
  field and the `RESULT:` line state the outcome.
- On chain 1874 (the chain id is read from the RPC with `eth_chainId`, never taken from a flag) the verifier applies the
  same guard as the indexer: `assertQualifyingConfig` from `@quietpay/shared` (official USDT only), and the router must
  be the qualifying router recorded in `deployments.json`. A guard failure exits with 2.
- The RPC URL is never written to the report, and it is replaced by `<rpc>` in printed errors, because it may carry an
  API key. The verifier makes read-only calls only: `eth_chainId`, `eth_blockNumber`, `eth_getLogs`, `eth_getBlockByNumber`.

## What it checks

1. **Structure.** The header is exactly `date_utc,source,order_id,merchant_id,payer,gross_usdt,relay_fee_usdt,refunded_usdt,net_usdt,status,tx_hash,block,log_index`.
   Lines end with `\n` only (no `\r`), and the file ends with a newline. Amounts have exactly 6 decimals (the token's
   decimals from `token.json`). Hex is lowercase. `block` and `log_index` are integers. Rows are sorted by block, then
   log index. There are no duplicate `tx_hash:log_index` keys, and no row falls outside the sidecar's
   `[fromBlock, toBlock]`. The sidecar must be well formed.
2. **Finality.** The verifier reads the node's head and refuses a sidecar `toBlock` above `head - confirmations` (the
   sidecar's own `confirmations`): `to_block_not_final`, before any log is read. Then it fetches the router's logs, and
   with `--payto` the USDT Transfers to that address, for `[fromBlock, toBlock]`. It uses its own pager
   (`src/spec.ts`): at most 1,000 blocks per call, halving the page on `-32062`, with backoff on rate limits.
3. **Rows.** It decodes the raw logs with its own decoder and rebuilds rows with its own `deriveRows`
   (both in `src/spec.ts`, written from `ledger.md`, not imported from the indexer). Then it compares the rebuilt rows with the CSV row by row, keyed by `tx_hash:log_index`. Each
   difference gets its own reason: `missing_row`, `extra_row`, `wrong_amount` (gross, fee, net), `wrong_refunded`,
   `wrong_status`, `wrong_field` (source, order, merchant, payer), `wrong_block`, `wrong_log_index`, `wrong_tx_hash`. An
   unmatched row is paired by tx hash, or by block and log index, so a moved row is named for the cell that is wrong
   instead of showing up as missing plus extra.
4. **Event set hash.** It recomputes `eventSetHash` over every decoded router event and pay-to Transfer in range, and
   compares it with the sidecar (`event_set_hash_mismatch`). An event that the CSV rules leave out (an operator event, or
   a router payout to the pay-to address) still changes the hash.
5. **Chain invariants**, computed independently of `deriveRows`. For each CSV router row whose key is a real `Paid`
   log, the verifier checks:
   - `gross == Paid.value`
   - `fee == Paid.fee`
   - `refunded ==` the latest `Refunded.totalRefunded`
   - `net == gross - fee - refunded` (may be negative)
   - the status fits the refunded total

   It also reads the real USDT `Transfer` logs of that transaction and requires three of them: payer to router of
   `gross`, router to payout of `gross - fee`, and router to relayer of `fee` when the fee is above zero
   (`transfer_mismatch` otherwise).
6. **Timestamps.** For every row, it fetches the block that the row names and checks that `date_utc` is that block's
   timestamp in ISO 8601 UTC (`wrong_date`).

The JSON report contains:
- `ok`
- the per-check status (`pass`, `fail` or `skipped`) for `structure`, `sidecar`, `finality`, `rows`, `event_set_hash`,
  `invariants` and `timestamps`
- head and finalized blocks
- the row and event counts
- both hashes
- every issue, with its code, line, key, field, expected and actual values

## What it proves

If the result is OK, then for the stated block range and against the chain data that this node serves:
- the CSV is byte-for-byte the shape the export promises
- every row is derived from real router `Paid`/`Refunded` logs, or from real USDT Transfers to the pay-to address,
  under the documented rules
- no row is missing or added
- the amounts match the events and the actual token movements in each settlement transaction
- dates are block timestamps
- the sidecar's event set is exactly the set of events on chain in that range

The check repeats the derivation from raw chain data. It does not use any record kept by the indexer, the relayer or
the facilitator.

## What it does not prove

- **It trusts the RPC node.** A dishonest or out-of-sync node can serve false logs, blocks or a false head. Use a node you
  trust, or verify against two independent providers.
- **Finality is a confirmation count**, read from the sidecar (`confirmations`). It is a setting, not a proof that the
  blocks cannot be reorganised. A sidecar with an unusually low count should be read with that in mind.
- **It is not proof of an x402 API purchase.** A `payto_transfer` row only shows that USDT reached the pay-to address.
  It says nothing about which API call, if any, the deposit paid for. Proving that needs the facilitator's settlement
  authorization records, which this verifier does not check.
- **Its row rules are a second implementation of the same spec.** `src/spec.ts` does not import the indexer, and a
  differential property test (`test/differential.test.ts`) requires identical rows. A misreading of `ledger.md` shared by
  both would still go unnoticed; the invariants in step 5 are computed separately and partly cover this risk.
- **Anchoring.** A result is printed `OK (unanchored)` unless `--from`, `--to` and `--min-confirmations` were supplied from
  outside the export. Without them a forger can shrink the range in both files. Compare the printed checkpoint with the
  publisher's out of band.
- **The sidecar never decides what is checked.** The sidecar must carry `router`, `usdt` and `payTo` (an address or
  `null`; the exporter always writes all three). A sidecar missing any of the three keys (the old shape, or one edited
  to drop them) is rejected as `bad_sidecar` (`malformed_sidecar: ...`) and can never be OK. All three must equal what
  the reader states (`config_mismatch`): the router and USDT flags, and the pay-to expectation, where an address
  matches case-insensitively and a sidecar `payTo: null` matches only `--no-payto`. So a forger who strips the deposit
  rows, rebuilds the hash over router events and sets `payTo: null` gets `config_mismatch` from a reader who passes
  `--payto`, and a refusal from a reader who passes neither flag. What remains is the reader's own statement: a reader
  who wrongly passes `--no-payto` for an export that had a pay-to address is told only what they asserted.
  Sidecars written before 2026-11-06 (no pins) must be
  re-exported to verify.
- **A refund appears only in the export that contains its payment.** Rows are placed at their `Paid` block, so a refund
  made after `toBlock` of an earlier export, or of a payment before `fromBlock`, is not visible in a later range's rows.
  Export from the deploy block, or re-export, to see current refund totals. Pinned by a test as a known limitation.
- **It covers only the given range and addresses.** Events before `fromBlock`, or contracts other than the given router
  and USDT, are out of scope. If the wrong `--payto` is given, the file is judged against that address.
- **Refund transfers are not cross-checked.** For `Refunded` logs, only `totalRefunded` is used. The token movement
  in each refund transaction is not checked.

## Tests

`pnpm --filter @quietpay/verifier exec vitest run`:
- **`test/verify.test.ts`** (fake log source). It uses exports produced by the real indexer code path (`indexOnce` and
  `buildExport`). It covers:
  - a valid file passes
  - paging and halving
  - a sub-range export
  - each of the 13 cells tampered, each with its specific reason
  - a deleted row, an added row, swapped rows, a duplicate row, a row out of range
  - CRLF line endings, a 7-decimal amount, a bad header, a missing final newline, a wrong cell count, a bad integer
  - a wrong sidecar hash, a hidden event, a `toBlock` beyond finality, a malformed sidecar, `--no-payto` on an export that had a pay-to address
  - transfer mismatches (payout, relayer fee, payer pull)
  - the chain 1874 guard
- **`test/round7-coverage.test.ts`**: the pay-to expectation is required and reader-decided: a forged `payTo: null`
  sidecar with no expectation is refused (API and CLI), `--no-payto` against a real `payTo` and a mismatching
  `--payto` are `config_mismatch`, stripped deposits with `payTo: null` fail under `--payto <real>`, and legitimate
  exports with and without a pay-to address still verify OK.
- **`test/cli.test.ts`**: exit codes 0, 1 and 2, the JSON report file, `--json`, a missing sidecar, an RPC error, and the
  guard.
- **`test/e2e-anvil.test.ts`**: runs on anvil with the real router. It makes a real payment and a partial refund plus a
  deposit, exports with the indexer, and checks that the export verifies OK. Then it edits one amount and checks that
  verification FAILS with `wrong_amount` on `net_usdt`.
- **`test/live-sample.test.ts`**: verifies `docs/lead/samples/live-sample.csv` against chain 1874 through the public RPC.
  It runs only when `RPC_URL` is set in the environment (read-only). Set `VERIFY_PAYTO` if the sample was exported
  with a pay-to address; otherwise the test passes `--no-payto`.
