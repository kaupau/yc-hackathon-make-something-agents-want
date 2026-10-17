# Stream B: Trial runtime

Owner: Sami (suggested). Full checklist: `TEAM_PLAN.md` at the repo root.

- **Builds:** `TrialRuntime` (from `../contracts/services.ts`) on Blaxel sandboxes, the metering proxy at `/proxy/:token/*`, the `email.roundtrip` adapters for Primitive and Inkbox, and parallel `compare`.
- **Uses:** `Vault` (leases the real vendor key; it never enters a sandbox) and `Ledger` (`recordUsage` on every proxied call, `getTrialByToken`), both from Stream C.
- **Start with:** `../mocks/runtime.ts` shows the expected shapes and canned results. Swap them for real measurements.
- **Env inside each sandbox:** `BODEGA_TOOL_BASE_URL=https://<host>/proxy/<token>` and `BODEGA_TOOL_KEY=<token>`.
- **Done when:** `compare(["primitive-email","inkbox-email","postpigeon-email"])` returns real results in under 60 s.
