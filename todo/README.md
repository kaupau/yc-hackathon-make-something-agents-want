# Bodega to-do

What it takes to make Bodega work end to end for real: an agent **searches** for a tool, **tests** it like a playground, **buys** it within the human's budget, and **uses** it inside a codebase. Written 2026-10-17 evening, after merging `codex/storefront` and building the swarm demo and the plugin. Check items off in place and commit the change with the work.

| File | Step |
|---|---|
| [1-search.md](1-search.md) | Real listings and ranking |
| [2-test-playground.md](2-test-playground.md) | Checks per category, real upstreams, a playground page |
| [3-buy.md](3-buy.md) | Credits, real payments, self-serve customers |
| [4-use-in-codebase.md](4-use-in-codebase.md) | From a purchase to working code and `.env` |
| [plugin-and-swarm.md](plugin-and-swarm.md) | Verify the Codex plugin, run the swarm for real, OAuth |

## Order for Sunday 10:00

1. **Fix the one-credit limit** on non-email purchases ([3-buy.md](3-buy.md)). Small change; without it every non-email purchase works exactly once.
2. **Make one more category real end to end**, most likely a database: real listing, upstream route, check adapter, `use`/codebase handoff ([1](1-search.md), [2](2-test-playground.md), [4](4-use-in-codebase.md)).
3. **Record the swarm against the hosted Bodega** with real Blaxel trials. Needs `BODEGA_ADMIN_TOKEN` from Railway's variables ([plugin-and-swarm.md](plugin-and-swarm.md)).
4. **Simple playground page** for trials ([2-test-playground.md](2-test-playground.md)).
5. **Self-serve agent tokens** so a judge can install the plugin without the operator ([3-buy.md](3-buy.md)).

## Working today

- Platform in [`/bodega`](../bodega/): MCP tools `need`, `start_trial`, `run_trial`, `compare`, `buy`, `wallet`, `review`, `use`; per-customer tokens and wallets; human approval links; Stripe sandbox PaymentIntents; MPP/SPT with Stripe's test helper; InsForge shared backend; Railway deploy at `https://bodega-production-4802.up.railway.app` with real Blaxel sandboxes and a verified Primitive send/receive roundtrip.
- Swarm demo in [`experiments/bodega/swarm`](../experiments/bodega/swarm/): six agents, separate wallets, approvals, a veto, a cap refusal, a shared board and vendor funnels. Locally the trials and payments are simulated and labeled as such. `npm test` covers the run.
- Plugin in [`experiments/bodega/plugin`](../experiments/bodega/plugin/): Claude Code install validated and connected to a local Bodega. Codex files are written to OpenAI's docs but untested.
