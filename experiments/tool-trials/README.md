# tool-trials: trial-based reviews ("Yelp for agent tools")

| | |
|---|---|
| Status | idea (proposed by a teammate 2026-10-17 12:15) |
| Owner | — |
| Tracks | Blaxel, Manufact, Armature (Stripe, Inkbox, Primitive, InsForge have nothing to judge) |
| One-liner | An agent asks `which_tool(task)`; sandboxes run the same task against every candidate tool and return a ranking with evidence (success, latency, tokens, cost). |

## Hypothesis
Tool descriptions lie and agents pay in tokens to find out. Reviews verified by construction (every review carries its task, tokens, latency, success and cost) never get the fake-review problem, and live trials mean no cold start. The 20-sandboxes-same-task demo is the best "something a human would never want" moment on the board.

## Done looks like
Claude Code calls `which_tool("fetch the title of this page")`. Twenty Blaxel sandboxes spin up, each runs a different fetch tool, results stream into a table, the winner comes back with evidence and the agent uses it. `trial(task, tool)` and `evidence(run_id)` expose one run and its raw log.

## Smallest test
Three candidates for one capability (plain fetch, TinyFish, a Blaxel-hosted headless browser) fanned out to three sandboxes with a mechanical check (page title equals expected). If the fan-out and check are not green in two hours, the idea is a slide.

## Worries
Overlaps two judges' own products (Manufact's cross-client test suites, Armature's agent runs with traces); frame as the public cross-vendor layer above them. Must be agent-consumed (an MCP call, not a leaderboard). Scoring must be mechanical checks, not an LLM judge.

## Merge path with bodega
`need(capability, task?)` runs trials before it recommends: candidate listings are tested in sandboxes against the agent's task and the winner is the one sold. Full assessment and one-afternoon scope in [../bodega/PLAN.md §8](../bodega/PLAN.md).

## Result
_fill in._
