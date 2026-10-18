# Bodega — submission

**YC "Make Something Agents Want" hackathon, Oct 17–18 2026.** Team: Kaushik Kanna, Sami, Amedeo Ercole.

## Two-sentence description

Bodega is a corner store where the customer is an agent: an MCP server where a coding agent finds competing developer tools, trials each one in a real sandbox on the vendor's dime, and buys the winner within a budget its human set. Agents today only have the tools a human wired in before the task started; Bodega lets them shop mid-task, and gives vendors a funnel that says why they won or lost.

## Links

| | |
|---|---|
| Repo | https://github.com/kaupau/yc-hackathon-make-something-agents-want |
| Video | `experiments/bodega/demo/out/bodega-demo.mp4` — 1:50, 1080p, narrated, 19 MB (also attached to the submission form) |
| Live storefront | https://bodega-production-4802.up.railway.app |
| Back office (vendor funnels) | https://bodega-production-4802.up.railway.app/portal |
| MCP endpoint via Manufact gateway | `https://warm-spark-aqsz0.run.mcp-use.com/mcp` (bearer agent token required) |
| Agent docs | https://bodega-production-4802.up.railway.app/llms.txt |
| Claude Code / Codex plugin | `experiments/bodega/plugin/` (marketplace at repo root) |
| Six-agent swarm demo | `experiments/bodega/swarm/` (`npm run swarm`) |
| Sister experiment, hosted on Manufact | `experiments/marketplace-mcp/` — cross-marketplace search + arbitrage MCP (`dark-spark-ysobu`) |

## What the video shows, and what is real

Everything in the video was recorded against a running Bodega (the merged code in `bodega/`), not mocked:

- **Storefront and back office**: the live pages. The receipt's numbers come from the ledger.
- **The agent run** (terminal scene): a real headless Claude Code session on `claude-sonnet-5-5` with the Bodega MCP connected. `compare` booted real **Blaxel** sandboxes and ran an `email.roundtrip` check through Bodega's metering proxy against **Primitive**'s real API (send 738 ms, deliver 270 ms). `buy` produced a real **Stripe sandbox** PaymentIntent (`pi_3URqmh2M1S84n0j812RwPky6`, test card, $2.00). 12 turns, 25 s, $0.26 of API spend.
- **The swarm floor**: six scripted agents against a private local Bodega in simulated mode (trials and payments labelled as simulated on the page). Caps, the human veto, the server-side cap refusal and the shared board are real logic; the provider calls are not.
- Inkbox and PostPigeon fail their round trips on camera on purpose: Inkbox has no key configured, PostPigeon is a mock vendor whose receive endpoint refuses. Bodega never ranks a provider on simulated timings.

## Tracks

| Track | What to look at |
|---|---|
| **Manufact — Best MCP server** | One MCP server, eight tools (`need`, `start_trial`, `run_trial`, `compare`, `buy`, `wallet`, `review`, `use`), fronted by the Manufact gateway (`warm-spark-aqsz0`) with analytics on. Demoed in Claude Code (plugin + headless), the MCP Inspector, and raw Streamable HTTP. |
| **Stripe — agents in the economy** | Budget cap and approval threshold per human; atomic reservation before charge; idempotent purchases; verified receipts gate tool access; Stripe sandbox PaymentIntents and webhooks; official `mppx` Machine Payments Protocol adapter at `/mpp/:purchase_id`; Connect destination charges to a synthetic Express seller. |
| **Blaxel — something a human would never want** | Every trial is a Blaxel microVM; `compare` fans the same check across sandboxes; the swarm runs six agents at once. No human wants to trial three email providers before writing one line of code. |
| **Primitive — agent communication** | Real send/receive round trip in a trial; per-customer isolated inboxes; approval emails to the human via Primitive. |
| **Inkbox — agent identity** | Inkbox is a listed real provider (adapter written, no credentials yet, fails honestly). |
| **InsForge — agent-native cloud** | Shared wallets, trial admission, vendor funnels and customer identities live in InsForge (Postgres RPCs, migrations in `migrations/`). |
| **Armature — agent experience** | Tool results stay under ~200 tokens, prices and trial quotas sit in tool descriptions, `use()` covers clients that never refresh tool lists, `llms.txt` and `/.well-known/mpp` discovery. |

## Try it in two minutes

```sh
claude plugin marketplace add kaupau/yc-hackathon-make-something-agents-want
claude plugin install bodega@bodega      # then /plugin configure bodega@bodega → paste your agent token
```

Ask: *"Our support bot must email customers and read their replies. Find a provider, prove it works, buy it within $5."* An agent token binds the agent to a wallet with a cap and threshold; the operator issues it from `/admin/customers/console`.

Run the swarm locally:

```sh
cd bodega && npm ci && cd ../experiments/bodega/swarm && npm ci && npm run swarm
```

## Honest status

- Working: the full loop (search → trial → compare → buy → review → use) against Primitive, with real sandboxes and sandbox payments; the plugin; the swarm; the hosted store on Railway behind Manufact.
- Not yet: real listings beyond email (the other categories are mock vendors); a buyer wallet that settles MPP (the server side is implemented and tested); Inkbox credentials; self-serve agent tokens; OAuth on `/mcp`. The ordered list is in `todo/`.
