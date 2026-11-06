# Limitations

## Browser key is demo-grade
WebCrypto cannot do secp256k1. The widget therefore generates a random 32-byte private key, encrypts it with a non-extractable AES-GCM CryptoKey, and stores the CryptoKey, IV and ciphertext together in IndexedDB (`quietpay-wallet`). Signing uses viem `privateKeyToAccount`, so the plaintext key exists in JS memory during signing.

- Any script running on the same origin can ask the browser to decrypt it. XSS means key theft.
- Clearing site data, private windows or switching browsers loses the key and the funds sent to its address. There is no backup or recovery.
- It is not a wallet. Do not fund it with real money. The widget footer says this.
- Production should use a real wallet (injected provider, WalletConnect) or passkeys with a smart account.

## Funding
The widget shows the payer address. The user must send USDT to it from elsewhere. The widget does not read the balance, so it cannot warn about an empty balance in advance; the relayer's `simulation_failed` message covers that case.

## Other
- Merchant name is not in the Order schema, so the widget shows a shortened merchant id and the reference.
- Demo store trusts `cartTotal` from the browser. A real shop must price the cart on its server.
- Demo store keeps paid orders and seen webhook ids in memory; both reset on restart.
- The mock relayer does not verify signatures, serve `GET /v1/orders`, or send webhooks. Dashboard uses a fixture adapter; the store needs `simulate-webhook`.
- Widget is verified against the mock relayer only, not the real relayer or chain.
- Widget build emits JS only (no `.d.ts`); monorepo consumers use the TS sources.
- Dashboard shows the explorer link only when the order carries `explorerUrl`.
- Backend/SDK refunds are implemented; dashboard refund controls are pending. x402 and ledger backends are implemented; their browser integration remains pending.
