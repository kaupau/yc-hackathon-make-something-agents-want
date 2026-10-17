# Bodega

A local MCP marketplace where agents discover tools, start vendor-funded trials, compare providers, and purchase scoped access under a persistent human-controlled budget.

## Run locally

Requires Node 24+ (SQLite is built in).

```sh
cd bodega
npm ci
cp .env.example .env  # only for a fresh checkout; preserve existing credentials
npm run dev
```

Open http://127.0.0.1:8787. The vendor portal is `/portal`, catalog JSON is `/portal/catalog`, and Streamable HTTP MCP is `/mcp`. Configure a random administrator token to use listing writes and the approval inbox. If an agent token is set, MCP clients must send `Authorization: Bearer <token>`. Binding beyond loopback requires an agent token of at least 24 characters.

The eight storefront tools are `need`, `start_trial`, `run_trial`, `compare`, `buy`, `wallet`, `review`, and `use`. Verified purchases enable the listing's provider tools; `use` supports clients that do not refresh the dynamic tool list. MCP reconnects share the configured `BODEGA_WALLET_ID`; they do not replenish the budget.

A simple demo prompt:

> Find email tools, compare Primitive, Inkbox, and PostPigeon using email.roundtrip, explain the observed results, and buy PostPigeon once with request_id demo-1. Show the wallet afterward.

In simulation this returns explicit simulated results and no real-provider recommendation. Real email checks require provider credentials and a Blaxel-reachable proxy; a failing provider is not silently simulated.

## Payments and approvals

`BODEGA_PAYMENTS=mock` produces deterministic, explicitly simulated receipts. `stripe-cli` uses the existing local Stripe CLI login and a simulated `pm_card_visa` card on the **Bodega Development sandbox only** (`acct_1URdmN2M1S84n0j8`). No API key is extracted. It creates real sandbox PaymentIntent records, not live charges. The SDK mode `stripe` requires a server-only test key. Other Stripe accounts and live keys are refused.

Prices are integer cents with a 50-cent minimum. SQLite reserves the purchase amount atomically before charging; ambiguous payment outcomes retain the reservation. Stable request IDs, Stripe idempotency, separately retrieved receipts, immutable payment modes, and idempotent fulfillment prevent retry charges and duplicate credits. Purchased keys are scoped to a listing, expire after 30 days, and consume quota atomically.

Amounts above the configured threshold require an expiring one-use human approval. Approval tokens are not returned to the purchasing MCP agent. As the trusted local operator, run `npm run approvals` to retrieve pending approval links from the protected inbox. Open the link, decide, then ask the agent to repeat the same buy. Approval delivery is captured locally; no approval email is sent automatically.

For signed webhooks, configure `STRIPE_WEBHOOK_SECRET` and forward test events to `POST /stripe/webhook`. Raw signatures, test mode, purchase metadata, account, amount, and current PaymentIntent state are checked. Duplicate notifications do not duplicate fulfillment, and incomplete verification returns a retryable response.

## Official agent-to-agent MPP adapter

The official `mppx` Stripe adapter is implemented at `/mpp/:purchase_id`. Enable it with `BODEGA_PAYMENT_FLOW=mpp`, `BODEGA_PAYMENTS=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_PROFILE_ID`, and a signing `MPP_SECRET_KEY` of at least 32 bytes. A `buy` returns a payment URL. The buyer's MPP client answers the HTTP 402 challenge with a Shared Payment Token (SPT); with agent authentication enabled, also send `X-Bodega-Agent-Token` on the payment request.

Challenges bind the immutable purchase, amount, scope, expiry, and metadata. Before mutation the server verifies the sandbox account, pins the first SPT hash and purchase idempotency key, then independently retrieves the receipt before issuing access. The raw SPT is never stored. Missing buyer credentials never fall back to a test card in this flow.

Protocol tests exercise official challenge creation, credential serialization, tamper rejection, receipt verification, and replay with a fake Stripe transport. **Actual buyer-wallet/SPT commerce is not yet verified**: it requires Stripe preview access and a buyer token provider. `/health` reports the configuration gaps. This is distinct from the separately verified sandbox test-card fallback.

