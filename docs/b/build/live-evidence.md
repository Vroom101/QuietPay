# Live evidence (chain 1874, 2026-11-06T19:15:51.183Z)
Router 0xb9D475cdd817900B45C356169c6FdC379B942d82 (deploy block 12351795), official USDT 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7.
Before: payer WBT 9999996920 wei (one transfer costs about 157531500000000 wei), payer USDT 99.500000, refund signer USDT 99.500000, payout USDT 0.950000.
Relayer started locally against the testnet (paused: false, relayer 0x5e97E3E39ba9DaBbc1297392a2eE62A139F1ceeA).

## 1. Gasless payment (payer signs only; the relayer pays gas)
Order 0xf181f132bb22d23689b7249abf8903b3845dd53b8741298d29ed5c01e67cec17, amount 1.000000 USDT, fee 0.050000. Tx: https://explorer.testnet.whitechain.io/tx/0xe0799d3de8cb9804403af2e81f9c9caad80a4c973887452c2975f3220240e14c
Payer WBT unchanged: true (9999996920 wei). Payer USDT 99.500000 -> 98.500000. Merchant payout +0.950000 USDT.

## 2. Webhook
payment.settled received and signature verified by the merchant SDK.

## 3. Refunds (signed by the merchant's refund signer, submitted gaslessly by the relayer)
Partial refund 0.400000 USDT: https://explorer.testnet.whitechain.io/tx/0xcd759639ffc78e5052fb2cd22acd75c0a423c3f10a1f04384b218f02d0bb5cd8
Remaining refund (0.600000 USDT): https://explorer.testnet.whitechain.io/tx/0xbdcbaef182688f8442ef439dd98fe5352f89da3961062e08ae9132f5a1f7ba20
Order after refunds: status refunded, refunded 1000000.
A further refund above the remainder is refused: yes (Invalid refund amount.)

## 4. Ledger export verified against the chain
Rows 2, blocks 12351795-12396218. Verifier exit 0 (0 = OK). checkpoint    blocks 12351795-12396218, 7 events, hash bbc530f3aca8252057af8be503dbac61f81be9030cf755659e270c94f1fa72db
A tampered copy (one amount digit changed) fails: exit 1 (non-zero expected).

Final: payer WBT unchanged true; payer USDT 99.500000; refund signer USDT 98.500000. Total live payment volume: 1.000000 USDT (cap 10).

## Result
- PASS payer paid no gas
- PASS webhook verified
- PASS refunds sum to the payment
- PASS over-refund refused
- PASS verifier OK
- PASS tampered export rejected
