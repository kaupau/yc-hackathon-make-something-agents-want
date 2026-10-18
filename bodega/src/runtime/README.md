# Trial runtime

`createTrialRuntime({catalog, ledger, vault}, options)` implements the shared `TrialRuntime` interface. No agent command is ever executed on the Bodega host. The default backend fails closed; choose Blaxel or explicitly choose simulation.

```ts
import { createTrialRuntime, createBlaxelSandboxBackend, createSimulatedSandboxBackend, createProxyHandler } from './runtime/index.js';

const backend = process.env.BODEGA_SANDBOX_MODE === 'simulated'
  ? createSimulatedSandboxBackend()
  : await createBlaxelSandboxBackend();
const runtime = createTrialRuntime(services, {
  backend,
  publicBaseUrl: process.env.BODEGA_PUBLIC_URL,
  email: {
    primitiveInbox: process.env.PRIMITIVE_TRIAL_INBOX,
    inkboxInbox: process.env.INKBOX_TRIAL_INBOX,
  },
});
const proxy = createProxyHandler(services, {
  // Omit to allow only the documented Primitive and Inkbox API routes.
  allowedUpstreams: {
    'primitive-email': { origin: 'https://api.primitive.dev', pathPrefixes: ['/v1/send-mail', '/v1/emails'] },
    'inkbox-email': { origin: 'https://inkbox.ai', pathPrefixes: ['/api/v1/mail/mailboxes'] },
    'postpigeon-email': { origin: new URL(process.env.BODEGA_PUBLIC_URL!).origin, pathPrefixes: ['/postpigeon/messages'], allowPrivate: process.env.BODEGA_SANDBOX_MODE === 'simulated' },
  },
});
// HTTP handler: const response = await proxy(request); null means route not handled.
// On shutdown: await runtime.close();
```

Blaxel mode additionally needs the optional `@blaxel/core` package plus `BL_API_KEY` and `BL_WORKSPACE`. The backend can accept an injected `BlaxelSDK` for tests. It calls the current SDK's create/get/delete, filesystem write and process exec APIs. Only `BODEGA_TOOL_BASE_URL` and `BODEGA_TOOL_KEY` are injected into the sandbox; upstream credentials are leased inside the server proxy. SDK process `timeout` is in **seconds**; `keepAlive: true` ensures an execution deadline actually kills the process. A separate deadline kills/deletes ambiguous detached work. Trial creation passes a provider TTL, and a local 30-second reaper retries owned expired/ended sandbox cleanup. The reaper is process-local; provider TTL handles crashes, and a durable fleet-wide reconciler is still needed for production.

The runtime deduplicates starts, limits local concurrent trials per listing, refuses reset-by-ending within a session, checks expiry before runs, confines uploaded files to `/blaxel/app`, bounds run time and output, and closes comparisons' sandboxes. Runtime options include `maxRunTimeoutMs` (55 seconds default), `maxOutputBytes` (12 KB per stream), `reaperIntervalMs`, and an injectable `now`. Fleet-wide concurrency requires a shared admission lease in the ledger; the current contract does not provide one. `runs` trials debit once per execution; API-call trials debit at the proxy. `sandbox_minutes` proxy billing is deliberately refused pending a defined time-metering contract.

`email.roundtrip` is the implemented standard check. Primitive needs an existing managed `PRIMITIVE_TRIAL_INBOX`. Inkbox accepts `INKBOX_TRIAL_INBOX`, or reads an existing mailbox via `/mail/mailboxes?limit=1`; it does not create paid/new identities. Both self-send a unique tagged message, then poll inbound mail through the proxy, measuring send and delivery latency. PostPigeon demonstrates receive-scope failure. Provisioning and email checks are **implemented but have not been run against cloud providers** in this development session: no Blaxel or provider credentials were present. Other check IDs return an explicit unsupported result.

The simulated backend never evaluates code or calls providers. Its deterministic comparison results carry `[SIMULATED]` labels and make no performance recommendation. Simulation is useful for UI/integration rehearsal and is not evidence of a real email round trip.

## Proxy contract

`createProxyHandler({vault, ledger}, options)` returns `(request: Request) => Promise<Response | null>`. The proxy reserves one credit **before** forwarding. `ledger.recordUsage` must atomically refuse over-limit requests by throwing an error with `code: 'QUOTA_EXCEEDED'`, without incrementing usage. A successful result with `exhausted: true` admits the final allowed call. Failed upstream requests still count because a request was admitted. Shared pool admission must be atomic in the ledger; a preflight trial read alone is insufficient under concurrency.

Paid project keys are supported by an optional `resolvePurchasedKey(token)` callback supplied by Stream A. Return `null` for unknown/unpaid keys, or `{ listing_id, lease_id, expires_at, consume }`; `consume(): Promise<boolean>` atomically reserves one purchased API credit. Return `false` when exhausted. This callback must verify actual entitlement/payment state; the runtime never invents paid ledger records.

Optional `paymentRequired(listingId): Promise<Response>` lets the storefront produce an official MPP challenge. Without it, depletion returns ordinary JSON HTTP 402 with no fabricated protocol fields. Other proxy options: injected `fetch`, exact `allowedUpstreams`, `timeoutMs` (15 seconds), `maxRequestBytes` (256 KB), `maxResponseBytes` (1 MB), and `now`. Private/local upstreams require explicit trusted configuration. Keep policy values under server control; never derive them from agent input or arbitrary public vendor listings. Only allow API paths with understood semantics.

Caller auth, cookies, forwarding and hop headers are dropped. Only content-type, accept, idempotency-key and prefer are passed through; the vendor auth header is replaced from the Vault. Redirects are refused, paths are checked for traversal/encoded separators, hosts must match configured origins, responses are size-bounded text/JSON, and reflected upstream secrets are redacted. Raw provider errors, headers and credentials are not logged or returned. Injected fetch implementations must honor AbortSignal.

## Verification

```sh
npm run typecheck
npx tsx --test src/runtime/runtime.test.ts
```

Tests cover quota admission and final-credit boundaries, pooled refusal, credential separation/header replacement, redirect and unsafe-path denial, expiry, lifecycle cleanup, timeout destruction, file confinement, output limits, paid-key authorization, simulation labeling, and SDK timeout units.

Primary API references checked during implementation:

- https://docs.blaxel.ai/Sandboxes/Processes.md
- https://docs.blaxel.ai/Sandboxes/Variables-and-secrets.md
- https://github.com/blaxel-ai/sdk-typescript
- https://docs.primitive.dev/llms.txt
- https://inkbox.ai/docs/api/mail/mailboxes.md
- https://inkbox.ai/docs/api/mail/messages.md
