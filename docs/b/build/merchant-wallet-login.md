# Merchant wallet login

A merchant can sign in to the dashboard with MetaMask. The wallet address is the merchant's identity. The static `QUIETPAY_DASHBOARD_TOKEN` keeps working exactly as before.

## Flow

1. Dashboard asks the wallet for accounts (`eth_requestAccounts`).
2. `POST /api/merchant/auth/challenge {address}` returns `{nonce, message}`. The message is an EIP-4361 style text built by the server (domain, URI, chain id, 32 hex nonce, issued-at, expiry 5 minutes). Allowed and unknown addresses get an identical answer, so the wallet list is not an oracle.
3. The wallet signs it with `personal_sign`.
4. `POST /api/merchant/auth/verify {nonce, signature}`. The server deletes the challenge first (single use), checks expiry, verifies the signature against the STORED message, then requires the signer to be in the allowlist. It returns `{token, address, expiresAt}`. Every failure is `401 {"error":"sign-in failed"}`.
5. The token (32 random bytes, base64url) is used as the bearer token on all merchant routes. Only its SHA-256 is kept on the server. `GET /api/merchant/auth/me` shows the session; `POST /api/merchant/auth/logout` ends it.

The dashboard keeps the token in React state and `sessionStorage` only, never `localStorage`.

## Environment

| Variable | Meaning | Default |
| --- | --- | --- |
| `QUIETPAY_MERCHANT_WALLETS` | comma separated 0x addresses allowed to sign in | the store payout address (`QUIETPAY_PAYOUT_ADDRESS`) when set |
| `QUIETPAY_AUTH_DOMAIN` | domain shown in the signed message | `localhost:5173` |
| `QUIETPAY_AUTH_URI` | URI shown in the signed message | `http://localhost:5173` |
| `QUIETPAY_CHAIN_ID` | chain id shown in the message | `1874` |

Wallet login is off when no wallet resolves. Merchant routes still need `QUIETPAY_DASHBOARD_TOKEN` configured (the session token is an extra credential for the same guard).

## Limits

- Rate limit: 20 points per minute per client IP (IPv6 grouped by /64). Each request costs 1, a failed verify costs 2.
- Challenges expire after 5 minutes (max 10,000 held, oldest evicted). Sessions last 8 hours by default (max 10,000).
- Request bodies on the auth routes are capped at 2 KB.
- The identity is a single hot wallet from the allowlist; there are no roles or per-user accounts.
- Challenges and sessions live in memory: a server restart signs everyone out.
- The signed message does not bind to a transaction or cost gas; protect the allowlist like any admin credential.
