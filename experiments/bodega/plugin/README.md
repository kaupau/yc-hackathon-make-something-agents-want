# Bodega plugin for Claude Code and Codex

Gives a coding agent the Bodega store as a first-class tool. When a task needs a service the project lacks (email, database, auth, search, queues, voice, phone), the agent calls Bodega's `need`, runs vendor-funded trials, buys inside the human's budget, and wires the purchased access into `.env`. It doesn't search the web for providers or sign up for accounts.

One folder serves both hosts:

| File | Read by | Purpose |
|---|---|---|
| `.claude-plugin/plugin.json` | Claude Code | Manifest. Prompts at install for the Bodega URL and the agent token; the token is stored in the OS credential store, not in settings |
| `.mcp.json` | Claude Code | Bodega MCP over HTTP with `Authorization: Bearer ${user_config.agent_token}`; `alwaysLoad` keeps the eight tools in view without a tool-search step |
| `plugin.json` | Codex / ChatGPT (portable Agent Plugins manifest) | Manifest plus `extensions.com.openai.interface` for the plugin browser |
| `mcp.json` | Codex / ChatGPT | Bodega MCP as `streamable-http` with bearer API-key auth supplied at connection setup |
| `skills/bodega/SKILL.md` | both | When to shop at Bodega instead of the web, how to trial, decide, buy, handle approvals, and wire keys into the codebase |

The marketplaces live at the repo root: `.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex).

## Get an agent token

Each agent needs its own `bdg_agt_…` token, which binds it to one customer wallet (cap and approval threshold). The Bodega operator issues it in the operator console at `/admin/customers/console`, or with `npm run customers -- create --email you@example.com --cap 1000 --threshold 100` in `bodega/`. The token is shown once.

## Install in Claude Code

```sh
claude plugin marketplace add kaupau/yc-hackathon-make-something-agents-want
claude plugin install bodega@bodega --config agent_token=bdg_agt_…
```

Or inside a session: `/plugin marketplace add kaupau/yc-hackathon-make-something-agents-want`, `/plugin install bodega@bodega`, then `/plugin configure bodega@bodega` to enter the token. `bodega_url` defaults to the hosted store; pass `--config bodega_url=http://127.0.0.1:8787` for a local one. The skill pre-approves the read-only and trial tools (`need`, `wallet`, `start_trial`, `run_trial`, `compare`, `review`). `buy` and `use` still ask for permission, on top of Bodega's own budget and approval gates.

Verified here: `claude plugin validate` passes for the plugin and the marketplace; installing from the local marketplace with a token loads the skill and shows `plugin:bodega:bodega … ✔ Connected` in `claude mcp list` against a local Bodega.

## Install in Codex

```sh
codex plugin marketplace add kaupau/yc-hackathon-make-something-agents-want
codex            # then /plugins, pick the Bodega marketplace, install
```

The plugin declares bearer API-key auth, so Codex asks for the token when you connect it. If your Codex CLI build doesn't prompt, configure the server directly in `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`) and keep the skill from the plugin:

```toml
[mcp_servers.bodega]
url = "https://bodega-production-4802.up.railway.app/mcp"
bearer_token_env_var = "BODEGA_AGENT_TOKEN"
```

Not verified here: no Codex install was available in this environment. The files follow OpenAI's current plugin docs (portable `plugin.json` + `mcp.json` + `skills/`, repo marketplace at `.agents/plugins/marketplace.json`).

## What the agent gets

`need` → listings with price, trial allotment, check and whether the provider is real or simulated. `start_trial` / `run_trial` / `compare` → vendor-funded sandbox trials. `buy` → `paid` with a scoped `base_url` (the project key is in its path; Bodega's proxy adds the real vendor credential), `needs_approval` (human gets a one-use link the agent never sees), or `declined`. `review` → feeds the vendor's funnel. `use` → calls a purchased tool when the client didn't refresh its tool list.
