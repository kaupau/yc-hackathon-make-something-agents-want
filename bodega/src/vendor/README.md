# Vendor services

`createVendorServices(options?)` in `index.ts` implements `Catalog`, `Vault`, `Ledger`,
`Approvals`, returning `handleRequest(Request): Promise<Response|null>`, `close()`,
`deliveryOutbox`, and `persistence: 'local-demo-sqlite'`. No new dependencies. Requires
built-in `node:sqlite` (verified on Node 25.9; Node 22.13+ exposes the API without a flag).
The composition server calls the handler before its own 404 handler.

```ts
const vendor = createVendorServices({
  dbPath: '.bodega/vendor-demo.sqlite',
  publicUrl: 'http://localhost:8787',
  adminToken: process.env.BODEGA_VENDOR_ADMIN_TOKEN,
});
const response = await vendor.handleRequest(request);
```

Options: `dbPath`, `publicUrl`, `adminToken`, `env`, `upstreams` (trusted startup-only
`UpstreamConfig[]`), `now`, `approvalTtlMs` (default 15 minutes), `deliverApproval`,
`fetcher`. Env defaults: `BODEGA_VENDOR_DB_PATH`, `BODEGA_PUBLIC_URL`,
`BODEGA_VENDOR_ADMIN_TOKEN`. Pooled keys read `PRIMITIVE_API_KEY`, `INKBOX_API_KEY`,
or the trusted upstream's configured env name. Missing credentials fail closed.
Admin tokens require at least 24 characters. Do not commit secrets or database files.

## Local demo persistence

This is **local SQLite demo persistence**, not InsForge. Catalog, trials, consumed
vendor credits, purchases, comparisons, reviews, approval decisions, and scoped
PostPigeon keys survive restarts. SQLite uses `BEGIN IMMEDIATE`, WAL, a busy timeout,
and a private database file. Mount its directory as a persistent volume. Independent
containers must not use separate files as if they were one shared ledger. The file
contains sensitive trial/scoped credentials and needs server-only filesystem access.
Pooled API secrets are never persisted or returned through HTTP.

`Ledger.recordUsage` reserves **before** upstream work. Expired, inactive or insufficient
quota throws `QuotaExceededError` (`code: 'QUOTA_EXCEEDED'`) and consumes nothing.
A successful last credit returns `exhausted:true`: allow that request, deny the next.
Attempted upstream work consumes the reservation even if the provider fails. Usage
requires a positive safe integer. Trial identity, usage, limits and expiry are immutable
through `updateTrial`. Session-wide allowance cannot exceed `per_agent`, including
ended trials. Catalog edits preserve consumed pool credits. Duplicate event IDs do
not inflate funnels; conflicting duplicate events fail. Payment charging/reservations
belong to the storefront's separate workflow, not this ledger.

## HTTP routes

- `GET /portal`: live funnels, public catalog and functional admin JSON listing editor.
- `GET /portal/catalog`: public listing projection; no upstream configuration.
- `GET /portal/funnel/:vendor`: trials, checks, choices/rejections, paid purchases/revenue.
- `PUT /portal/listings/:id`: Bearer admin token required; create/update public listing
  details, trial allotment and price. Vendor identity and consumed pool cannot reset.
  Credential modes/URLs remain trusted startup configuration, excluded from this editor.
- `GET /approve/:opaqueToken`: human review of exactly one bound pending purchase.
- `POST /approve/:opaqueToken`: form/JSON `decision=approved|declined`; one-use capability,
  256-bit randomness, expiry, token hash storage, bound purchase/session/listing/amount.
  A GET never approves. Cross-origin browser submissions are rejected. No approval by
  predictable purchase ID. A changed purchase invalidates the approval.
- `POST /postpigeon/provision`, `/postpigeon/revoke`: Bearer admin token and JSON
  `{trial_id}`; simulated vendor administration only. Vault mints scoped mock keys
  internally. No real vendor key is exposed by these endpoints.
- `POST /postpigeon/messages`: scoped mock key required; simulated send returns 202.
- `GET /postpigeon/messages`: valid scoped key still returns the **deliberate 401 read
  permission failure** for the comparison. No email is sent.
- `GET /postpigeon/docs`: simulated endpoint description.

Unrecognized routes return null for the composition handler. Bodies are bounded while
streaming and cancelled over 100,000 bytes. Public funnels render escaped reason text.
The portal never lists purchases, trial tokens, project keys, approval tokens or leases.
Funnel reads are intentionally public in this demo; production vendor identity/tenant
authorization remains future work. A public listing does not provision resources or
imply permission to resell a provider's services.

## Approval delivery

Record the exact pending purchase before `Approvals.request`. Default delivery is
**captured locally** in the in-process `deliveryOutbox`; no human email is sent.
Messages contain approval links and must stay local. Inject `deliverApproval(message)`
only when outbound human email is separately authorized. There is no unauthenticated
reply webhook. For a mock demo use the existing `MockApprovals` deliberately; for these
durable services open the captured opaque link and submit the review form. Expired
requests report `declined`; the storefront keeps payment blocked. Retrying a pending
request rotates the link. Real Primitive approval delivery has not been verified.

## InsForge integration seam

`migrations/001_insforge.sql` supplies a server-only Postgres JSONB table and atomic
quota RPC. It is **not applied or remotely verified**: no InsForge project connection
was available. RLS is enabled, public access revoked, and explicit grants to a selected
server role are required. Never grant browser roles access; real credentials belong in
the server's Vault/secret manager rather than browser-readable data.

The integration seam is the four shared service interfaces, not the synchronous SQLite
class. An async InsForge adapter must implement those interfaces, map `recordUsage` to
the transactional RPC, and make trial creation/session allowance/concurrent limits and
immutable bindings transactional too. Run the acceptance tests against that adapter
before switching composition. Merely setting an InsForge URL does not change backend.
Existing mocks stay available component-by-component as the fallback.

Primitive/Inkbox retain the scaffold's upstream mappings; no live account validation
or outbound action was performed. PostPigeon is explicitly simulated. Stripe Projects,
MPP and A2A settlement are Stream A work; these services perform no Stripe actions.

## Verify

```sh
cd bodega
npx tsx --test src/vendor/vendor.test.ts
npm run typecheck
```

Tests cover restart persistence, duplicate-event accounting, atomic competing quota
reservations, the last allowed unit, immutable usage, approval expiry/replay/origin and
purchase scope, admin auth, secret isolation, PostPigeon send/failing receive/revocation,
and streaming body limits. Real InsForge, approval email, vendor authentication and
paid vendor pool funding remain integration work.
