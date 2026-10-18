# Experiments scoreboard

One folder per idea. Copy `_template/` to start one. Update the row when the status changes so we can see at a glance what is worth more time.

Status ladder: `idea` → `building` → `demoable` (ran end to end once) → `shipped` (submitted) / `dropped`.

| Experiment | One-liner | Tracks | Status | Smallest test done? | Verdict |
|---|---|---|---|---|---|
| [bodega](bodega/) | Agent shops for capabilities mid-task and pays from a human-set budget | Manufact, Stripe, Primitive, Inkbox, Blaxel, Armature, InsForge | **demoable** (platform in `/bodega`, hosted on Railway; [swarm demo](bodega/swarm/)) | yes: six-agent swarm trials, compares and buys within per-human caps, approvals and a veto, end to end locally (`bodega/swarm`, `npm test`) | strong; real-provider swarm run against the hosted Bodega still to record |
| [tool-trials](tool-trials/) | Agent asks `which_tool(task)`; sandboxes trial every candidate and return a ranking with evidence | Blaxel, Manufact, Armature | idea | no | — (merge path into bodega via `need(task)`) |
| [marketplace-mcp](marketplace-mcp/) | One MCP to search/compare across eBay, Grailed, Amazon + any server-rendered marketplace via `add_marketplace(url)`; Jev relevance, photo match, catch check; `arbitrage()` | Stripe, Blaxel, Manufact, Armature | **hosted on Manufact** (`dark-spark-ysobu.run.mcp-use.com/mcp`, branch `exp/marketplace-mcp`) | yes: 6 marketplaces live from the hosted URL; Claude Code runs the buyer's-agent flow against it ($0.12) | strongest candidate so far; needs sold comps + submission write-up |

## How we judge an experiment
- Does it use the sponsor's product for real (judges are the founders)?
- Does the two-minute demo have one moment nobody else in the room has?
- Did the smallest test pass in under two hours? If not, drop or shrink.
- Which prizes does it plausibly reach, and how much cash is that (see `../SPONSORS.md`)?
