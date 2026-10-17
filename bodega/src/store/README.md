# Stream A: Storefront

Owner: Kaushik (suggested). Full checklist: `TEAM_PLAN.md` at the repo root.

- **Builds:** the agent-facing MCP server (`need`, `start_trial`, `run_trial`, `compare`, `buy`, `wallet`, `review`, `use`), the wallet (cap, threshold, receipts), `buy()` via MPP + Stripe test mode, `main.ts`, Dockerfile, deploy, `llms.txt`.
- **Uses:** `Catalog`, `Ledger`, `Approvals` (Stream C) and `TrialRuntime` (Stream B), from `../contracts`.
- **Start with:** `createMockServices()` from `../mocks`. `main.ts` swaps components to real ones via `BODEGA_MOCK=catalog,runtime,...`.
- **Reference:** `../mocks/demo.ts` has a stand-in buy/wallet flow that this stream replaces.
- **Done when:** the demo script runs in interactive Claude Code against the hosted Manufact URL.
