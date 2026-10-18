# 1. Search: real listings, real ranking

`need(capability)` should return providers an agent can actually trial, buy and use, ranked by fit.

## Where it stands

- The catalog is the 11 seed listings in `bodega/src/mocks/seed.ts`. Only **Primitive** is real and verified (hosted send/receive roundtrip). **Inkbox** is a real provider with no key configured. **Kelam phone call** and **Ten minutes of a human** are buy-only and marked `real: false`. TableTop, Quarry, GateKeep, Callwire, Seekr, Relay and PostPigeon are mock vendors.
- Ranking counts how many query words appear as substrings in name, category, one-liner and keywords: `bodega/src/vendor/data.ts:21` (local SQLite) and `bodega_vendor_listing_search` in `migrations/20261017213502_shared-vendors.sql` (InsForge, `strpos`). Short words such as "a" or "to" match every listing, and there is no weighting by field or category.
- `need()` returns no `category` field (`summarize` in `bodega/src/store/mcp.ts`), so agents can't filter by category without guessing from `checks`.
- Vendors can't list themselves: `PUT /portal/listings/:id` needs the operator's admin token.

## To do

- [ ] Add real listings for the categories we demo. The Stripe Projects catalog is the fastest supply: Neon or Supabase (database), Clerk (auth), Resend or AgentMail (email), Browserbase (search/scrape), E2B (sandbox). Get exact service ids with `stripe projects catalog <provider>` (see `TEAM_PLAN.md` § Stripe Projects). Each real listing needs an upstream entry (see [2-test-playground.md](2-test-playground.md)).
- [ ] Mark listings honestly: keep `real: false` on mocks, and drop or hide mocks from `need()` on the hosted Bodega once real ones exist in the same category.
- [ ] Rank better: drop stop words, weight category and keywords above the one-liner, and boost listings whose check has passed recently (data is already in the vendor funnel). Apply the same change to both the SQLite and InsForge search paths.
- [ ] Return `category` (and the check id) from `need()` so agents can filter without guessing.
- [ ] Optional: let a vendor submit a listing for operator review instead of needing the admin token.

## Done when

`need("postgres database for signups")` on the hosted Bodega returns a real database listing first, with category, price, trial allotment and check, and no unrelated email or phone listings above it.
