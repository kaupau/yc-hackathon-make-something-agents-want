# YC "Make Something Agents Want" hackathon

Kaushik + Sami, YC HQ, 2026-10-17/18. Submissions and live demos Sunday 10:00 AM.

| Where | What |
|---|---|
| [SPONSORS.md](SPONSORS.md) | Sponsor toolbox: each product, install, docs, offers, judges, prizes |
| [experiments/](experiments/) | One folder per idea, with a scoreboard in `experiments/README.md` |
| [experiments/_template/](experiments/_template/) | Copy to start a new experiment |
| [shared/](shared/) | Code or scripts more than one experiment uses (sponsor clients, Doppler run helpers) |
| [bodega/](bodega/) | The Bodega platform (MCP store, trials, wallet, payments), merged from `codex/storefront` |
| [experiments/bodega/plugin/](experiments/bodega/plugin/) | Bodega as a Claude Code / Codex plugin: `/plugin install bodega --marketplace kaupau/yc-hackathon-make-something-agents-want` |
| [CLAUDE.md](CLAUDE.md) | Rules for Claude Code sessions working in this repo |

## Working agreement
- Try small. Every experiment names its smallest test; build that first, then decide.
- Update the scoreboard row when status changes, not at the end.
- Secrets only in Doppler (`doppler run -p bodega -c dev -- ...`); nothing in the repo.
- Stripe test mode only. Kelam has a quota; prefix test-call prompts with "hackathon test".
