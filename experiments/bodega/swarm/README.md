# Bodega swarm floor

Six agents with six different jobs shop at one Bodega at the same time. Each one is a separate Bodega customer with its own bearer token, MCP session, wallet cap and approval threshold, and its own (scripted) human answering approval emails. They call `need`, run vendor-funded trials (`start_trial`, `run_trial`, `compare`), share findings on a swarm board, `buy` within budget, `review` the winners and losers, and try what they bought with `use`. At the end the run pulls Bodega's vendor funnel: what every vendor learned about why agents chose or passed on them.

| Agent | Job | Cap / ask above | What the run shows |
|---|---|---|---|
| Waitlist builder | Store signups, send confirmations people can reply to | $5.00 / $1.00 | Compares three email providers; PostPigeon fails receive; buys Primitive after human approval, TableTop for Postgres |
| Price-watch scout | Nightly competitor price diff | $3.00 / $1.00 | Trials and instant buys under the threshold |
| Dinner concierge | Book a table by phone, leave a voice confirmation | $4.00 / $1.00 | Buys a buy-only phone call; human vetoes the optional voice purchase |
| Dashboard login | Signup, login, sessions | $3.00 / $1.00 | Trial, approval, buy |
| Support triage | Answer and log customer email on $2.50 | $2.50 / $1.00 | Reads the board: skips PostPigeon, reuses the database trials, picks Inkbox + Quarry because Primitive + a database would not fit the cap |
| Over-eager intern | Buy one of everything | $2.50 / $1.00 | Human declines the big items; Bodega refuses the rest at the cap server-side |

## Run it

```sh
cd bodega && npm ci && cd ..          # once: the swarm boots this Bodega locally
cd experiments/bodega/swarm && npm ci
npm run swarm                          # live floor at http://127.0.0.1:8790, ~15 s run
```

Flags: `--pace 0` (flat out) or `--pace 2` (slower for a stage), `--agents waitlist,support`, `--once` (exit after writing the replay), `--no-dashboard`, `--quiet`. Every run writes `runs/<timestamp>/report.html`, a self-contained replay of the floor (approval links, project keys and trial tokens are redacted).

By default the swarm boots a private Bodega with simulated trials and simulated payments, so a run costs nothing and touches no sponsor account. The page and every result say so: Bodega's simulated runtime accepts commands without executing them, and its comparisons are labeled and never ranked. Agents decide from fit and price when nothing was measured, and say that in their reviews.

**Against the hosted Bodega** (real Blaxel sandboxes, Stripe sandbox, Primitive): `BODEGA_URL=https://bodega-production-4802.up.railway.app BODEGA_ADMIN_TOKEN=… npm run swarm`. The admin token provisions one customer per agent (ids `swarm-<agent>-<run>`) and answers the approval inbox. It lives in Railway's variables, not in this repo.

**Claude as the brain:** `npm run swarm:claude` (needs `ANTHROPIC_API_KEY` or an `ant auth login` profile). Each agent becomes a Claude tool-use loop over Bodega's own MCP tools plus `board_read`, `board_post`, `wait_for_approval` and `finish`. Defaults: `claude-opus-5-5`, `--effort medium`, server-side refusal fallback on. This spends real API money: roughly six agents × 15–30 turns.

## How it fits together

| File | Role |
|---|---|
| `src/swarm.ts` | CLI and orchestrator: boot or target Bodega, create customers, run agents in parallel, serve the floor, write the replay |
| `src/missions.ts` | The six jobs, budgets and each human's approval policy |
| `src/agent.ts` | One MCP client per agent; every call becomes an event |
| `src/brains/scripted.ts` | Deterministic shopper: plans the budget across needs, trials, ranks, buys, reviews |
| `src/brains/claude.ts` | Claude shopper over the same tools |
| `src/board.ts` | Swarm memory: claim a topic, post findings, peers wait instead of re-trialing |
| `src/desk.ts` | The humans: read the operator approval inbox, apply each policy, answer the one-use link |
| `src/page.ts` | Live floor and replay page |

`npm test` runs the whole swarm against a fresh local Bodega and checks caps, the veto, the cap refusal, board reuse, the support agent's budget trade-off and log redaction. `npm run typecheck` checks types.