## Runtime and provider status

- `simulated` accepts commands without executing them and labels outputs. It never ranks real providers using fake timings.
- `blaxel` uses `BL_API_KEY`, `BL_WORKSPACE`, and optional `BL_REGION`. Commands and files run only in the cloud sandbox, never on this host. Sandboxes get only scoped Bodega proxy credentials. TTL cleanup, bounded execution, revocation, output limits, exact upstream allowlists, redirect denial, and atomic metering constrain use. A public HTTPS proxy URL is needed for cloud trials; localhost is not reachable from Blaxel.
- Primitive and Inkbox adapters require their own server credentials. **Primitive verified 2026-10-17 14:25 PT**: `start_trial` booted a Blaxel sandbox (0.3 s) and `compare` ran `email.roundtrip` through the metering proxy against the real API (send 622 ms, deliver 262 ms, 2 trial credits, $0). Needs `BODEGA_RUNTIME=blaxel`, a public HTTPS `BODEGA_PUBLIC_URL` (cloudflared quick tunnel works) and a fresh `BODEGA_WALLET_ID` per run, since a session's trial allotment never resets. Inkbox still unverified (no credentials). Gotcha: the Blaxel SDK reads `./.env` and lets it shadow the process env, so never leave blank `BL_*=` lines in `.env`.
- PostPigeon is an explicit simulation: send succeeds, receive intentionally fails authorization. The remaining catalog capabilities are simulated.

## InsForge backend

The linked **Bodega** development project is in `us-west`: https://insforge.dev/dashboard/project/a2edc97d-ff83-4be0-940f-989fe7f7a7ba . The applied migration is `../migrations/20261017202446_bodega-catalog-events.sql`.

With server-only `INSFORGE_URL` and `INSFORGE_API_KEY`, startup loads the remote catalog and syncs safe catalog and trial/purchase/review/comparison audit records through a durable SQLite outbox. Browser and authenticated user roles have no access to these tables. Tokens, upstream keys, leases, approval links, and sandbox identifiers are omitted from audit payloads. `/health` reports sync backlog and errors.

**This is a single-server hybrid backend**: wallet reservations, trial admission, pooled quota, and human approvals remain authoritative in local SQLite. Keep `.bodega` on a durable private volume, including the wallet signing key. Do not run independent replicas against separate SQLite volumes. Multi-instance transactions and tenant identity/RLS require a subsequent backend migration.

## How Stripe products fit

| Product | Role in Bodega | Current state |
| --- | --- | --- |
| Stripe Projects | Provision developer infrastructure and manage provider credentials | Catalog checked; provisioning blocked by a separate live-mode Projects login/onboarding |
| PaymentIntents | Record sandbox credit-pack purchases and verify receipts | Real sandbox test and idempotent replay verified |
| MPP + Stripe SPT | Buyer agents answer 402 challenges with scoped payment credentials | Official adapter and protocol tests implemented; actual buyer wallet/preview access pending |
| Connect | Onboard real tool vendors and distribute marketplace revenue | Production seller onboarding, charge model, fees, liability, and payouts not configured |
| Billing | Optional platform plans or metered subscription billing | Not configured; current purchases are one-time credit packs |
| Tax | Calculate tax when the production business and registrations are defined | Not configured; sandbox only |

Do not describe the current platform as routing seller payouts or performing live commerce. Stripe Projects CLI authentication is separate from the sandbox payment login; its preflight reported `BROWSER_AUTH_REQUIRED` because no live-mode Projects account is signed in. No broader access was granted.

## Validate and package

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Docker uses Node 24 and a non-root user. Pass a unique agent token and mount `/app/.bodega`:

```sh
docker build -t bodega .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e BODEGA_AGENT_TOKEN=<random-token-at-least-24-characters> \
  -v bodega-data:/app/.bodega bodega
```

The CLI-backed payment mode is local-development only; the production image does not bundle the Stripe CLI. Secrets are excluded from Git and Docker build contexts. Preserve the private `.env` and `.insforge` configuration on this machine; never copy them into a public artifact.
