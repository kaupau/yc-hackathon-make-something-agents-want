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

## Customers and agent credentials

Each customer is provisioned by the administrator with an ID, approver email, budget cap and approval threshold (integer cents). Bodega issues a random 256-bit agent bearer token (`bdg_agt_…`) **once**; only its SHA-256 digest is stored. Each customer gets its own durable wallet (`customer:<id>`); MCP sessions, purchases, trials and `/mpp` payments are bound to the authenticated customer. Budgets come only from the administrator record, never from tools, and reconnects or restarts never replenish them. Agent tokens cannot approve purchases or use admin endpoints; approvals still use the separate one-use approval link.

- Operator console: open `/admin/customers/console`, paste the administrator token (kept in page memory only), create a customer, and copy the one-time MCP configuration to that customer's agent.
- CLI: `npm run customers -- create --email human@example.com --cap 1000 --threshold 100 [--id acme]`, plus `list`, `rotate <id>`, `issue <id>`, `revoke <credential-id>`, `disable|enable <id>`.
- API (Bearer administrator token): `POST /admin/customers`, `GET /admin/customers` (metadata only, never tokens/hashes), `POST /admin/customers/:id/credentials` (`{"revoke_existing":true}` rotates), `POST /admin/credentials/:id/revoke`, `POST /admin/customers/:id/active`.
- Agents send `Authorization: Bearer <token>` to `/mcp` and `X-Bodega-Agent-Token: <token>` to `/mpp/:purchase_id`.

`BODEGA_IDENTITY_BACKEND=sqlite` (default, `.bodega/identity.sqlite`) or `insforge` (server-only RPC functions from `../migrations/20261017210002_customer-identities.sql`, requires `INSFORGE_URL`/`INSFORGE_API_KEY`). The legacy `BODEGA_AGENT_TOKEN` still works but only for the legacy `BODEGA_WALLET_ID` wallet. Without any legacy token, local loopback demos keep anonymous access to the legacy wallet unless `BODEGA_REQUIRE_AGENT_AUTH=1` (implied by the InsForge backend); a malformed or revoked credential never falls back to anonymous access.

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
- Primitive and Inkbox adapters require their own server credentials. Primitive login was skipped at the user's request; no real email roundtrip has been claimed.
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

## Railway + real Blaxel trials

Hosted development URL: https://bodega-production-4802.up.railway.app . Project: https://railway.com/project/0a56f39d-e99f-4510-9138-c698b066a3b4 . The service uses one replica in us-west with a Railway-managed volume at `/app/.bodega`.

`BODEGA_RUNTIME=blaxel` runs real code in the configured `nousdata` workspace. The deployed public HTTPS URL is injected into sandbox proxy settings, so sandboxes can reach Bodega for scoped provider access. `BODEGA_MAX_TRIAL_MINUTES=5` and `BODEGA_MAX_ACTIVE_TRIALS=3` bound resource use across listings. Provider credentials stay on Railway; sandboxes receive only expiring Bodega trial credentials. A completed comparison revokes and deletes its trial. The TTL also bounds abandoned trials.

Railway MCP access requires its private `BODEGA_AGENT_TOKEN`. The local `.bodega/railway-mcp.json` contains a ready-to-use authenticated client configuration; it is intentionally excluded from Git. The homepage and public catalog are readable without that token. Administrator approval access uses a different private token. Railway service variables contain the Blaxel key and InsForge project key; the personal InsForge user key is not uploaded.

Cloud payments are currently `mock`, clearly labeled by the app. The verified Stripe CLI fallback remains local to this Mac. To enable sandbox payments on Railway, configure a server-only Stripe test key for the same Bodega sandbox and change `BODEGA_PAYMENTS=stripe`. This is independent of real Blaxel trial execution. Primitive and Inkbox still require their provider credentials; PostPigeon remains a simulated provider even when its tests run in a real Blaxel sandbox.

Railway mounts volumes as root. The container entrypoint prepares the private volume directory and then drops to the Node user before starting the app. Healthcheck host access is allowed only for `GET /health`. Deployment uploads are built from an explicit source-file allowlist so local `.env`, `.bodega`, transcripts, credentials and CLI configuration are not included in the upload.
