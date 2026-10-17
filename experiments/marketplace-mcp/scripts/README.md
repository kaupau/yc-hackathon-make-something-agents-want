# scripts

One-off runs used on 2026-10-17; run from `experiments/marketplace-mcp/` with `doppler run -p agents-want -c dev --`.

- `usecases.sh` – sweep a list of product queries through the running server's `arbitrage` tool into `.cache/usecases/*.json`
- `usecase_table.py` – summarize that sweep as a markdown table
- `build-page.mjs` – render the sweep as a standalone HTML page (photos embedded) for an artifact
- `ga-analysis.ts` – price a store's inventory (greenairlines.us) against Grailed asks and sold comps, screen replicas, find genuine sourcing below the store price (uses the adapters and Jev directly)
- `build-ga-page.mjs` – render that analysis as a page
