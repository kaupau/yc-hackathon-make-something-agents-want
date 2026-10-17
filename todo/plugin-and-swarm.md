# Plugin and swarm follow-ups

## Plugin (`experiments/bodega/plugin`)

Verified: `claude plugin validate` passes for the plugin and for the repo marketplace. Installing from the local marketplace with `--config agent_token=…` loads the skill and shows `plugin:bodega:bodega … ✔ Connected` in `claude mcp list` against a local Bodega.

- [ ] **Codex:** run `codex plugin marketplace add kaupau/yc-hackathon-make-something-agents-want`, install from `/plugins`, and confirm Codex asks for the bearer token and lists Bodega's tools. If the CLI doesn't prompt, use the `[mcp_servers.bodega]` + `bearer_token_env_var` fallback in the plugin README and note which path works. Not tested: Codex wasn't available in the build environment.
- [ ] **Hosted end-to-end in Claude Code:** install with a real token for `https://bodega-production-4802.up.railway.app`, then ask "find and trial email providers that can send and receive, then buy one within my budget". Check that the skill fires before any web search.
- [ ] **Repo visibility:** `marketplace add kaupau/...` needs read access to this repo. For judges, either make it public or move the plugin and both marketplace files to a small public repo.
- [ ] **claude.ai and ChatGPT directories:** both prefer OAuth to a fixed bearer token (see [3-buy.md](3-buy.md)). Submitting to either directory waits on that.
- [ ] Optional: send MCP server `instructions` from Bodega's `/mcp` that say the same thing as the skill, so clients without the plugin still learn "shop here first".

## Swarm (`experiments/bodega/swarm`)

Verified: scripted brain end to end against a fresh local Bodega (simulated trials and payments, labeled as such); `npm test` passes; replay published privately at https://claude.ai/artifact/6DrTrGpdz5mZwu7tuUaGNE.

- [ ] **Run against the hosted Bodega** for real Blaxel trials and Stripe sandbox receipts: `BODEGA_URL=https://bodega-production-4802.up.railway.app BODEGA_ADMIN_TOKEN=… npm run swarm`. Expect differences: Inkbox has no key there, so its roundtrip should fail; trial admission is capped at 3 active sandboxes (`BODEGA_MAX_ACTIVE_TRIALS`), so agents will queue. Record the replay for the demo.
- [ ] **Claude brain:** `npm run swarm:claude` with `ANTHROPIC_API_KEY` set. It typechecks but has not run. Watch turn counts and cost on the first run, then decide whether to show it live or as a replay.
- [ ] Update missions once real listings exist ([1-search.md](1-search.md)), so the swarm buys real providers instead of mocks.
- [ ] Optional: show the plugin flow in the swarm by giving one agent the plugin skill text as its system prompt.
