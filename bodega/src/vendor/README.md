# Stream C: Vendor side

Owner: third teammate. Full checklist: `TEAM_PLAN.md` at the repo root.

- **Builds:** `Catalog`, `Vault`, `Ledger`, `Approvals` (from `../contracts/services.ts`) on InsForge Postgres, the vendor portal (`/portal`), the PostPigeon mock vendor (HTTP API + `provision_webhook`; its receive endpoint fails on purpose), and approval over email (`/approve/:id`).
- **Start with:** the in-memory versions in `../mocks/` (`catalog.ts`, `vault.ts`, `ledger.ts`, `approvals.ts`) and the seed data in `../mocks/seed.ts`. The mocks stay as the fallback.
- **Secrets:** vendor keys come from env/Doppler (`PRIMITIVE_API_KEY`, `INKBOX_API_KEY`), never from the repo.
- **Done when:** the portal shows a live funnel from a real compare + buy, and the approval email round trip works.
