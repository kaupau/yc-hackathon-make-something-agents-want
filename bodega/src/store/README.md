# Stream A: Storefront

Owner: Kaushik (suggested). Full checklist: `TEAM_PLAN.md` at the repo root.

- **Builds:** the agent-facing MCP server (`need`, `start_trial`, `run_trial`, `compare`, `buy`, `wallet`, `review`, `use`), the wallet (cap, threshold, receipts), `buy()` via MPP + Stripe test mode, `main.ts`, Dockerfile, deploy, `llms.txt`.
- **Uses:** `Catalog`, `Ledger`, `Approvals` (Stream C) and `TrialRuntime` (Stream B), from `../contracts`.
- **Start with:** `createMockServices()` from `../mocks`. `main.ts` swaps components to real ones via `BODEGA_MOCK=catalog,runtime,...`.
- **Reference:** `../mocks/demo.ts` has a stand-in buy/wallet flow that this stream replaces. Note: `demo.ts` uses `receipt_id: "pi_mock_1"` as a placeholder — the real store must only call `Ledger.updatePurchase({status:"paid", receipt_id})` with a confirmed Stripe `pi_…` id.
- **Payment obligations (see TEAM_PLAN.md Shared contracts and `docs.stripe.com/agentic-commerce/monetize-mcp`):**
  - Atomically reserve budget before calling Stripe.
  - Idempotency key on every PaymentIntent create: `${session_id}:${listing_id}:${attempt}`.
  - **Receipt gate:** retrieve the PaymentIntent server-side (`stripe.paymentIntents.retrieve(id)`) and verify `pi.status === "succeeded"`, account/test-mode, `pi.amount_received === expected_cents`, `pi.currency`, and purchase binding in `pi.metadata` — all before enabling tools or returning a project key. A `pi_…` id prefix is not proof of payment.
  - **Network timeout / ambiguous:** keep the reservation; retrieve the stored PaymentIntent or recover a lost create response by replaying the identical create request with the original idempotency key. Only release after confirmed failure; never create a second charge while the first outcome is unknown.
  - Declined: release reservation, return `{declined: true, reason}`. Processing/pending: return `{payment_pending: true, receipt_id}`; do not enable tools.
  - On replay (same idempotency key, `status === "paid"`): return existing `Purchase` without re-charging.
- **Credit-pack pricing:** all `buy()` prices in `../mocks/seed.ts` are ≥ $0.50 (MPP card minimum). `phone-call` is $0.50/call. Do not add listings below $0.50; sell bundles instead.
- **Contract review:** reservation/reconciliation operations and pending/charging states are planned additions; the current scaffold does not implement them. Use integer cents and durable purchase/job IDs. See TEAM_PLAN.md for the proposed payment-attempt record.
- **Projects listings:** choose a provider-managed Projects billing path or an MPP credit purchase, prevent duplicate billing, and provision only from a verified catalog service mapping into the intended human-owned project. Keep credentials behind Vault. Projects discovery/provisioning is planned, not implemented here.
- **Stripe agent plugin:** run `claude plugin install stripe@claude-plugins-official` or `stripe agent setup` at the start of your build session.
- **Done when:** the demo script runs in interactive Claude Code against the hosted Manufact URL.
