# Sponsor tools and tech

YC "Make Something Agents Want", 2026-10-17/18, YC HQ. Idea not locked yet; this is the toolbox, independent of what we build. Checked 2026-10-17 against the [event page](https://events.ycombinator.com/MakeSomethingAgentsWant), the [YC chat](https://messages.ycombinator.com/messages/267340) and each sponsor's docs. Submissions + live demos **Sun 10:00 AM**, judging done 11:00, winners 12:15. Lightning talks 12:15 PM and 6:00 PM Saturday.

Each track is judged by that sponsor's founders, so whatever we build should use the sponsor's product for real, not mention it.

| Sponsor | Track | 1st prize | Judges |
|---|---|---|---|
| Manufact (mcp-use) | Best MCP server for agents | $2,000 + $6,000 credits | Luigi Pederzani, Enrico Toniato, Andrew Khadder |
| Primitive.dev | Best agent communication setup | **$3,000 cash** (2nd $2k, 3rd $1k) | Ethan Byrd, Ashley Ha, Ben Poile |
| Stripe | Agent safely participates in the economy | $3,000 credits + Atlas fee waived; $500 credits to every team | — |
| Armature | Best agent experience (AX) | $1,000 + $1,000 credits | Theodore Otzenberger, Louis Scremin |
| Inkbox | Persistent agent identity (email, phone, iMessage, A2A) | $1,000 + $1,000 credits | — |
| InsForge | Agent-native cloud | $1,000 + $1,000 credits | Tony Chang Hang Huang |
| Blaxel | "Something a human would never want" | $1,000 gift card | — |
| Supabase | listed as sponsor, **no prize track on the page** | — | — |

## Manufact / mcp-use

- What: TypeScript MCP framework (`mcp-use`) + hosting (Manufact Cloud). Judges said in chat (11:06): *"mcp-use docs (use typescript)"* and *"Include a demo showing your MCP working in multiple clients."*
- Install: `npx create-mcp-use-app@latest <name>` or `npm i mcp-use`. Server: `new MCPServer({name, version})`, `server.tool({name, description, inputSchema: z.object(...), outputSchema?, annotations?, view?}, handler)`.
- Features worth knowing: `server.proxy({ns: {url, authToken}})` mounts upstream HTTP MCP servers under a namespace (needs `@mcp-use/client`); **MCP Apps** = a tool bound to a React View (`views/<name>/view.tsx`, `useToolContext`) rendered inside Claude and ChatGPT; `server/openapi` turns an OpenAPI spec into tools; `server/skills`; Inspector; `docs.mcp-use.com/tunneling`.
- Limit measured in `spike/`: the server is stateless (GET `/mcp` is 204, no session id); `notifyToolsChanged()` only reaches v2 clients with `subscriptions/listen`, which Claude Code 2.1.119 does not implement. So no "tool appears mid-session" trick on mcp-use; the official SDK does it (see `spike/http-server.mjs`).
- Deploy: `npx mcp-use login`, then `npx mcp-use deploy --name <name>` (GitHub-backed) or `--no-github` (uploads local source). Flags: `--env`, `--env-file`, `--dockerfile <path>`, `--build-command`, `--start-command`, `--new`, `-y`. Copy the MCP URL from the dashboard, do not guess it. Link file `.mcp-use/cloud/link.json` (gitignored here).
- Docs: https://docs.mcp-use.com/v2/typescript/getting-started/welcome, agent index https://docs.mcp-use.com/llms.txt. Slides https://www.figma.com/slides/mOvdCkHbcctsbqrCXCAaX8. Discord https://discord.com/invite/XkNkSkMz3V. GitHub https://github.com/mcp-use/mcp-use.

## Primitive.dev

- What: email for agents. One API to send, receive inbound as signed JSON, and run **hosted Functions** (JS handler executed on every inbound email). Every account gets a managed `*.primitive.email` subdomain, verified by construction. `primitive chat <email> "<question>" --json` sends and returns the threaded reply in one call. Also an MCP server at `https://www.primitive.dev/mcp`.
- Install: `npm i -g @primitivedotdev/cli`, `primitive login` or `PRIMITIVE_API_KEY` (dashboard primitive.dev/app/settings/api-keys). REST base `https://api.primitive.dev/v1` (`POST /v1/send-mail`, Bearer `prim_...`). Run `primitive sending:get-send-permissions` once before the first send. SDKs: Node, Python, Go.
- Free tier: $5/month credits, no card.
- Docs: https://docs.primitive.dev (markdown mirrors at `/docs/*.md`, `/llms.txt`, `/llms-full.txt`).

## Stripe

- Track text: "buy products, provision services, manage business spending, or pay for the resources it needs… clear control over what their agents can do and spend."
- Relevant tech: **Machine Payments Protocol (MPP)**, the open 402 flow with an **MCP binding** (JSON-RPC error `-32042`, credential in `params._meta["org.paymentauth/credential"]`, receipt in `result._meta["org.paymentauth/receipt"]`). TypeScript SDK `mppx@0.13.5` (exports `mcp/server`, `mcp-sdk/server`, `mcp/client`, `stripe/server`, `stripe/client`, `proxy`, `discovery`); validate with `npx mppx@latest validate`. Shared Payment Tokens (test helper `POST /v1/test_helpers/shared_payment/granted_tokens`, preview `Stripe-Version` header). Link Agent Wallet via `npx @stripe/link-cli` (live-mode story only). Stripe Directory indexes MPP endpoints (preview sign-up).
- Caveats seen: SPT card minimum $0.50; a Stripe profile id is the MPP `networkId`.
- Docs: https://mpp.dev, https://mpp.dev/protocol/transports/mcp, Stripe agentic commerce docs. Keys in Doppler, never in the repo.

## Armature

- What (**armature.tech**, not armature.com which is a game studio): product analytics for agent sessions. An SDK wraps the MCP server (listed: official MCP SDK 1.x/2.x, Mastra, fastmcp, mcp-handler; Python FastMCP; Go; PHP — mcp-use not listed, test it), sessions are replayed and scored, use cases and issues grouped. **Evals**: you write cases, a real agent plays the user, a judge scores. Armature is also an MCP server you can connect to Claude Code to query the analytics. Agent discoverability panel + agent.reviews.
- Setup: sign up at https://app.armature.tech/signup (free, no card), create an ingest key, add the SDK, deploy.
- Docs: https://docs.armature.tech (quickstart, `sdks/typescript`, `evaluation/eval-cases`, `armature-mcp/connect`, `/llms.txt`).

## Inkbox

- What: one identity per agent with email (`<handle>@inkboxmail.com`), phone + SMS + **iMessage**, an internet address/tunnel (`<handle>.inkboxwire.com`), and A2A. CLI, SDK, skill and MCP. Agent self-signup exists (`POST /api/v1/agent-signup/`, human gets a 6-digit code).
- Offer (chat, 11:26, Ray Liao): **100 identities per team; stop by the booth to raise the quota.**
- Install: `npm i -g @inkbox/cli`, `INKBOX_API_KEY`, base `https://inkbox.ai/api/v1`, header `X-API-Key`. `inkbox identity create <handle> --imessage-enabled`. Phone: `POST /phone/numbers {agent_handle, type:"local", state:"CA"}` (1 per identity, 3 per org). iMessage: `POST /messages {to, text}`; webhooks `POST /webhooks/subscriptions {agent_identity_id, url, event_types:["imessage.received"]}`.
- Caveats: the shared iMessage line only replies to people who first text `connect @<handle>` to the router number; no links or media before the recipient's first reply (422).
- Docs: https://inkbox.ai (docs linked from there).

## InsForge

- What: open-source agent-operated backend: Postgres (+pgvector), Auth, Storage (S3-compatible), Realtime, Edge Functions (Deno), Sites, Compute, Model Gateway (OpenAI-compatible). OpenAPI specs also cover `payments`, `email`, `schedules`, `secrets`.
- Install: `npx @insforge/cli login` and link a project, or MCP `npx add-mcp https://mcp.insforge.dev/mcp` (Claude Code, Cursor, Codex). SDK `@insforge/sdk`: `createClient({baseUrl, anonKey}).database.from('t').insert(...)`. The MCP exposes a skill resource `mintlify://skills/insforge`.
- Docs: https://docs.insforge.dev.

## Blaxel

- What: microVM sandboxes (boot in ms, scale to zero after ~5 s idle), MCP server hosting (streamable HTTP only, 15 min max runtime, Blaxel Store of prebuilt servers), agent hosting, batch jobs, model APIs. Sandboxes include a built-in MCP server.
- Install: Blaxel CLI (`bl`), then **`bl skills install`** gives Claude Code/Cursor/Codex the Blaxel skills. SDK `@blaxel/core` (0.3.30, 2026-10-15): `SandboxInstance.createIfNotExists({name, image:"blaxel/base-image:latest", memory, region})`, `sandbox.process.exec({command, waitForCompletion:true})`. Env `BL_API_KEY`, `BL_WORKSPACE`. Console app.blaxel.ai.
- Credits/limits: Kaushik has $500 YC credits to apply. Concurrency tiers 0/1/2 = 10/50/200 sandboxes at free/$20/$50 top-up; unknown whether promo credits move the tier.
- Docs: https://docs.blaxel.ai.

## Supabase

- Sponsor on the page, no prize track or judges listed. Check the lightning talks before spending time on it.

## Our own infra that is already in hand

- Kelam REST (`https://api.kelam.sh`, header `X-Kelam-Password`; `POST /calls`, `GET /calls/{id}`, `POST /messages`, `GET /agents`, `GET /quotas`). Workspace is `capped: true`, check quotas before relying on calls.
- Doppler for every key (proposed project `bodega`, config `dev`). Stripe account exists.
- Confirm with an organizer at kickoff that pre-existing infra and accounts are fine and only hackathon code must be new.
