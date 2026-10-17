# 3. Buy: credits, real money, self-serve customers

## Where it stands

- Works in the Stripe sandbox: reservation before charge, idempotent request ids, approval links above the threshold, PaymentIntents with signed webhooks, MPP/SPT using Stripe's test helper, and Connect destination charges to one synthetic Express seller (PostPigeon) with zero marketplace fee. See the "Payments and approvals" and "Official agent-to-agent MPP adapter" sections in `bodega/README.md`.
- **Bug:** a non-email purchase gets exactly one credit. `reserve(..., l.category === "email" ? 1000 : 1, ...)` in `bodega/src/store/storefront.ts:231`. After one `use` or one proxied call the purchase is spent, whatever the listing's `unit_label` says ("first month", "10 minutes").
- Customers and agent tokens are created only by the operator (admin token, `/admin/customers/console` or `npm run customers`). No signup, and no OAuth on `/mcp`.
- No real buyer wallet issues SPTs; `/health` reports that gap. Live mode, real seller onboarding (KYC), refunds and disputes, and tax are not configured.

## To do

- [ ] Fix credits: add a credit count to each listing's `price` (e.g. `price.credits`, or derive it from `unit_label`) and pass that to `reserve` instead of `1`. Add a test that a database purchase supports more than one call.
- [ ] Self-serve customer: a signup page that creates the customer with a default cap and threshold, sends the approver a confirmation through Primitive, and shows the agent token once. Keep the operator console for overrides.
- [ ] OAuth for `/mcp`, so Bodega works as a claude.ai custom connector and in the ChatGPT/Codex plugin directory, which prefer OAuth to fixed bearer tokens. Map the OAuth subject to a customer wallet.
- [ ] Top-ups and renewals: let the human raise the cap or buy more credits from the approval email instead of the operator console.
- [ ] Before any live money: real seller onboarding per vendor (Connect Express with real KYC), a refund/dispute path, a buyer wallet that issues SPTs (Link agent wallet once it supports thresholds; see `experiments/bodega/PLAN.md` §2), and Stripe Tax. Stripe stays in test mode for the whole event (repo rule).

## Done when

A new user signs up, gets a token, installs the plugin, and their agent buys a real database listing in the Stripe sandbox. The purchase supports many calls until its credits run out, and the human approves anything above their threshold from email.
