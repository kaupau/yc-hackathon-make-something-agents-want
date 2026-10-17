# bodega: the capability store for agents

| | |
|---|---|
| Status | demoable: platform merged from `codex/storefront` into [`/bodega`](../../bodega/); [agent swarm demo](swarm/) runs end to end |
| Owner | Kaushik (server, payments), Sami (listings, human on stage) |
| Tracks | Manufact, Stripe, Primitive, Inkbox, Blaxel, Armature, InsForge |
| One-liner | An MCP server where the agent shops for capabilities mid-task (`need` → `buy` → tools appear) and pays from a budget the human set. |

## Hypothesis
Judges reward a working product with real money movement and a human-set spending limit more than a framework. One server can credibly hit six sponsor tracks because each shelf is a sponsor API.

## Done looks like
Two-minute live demo in Claude Code: buy a phone call (Kelam) under the threshold, buy email (Primitive), buy ten minutes of a human (Inkbox iMessage to Sami), close on the wallet ledger and the Stripe test dashboard. Hosted on Manufact.

## Smallest test
Deploy a hello-world mcp-use server to Manufact and call one priced tool from Claude Code with an MPP 402 round trip paid in Stripe test mode. If that is not green in two hours, shrink to the ledger fallback.

## Plan
See [PLAN.md](PLAN.md) (§7 = sponsor brief check, §8 = alternative framing). Spike results (dynamic tools across clients) in [spike/](spike/).

## Code
- [`/bodega`](../../bodega/): the platform (MCP storefront, trials, wallet, Stripe sandbox, InsForge), merged from `codex/storefront`. Hosted at `https://bodega-production-4802.up.railway.app`.
- [`swarm/`](swarm/): six agents with separate wallets find, trial, compare and buy dev tools at the same time; live floor plus shareable replay. `cd swarm && npm ci && npm run swarm`.

## Result
_fill in after the demo or when abandoned: what worked, what did not, judge reactions, prize._
