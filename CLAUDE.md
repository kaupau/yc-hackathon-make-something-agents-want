# Hackathon repo: YC "Make Something Agents Want" (2026-10-17/18)

Team: Kaushik + Sami. The idea is not locked. Layout: `SPONSORS.md` is the sponsor toolbox; `experiments/<name>/` is one folder per idea with a README (status, tracks, hypothesis, smallest test, result) and `experiments/README.md` is the scoreboard; `experiments/_template/` is the starter; `shared/` holds code used by more than one experiment. Bodega (capability store MCP) is the first candidate in `experiments/bodega/` with its plan and spike.

When starting a new idea: copy `experiments/_template/` to `experiments/<name>/`, fill the README, add a row to the scoreboard. When an experiment changes status, update both its README and the scoreboard row in the same commit. Keep experiment code inside its folder; promote to `shared/` only when a second experiment needs it.

## Build against current sponsor docs, not memory

Fetch these before writing code that touches a sponsor product:

- mcp-use (Manufact): https://docs.mcp-use.com/llms.txt
- Primitive: https://docs.primitive.dev/llms.txt (full corpus `/llms-full.txt`)
- Armature: https://docs.armature.tech/llms.txt
- InsForge: MCP at https://mcp.insforge.dev/mcp (skill resource `mintlify://skills/insforge`)
- Blaxel: `bl skills install` (installs Blaxel skills for coding agents), docs https://docs.blaxel.ai
- Stripe MPP: https://mpp.dev/protocol/transports/mcp
- Inkbox: https://inkbox.ai

## Rules

- No secrets in the repo: keys live in Doppler (`doppler run -p bodega -c dev -- ...`) or Manufact env vars. `.env*` and `.mcp-use/cloud/link.json` are gitignored.
- Kelam is a live, funded workspace with a quota: check `GET /quotas` before test calls, and prefix test-call prompts with "hackathon test".
- Stripe stays in test mode for the whole event.
