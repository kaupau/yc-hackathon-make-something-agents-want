# 4. Use it inside the codebase

After `buy`, the agent should leave the project with working code: credentials in a gitignored `.env`, names in `.env.example`, the SDK installed, and a call that works.

## Where it stands

- `buy` returns `project_key` and `base_url` (`<bodega>/proxy/<project_key>`). The key is in the URL path, and the proxy adds the real vendor credential, so the repo never holds the vendor's own key.
- The proxy only forwards Primitive (`/v1/send-mail`, `/v1/emails`) and Inkbox mailbox paths for purchased keys (`allowedUpstreams` in `bodega/src/server.ts:248`).
- `use` has adapters only for Primitive `send_email`/`ask_by_email`/`read_inbox` and Inkbox `send_email`/`read_inbox` (`Storefront.use`, `bodega/src/store/storefront.ts:394`). Other real listings fail with `ADAPTER_UNAVAILABLE`; mock listings return `Simulated capability; no provider request executed`.
- Mock listings declare no tools (`adds_tools: []`), so buying them enables nothing in the MCP session.
- The plugin skill (`experiments/bodega/plugin/skills/bodega/SKILL.md`) tells the agent how to write `.env` and `.env.example` safely. Bodega itself gives no machine-readable integration bundle, so each agent improvises.

## To do

- [ ] Choose per listing how access is delivered, and record it on the listing:
  - **Proxy** (current model): Bodega keeps the vendor key and meters calls. Needs full allowlisted API paths per vendor.
  - **Provisioned credentials**: Bodega provisions a real account or project through Stripe Projects (`stripe projects add <provider>/<service>`, then `env --pull`) and returns real env vars. Better for databases, where SDKs expect a connection string, not an HTTP proxy. Must not double-bill when Projects already bills the provider (`TEAM_PLAN.md` § Stripe Projects).
- [ ] Return an integration bundle from `buy` (or a new `integrate(listing_id)` tool): the env var names and values to write, the package to install, a minimal code sample using those env vars, and a smoke command. The skill then becomes "write these files, run the smoke command".
- [ ] Extend `use` adapters, or generate them from the listing's tool definitions, for each real listing with `adds_tools`.
- [ ] Key lifecycle: show usage and remaining credits in `wallet`; rotate a project key; warn before the 30-day expiry; revoke on refund.
- [ ] Add a swarm or plugin test that buys a real listing on the hosted Bodega, writes `.env` in a temp repo, and runs the smoke command successfully.

## Done when

In a fresh repo with the plugin installed, "add a signup database to this app" ends with a passing smoke test against the purchased database, the credential only in gitignored `.env`, and the variable names in `.env.example`.
