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

## Findings 2026-10-17 ~16:25 PT (Kaushik's session, hosted Bodega on Railway)

**Plugin.** `claude plugin validate` failed on Claude Code 2.1.119 (`displayName`, root `description`); fixed in PR #4. Install path that works headlessly: `claude plugin marketplace add <repo path>` then `claude plugin install bodega@bodega`; this build has no `--config` flag, so the token is entered with `/plugin configure` in a session. Headless proof instead: fresh `CLAUDE_CONFIG_DIR`, plugin installed, the same server passed via `--mcp-config` with the bearer, `claude -p --model claude-sonnet-5-5`. The agent used `need`, `wallet`, `compare`, `review`, quoted the skill's 5xx rule, bought nothing when told not to: 10 turns, $0.28, 21 s. Skill fires.

**Full flow on the hosted store.** `start_trial(primitive-email)` → `compare(email.roundtrip)` on the demo wallet passed with real Blaxel + Primitive: send 599 ms, deliver 325 ms (23:24Z). `buy` on Railway returns `ready (mpp)` because `BODEGA_PAYMENT_FLOW=mpp`: nothing without an MPP buyer wallet settles it, reservations stay, and the cap then refuses later buys. For a demo that must end in `paid`, set the Railway service to `BODEGA_PAYMENT_FLOW=direct` (sandbox test card, already verified) and redeploy, or settle MPP with Stripe's test helper from the client.

**Swarm against hosted** (`--once --pace 0`): 0/6 finished. Causes, from Railway logs (the `[bodega] tool … failed:` lines): `Global sandbox limit reached` (BODEGA_MAX_ACTIVE_TRIALS=3 vs six agents starting at once; clears after the 5-minute trial TTL), `Shared vendor backend unavailable` / `Shared wallet unavailable` on the InsForge RPC under that burst, `Approval delivery failed` on the Primitive approval email, mock vendors answering 403 (nothing serves their upstream on hosted), and the MPP `buy` above. Single-agent run also failed while the cap was full. To record a real hosted swarm: `--agents waitlist --pace 2` after the cap clears, with `direct` payments.

**Demo hazard.** A session's trial allotment never resets and the Railway demo wallet (`BODEGA_WALLET_ID=railway-demo`) is shared: any rehearsal that trials Primitive on it consumes the one allotment, and the next agent sees "Trial check could not complete" with no trial_id. Give the stage agent a fresh customer token from the operator console before each rehearsal.
