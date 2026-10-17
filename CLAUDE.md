# Hackathon repo: YC "Make Something Agents Want" (2026-10-17/18)

Team: Kaushik + Sami. The idea is not locked; see `SPONSORS.md` for the sponsor toolbox and `PLAN.md` for one candidate ("Bodega", a capability store MCP) with its spike results in `spike/`.

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
