# Needs from others

1. Person A (merchant dashboard, `apps/merchant-dashboard`): the dashboard calls `GET /v1/orders` with a bearer key from the browser. Since the relayer no longer sends a wildcard CORS header on authenticated routes, set `CORS_ORIGINS=https://<dashboard origin>` (comma separated) in the relayer environment for any deployment that uses the browser dashboard. For local development use `CORS_ORIGINS=http://localhost:5173` (or the dev server's origin). Nothing in the dashboard code has to change.
2. Person A (widget): no change; `GET /v1/orders/:id` and `POST /v1/relay/pay` keep `access-control-allow-origin: *`.
3. Indexer/verifier owners: none from this run so far.
4. Person A (`apps/demo-store`): it pins `fastify@4.29.1`, which `pnpm audit --prod` flags with several advisories (patched in 5.x). The backend packages already run 5.12.8. Upgrading demo-store to Fastify 5 clears all of the Fastify findings in the production audit.
5. Owner of `packages/shared`: zod 3 -> 4 decision, see `blocked.md`.
