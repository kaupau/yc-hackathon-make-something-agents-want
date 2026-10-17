# Bodega: the capability store for agents

Build plan for the YC "Make Something Agents Want" hackathon. Sat 2026-10-17 10:30 AM to Sun 2026-10-18 10:00 AM, YC HQ. Team: Kaushik + Sami. Written 2026-10-17 07:50 PT.

Working name "Bodega" (rename freely). Everything below was checked against sponsor docs or run on this laptop this morning; dates and caveats are inline.

---

## 1. Pitch and demo

**Pitch (one paragraph).** Agents only have the tools a human wired in before the task started. Every MCP config, API key and phone number was provisioned in advance by a person; when the agent hits a wall it cannot go buy the thing it needs, it just fails. Bodega is an MCP server where the agent shops for capabilities mid-task and pays for them from a budget the human set. It calls `need("make a phone call")`, gets a listing with a price, `buy()`s it, and the tools appear in the running session. The human sees a cap, an approval threshold, a ledger and a receipt. The inventory is other people's agent infrastructure sold per use: phone minutes, inboxes, identities, sandboxes, page fetches, and ten minutes of a human.

**Two-minute demo script.** Claude Code on the projector, connected to one MCP server, no other tools.

1. Prompt: *"Find out if Zuni Café is open tonight and email the answer to kaushikpa@gmail.com."*
2. Agent calls `need("phone call")`. Bodega returns one listing: `phone-call`, $0.40 per call, budget remaining $5.00.
3. Agent calls `buy("phone-call")`. Under the hood the shelf answers with an MPP 402 challenge, Bodega checks the human's policy (under the $1 threshold, within the $5 cap), mints a $0.40 shared payment token, retries, the receipt comes back inside the tool result, the payment appears in Stripe test mode with the listing name, and `call_phone` appears in the session (dynamic mode; in locked mode the agent calls the priced `call_phone` directly and the same payment happens inline).
4. Agent calls `call_phone` with a goal. Kelam dials. 30 to 60 seconds of real audio on the speaker (or the sim receptionist, see §6). Structured answer comes back: `{open_tonight: true, closes: "10pm"}`.
5. Agent calls `need("send email")`, buys `email`, sends the answer via Primitive. The receipt email for the whole session lands in Kaushik's inbox on screen.
6. Kicker: *"Also get me a photo of the front door."* Agent buys `human`, $2 for ten minutes. Sami's phone buzzes with an iMessage from the agent's Inkbox identity. Sami photographs the door and replies. The photo comes back into the session.
7. Close on `wallet()`: five purchases, $3.15 spent of $5.00, one approval threshold hit and auto-approved under $1, Stripe dashboard payments tab, Manufact analytics showing the tool calls.

Line to end on: *"Nothing was pre-installed. The agent decided, the agent paid, the human set the limit."*

---

## 2. Architecture

**One MCP server, TypeScript, the official `@modelcontextprotocol/sdk` (1.32.1, the one the spike proved), Streamable HTTP with sessions, deployed on Manufact Cloud with a Dockerfile.** Kaushik lifted the mcp-use-SDK constraint at 11:30; Manufact hosting stays required. Start from `spike/http-server.mjs` (it already has the per-session `StreamableHTTPServerTransport`, the GET stream and `registerTool(...).disable()/.enable()`). Ship with `mcp-use login` then `mcp-use deploy --no-github --dockerfile Dockerfile -y` (the deploy CLI accepts `--dockerfile <path>` inside the repo; first deploy writes `.mcp-use/cloud/link.json`, later deploys update the same server). Hosted URL shape: `https://<slug>.run.mcp-use.com/mcp`. Secrets go in with `--env-file` or the Manufact dashboard, never in the repo. Every listing calls an HTTP API, because nothing on the laptop is reachable from Manufact. Dockerfile: `node:22-slim`, `npm ci`, `node dist/server.js`, `PORT` from env, `HOST=0.0.0.0`.

**Dynamic tools, and the one-flag fallback.** Listing tools are registered at startup and `.disable()`d; a purchase calls `.enable()`, the SDK sends `tools/list_changed`, and interactive Claude Code re-fetches the list and the tool appears mid-session (verified on this laptop over stdio and over the SDK's Streamable HTTP, §spike table). Every tool description carries its price anyway, and every handler checks the wallet before running, so the **locked-tool pattern is the same code with one flag**: `LOCKED_TOOLS=1` registers everything enabled from the start, and an unpurchased call returns the MPP 402 result and Bodega auto-pays within policy. **The fallback is a flag, not a rewrite.** Flip it if the noon smoke test (§5) shows Manufact's gateway drops the GET stream, or for headless clients, which never re-fetch.

**Tools exposed from the start**

| Tool | Does | Returns (keep it under ~150 tokens) |
|---|---|---|
| `need(capability)` | Keyword match over the listing registry | `[{id, price_usd, adds_tools[], one_line}]`, `budget_remaining` |
| `buy(listing_id, reason?)` | Budget check, approval check, charge, ledger, enable tools | `{receipt_id, charged_usd, budget_remaining, tools_now_available[]}` |
| `wallet()` | Budget, spent, ledger | `{cap, spent, remaining, ledger[]}` |
| `use(listing_id, tool, args)` | Fallback executor for clients that don't refresh tool lists | whatever the tool returns |

**Listing tools** (one per listing, §3): `call_phone`, `send_email`, `ask_by_email`, `ask_human`, `run_sandbox`, `fan_out`, `fetch_page`, `create_identity`. Each description ends with its price, e.g. `Costs $0.40 per call, auto-paid from your budget under $1.00; above that call buy() first.` Disabled until bought in dynamic mode; always visible in locked mode. An unpurchased call under the threshold is paid and executed in one round trip, with the receipt in the result. Over the threshold, or over the cap, the result is `{payment_required: true, price, budget_remaining, approve_url}` and nothing runs. `use(listing, tool, args)` stays as a plain alias for clients that never refresh their tool list.

**Wallet state.** With sessions, one process serves the whole demo, so the wallet (cap, spent, purchases, ledger) is an in-memory map keyed by MCP session id, plus a `BODEGA_WALLET_ID` default so a reconnect keeps the same budget. That is acceptable for the demo. InsForge Postgres is the durable option for the InsForge track if time allows, not a prerequisite; wire it behind the same `wallet.ts` interface. One caveat to check at noon: whether Manufact runs more than one replica or recycles the process between requests; if it does, the in-memory wallet resets and InsForge moves up to required.

**Tool-refresh spike results (this laptop, Claude Code 2.1.119). Add a fourth row at noon for the hosted Manufact URL (§5):**

| Server | Mode | Result |
|---|---|---|
| Official SDK, stdio | Interactive `claude` | Works: `tools/list` re-fetched 3 ms after `list_changed`, new tool used |
| Official SDK, stdio or Streamable HTTP | Headless `claude -p` | Never re-fetches, NOT AVAILABLE |
| **mcp-use 2.10.0, Streamable HTTP** | Interactive `claude` | **NOT AVAILABLE: runtime `tool()` throws, `GET /mcp` is 204, no channel** |

Reproduce with `spike/mcpuse-server.mjs` (`node mcpuse-server.mjs`, then `claude --mcp-config mcp-http.json` pointed at port 4848) and `spike/stdio-server.mjs`.

**Server shape**

```
bodega/
  src/server.ts        McpServer + StreamableHTTPServerTransport per session (from spike/http-server.mjs), GET stream on
  src/registry.ts      listings: id, price, keywords, tools[], handler module; registerTool + disable() unless LOCKED_TOOLS=1
  src/wallet.ts        cap, threshold, purchases, ledger: in-memory map per session (InsForge behind the same interface, optional)
  src/pay.ts           MPP shelf + payment-aware client, Stripe test mode
  src/listings/*.ts    one file per listing (§3), each an HTTP client to a sponsor API
  llms.txt             agent-facing docs: what it sells, prices, how to connect, the onboarding prompt
  Dockerfile           node:22-slim, npm ci, node dist/server.js
  .mcp-use/cloud/link.json   written by the first `mcp-use deploy`
```

**Payments: every listing is a Machine Payments Protocol (MPP) 402 challenge over the MCP transport, paid with Stripe in test mode. The human's budget is the credential's limit. A plain ledger is the fallback only if the SDK fights us.**

MPP (mpp.dev, Stripe + Tempo) is the open 402 flow: server returns a challenge, client presents a credential, server settles and returns a receipt. It has an **MCP binding** (`/protocol/transports/mcp`): the challenge is JSON-RPC error `-32042` with `error.data.challenges[]`, the credential rides the retry in `params._meta["org.paymentauth/credential"]`, and the receipt comes back in `result._meta["org.paymentauth/receipt"]`. The TypeScript SDK `mppx` ships it today: **`mppx@0.13.5` installed this morning in `spike/http/node_modules`, exports include `mppx/mcp/server`, `mppx/mcp-sdk/server`, `mppx/mcp/client` (`McpClient.wrap`), `mppx/stripe/server`, `mppx/stripe/server/spt`, `mppx/stripe/client`, `mppx/proxy`.** Stripe's own page says to validate with `npx mppx@latest validate` and that a sandbox key auto-completes round-trip test transactions. Almost nobody in the room will know MPP has an MCP binding; say it out loud to the Stripe judge.

*Two halves inside one process.*

1. **Shelves: each listing's tools are MPP-priced MCP tool calls.** Server side, from mpp.dev/guides/monetize-mcp-server plus the Stripe method:
   ```ts
   import Stripe from 'stripe'
   import { Mppx, Transport, stripe } from 'mppx/server'        // stripe/server: charge({client, networkId, paymentMethodTypes:['card']})
   const mppx = Mppx.create({
     methods: [stripe.charge({ client: new Stripe(process.env.STRIPE_SECRET_KEY!), networkId: process.env.STRIPE_PROFILE_ID!, paymentMethodTypes: ['card'] })],
     transport: Transport.mcpSdk(),                               // encode Challenge/Receipt as JSON-RPC
   })
   server.registerTool('call_phone', {...}, async (args, extra) => {
     const r = await mppx.charge({ amount: '0.40', description: 'phone-call' })(extra)   // reads _meta credential
     if (r.status === 402) throw r.challenge                      // -> JSON-RPC -32042 with the challenge
     return r.withReceipt({ content: [...] })                     // -> receipt in result._meta
   })
   ```
   Settlement is a Stripe `PaymentIntent` created from the shared payment token (SPT) in the credential; the Stripe dashboard shows every tool call as a payment with the listing name.

2. **Store: Bodega is the payment-aware client that holds the human's credential and pays on the agent's behalf.** Claude Code is not an MPP client and cannot answer `-32042`, so the agent's `buy()`/tool calls go through Bodega's `McpClient.wrap` (`mppx/mcp/client`), configured with `stripe({ createToken, paymentMethod: 'pm_card_visa' })` from `mppx/stripe/client`. `createToken` calls the Stripe **test helper** to mint an SPT scoped to the listing price:
   ```bash
   curl https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens \
     -u "$STRIPE_SECRET_KEY:" -H "Stripe-Version: 2026-09-30.preview" \
     -d payment_method=pm_card_visa -d "usage_limits[currency]=usd" \
     -d "usage_limits[max_amount]=40" -d "usage_limits[expires_at]=1798761600"
   ```
   **The human's budget lives on the credential side**: a session cap (`$5.00`) and a per-purchase threshold (`$1.00`) are enforced in `McpClient.wrap`'s `onPaymentRequired(challenge)` hook, which returns `false` (no pay, surface `{needs_approval, approve_url}` to the agent) when the challenge exceeds the threshold or would breach the cap, and otherwise mints an SPT capped at exactly the challenge amount. Every receipt (`org.paymentauth/receipt`) is appended to `wallet()` and echoed in the tool result so the agent sees what it paid.
   Live-mode equivalent for the slide: Link Agent Wallet (`npx @stripe/link-cli`), where the human's approval policy and daily limits are Stripe-side; not needed for the demo.

*Discovery.* `mppx/discovery` publishes an OpenAPI-style document of priced endpoints, so an agent knows prices before calling. Serve it at `/.well-known/mpp` next to `llms.txt`. Stripe Directory indexes MPP endpoints; listing is a preview sign-up (one POST to `docs.stripe.com/preview/register` with `preview: "stripe_directory_mcp_server_listing_preview"`), do it Saturday night, say "listed in the Stripe Directory preview" only if they reply.

*Fallback (only if mppx fights us by 2:30 PM).* Keep the same tool surface, drop the 402 round trip: `buy()` creates a `PaymentIntent` directly (`payment_method_data[shared_payment_granted_token]=spt_...` from the test helper, or plain `pm_card_visa`), writes a ledger row, enables the tools. Budget, threshold, receipt and the dashboard story survive; only the "402 over MCP" line is lost. Caveats seen in the docs: SPT minimum is $0.50 for card payments, so price listings at $0.50+ if the minimum is enforced in test mode; preview `Stripe-Version` headers; a Stripe profile (`profile_...`, or `profile_test_` in a sandbox) is the `networkId`.

**Receipt.** After every `buy()`, and at the end, a Primitive email to the human: `POST https://api.primitive.dev/v1/send-mail` with `PRIMITIVE_API_KEY`, or `primitive send --to ... --subject ... --body ... --wait`.

**Ledger.** In memory for the demo (see Wallet state). Durable option: InsForge Postgres (`@insforge/sdk`, `createClient({baseUrl, anonKey}).database.from('ledger').insert({...})`), table created via the InsForge MCP `run-raw-sql` or dashboard. Do not let InsForge block the core loop.

**Hosting.** Manufact Cloud via Dockerfile deploy, proven by noon with two checks at the hosted URL (§5): a hello-world tool call, and the interactive spike (tool enabled after 20 s, does Claude Code 2.1.119 see it through Manufact's gateway). Claude Code connects with `claude mcp add --transport http bodega https://<slug>.run.mcp-use.com/mcp`. **Fallbacks:** gateway drops the GET stream → flip `LOCKED_TOOLS=1`, stay on Manufact, note it in the spike table. Dockerfile deploy itself still failing at 13:00 → run the same server on the laptop with `node dist/server.js`, exposed through an Inkbox tunnel (`bodega-agent.inkboxwire.com`, created with the identity) or `cloudflared tunnel`, and connected to Manufact by URL for analytics. The listings do not change, since they already speak HTTP to every sponsor.

---

## 3. Listings

Each listing is one file exporting `{id, price_usd, keywords, tools: [{name, schema, handler}]}`. Prices are made up and small; they are the demo's ledger lines.

### 3.1 `phone-call` ($0.40) → `call_phone(number, goal, extract?)`
- **Kelam REST API, the same one the CLI uses** (read from `packages/cli/kelam_cli/main.py`): base `https://api.kelam.sh` (the `api_url` in `~/.config/kelam/config.json`), header `X-Kelam-Password: <password>`. The password goes into Manufact env vars as `KELAM_PASSWORD` (and Doppler `bodega/dev` for local runs), never into the repo, never into argv; Sami owns rotation.
- Place: `POST /calls` with `{"agent_id": "<agt_… or name>", "to_number": "+1…", "prompt": "<goal>", "extract": [{"name":"open_tonight","type":"boolean","description":"whether they are open tonight"}, {"name":"closes","type":"string","description":"closing time"}]}` → `{call_id, …}`. For the sim fallback send `"to_agent": "front-desk"` instead of `to_number`. Optional: `greeting`, `voicemail: "hangup"`, `language`, `context`.
- Wait: poll `GET /calls/{call_id}` every 2 s until `status` is terminal (`ended_at` set); read `answered_by`, `human_engaged`, `extracted`, `cost`. Mirror the CLI's `--wait` loop and its `extract` list shape (`_parse_extract_option` in the same file) so the field names match what the server expects.
- Agent ids: `GET /agents` lists them (`gabe` is the personal-assistant errand caller; `reservation-caller`, `pg-caller-gpt-realtime`, `front-desk`, `ivr-mapper` also exist). Resolve the name to its `agt_` id once at startup.
- Before dialing anything today: `kelam init` from the laptop (owner name + phone on the workspace lane), and one test call to Kaushik's own number from the deployed server with the prompt `"hackathon test, Kaushik is testing the Bodega phone listing"`.
- **Fallback on stage:** agent-to-agent call, no telephony, no voicemail risk: `to_agent: "front-desk"`, the workspace's stand-in receptionist that infers the business from the opening line. Decide at 15:00 after test-calling the real restaurant.
- Check `GET /quotas` (what `kelam status` reads) at kickoff; the workspace shows `capped: true`. A spent allowance refuses the call.

### 3.2 `email` ($0.10) → `send_email(to, subject, body)` and `ask_by_email(to, question)`
- Primitive. Auth: `PRIMITIVE_API_KEY` (dashboard primitive.dev/app/settings/api-keys) or `primitive login`. Install `npm i -g @primitivedotdev/cli`.
- Send: `POST https://api.primitive.dev/v1/send-mail` (Bearer `prim_...`), or `primitive send --to X --subject Y --body Z --wait`. Run `primitive sending:get-send-permissions` once before the first send.
- Ask-and-wait: `primitive chat <email> "<question>" --json` returns the threaded reply in one call. That is the Primitive track in one tool.
- Free tier: $5/month credits, no card.
- Fallback: Inkbox email from the identity in 3.3 (`identity.sendEmail({to, subject, bodyText})`).

### 3.3 `identity` ($0.25) → `create_identity(handle)`, `text(number, message)`
- Inkbox. `npm i -g @inkbox/cli`, `INKBOX_API_KEY`. Base URL `https://inkbox.ai/api/v1`, header `X-API-Key`.
- `inkbox identity create bodega-agent --display-name "Bodega"` → mailbox `bodega-agent@inkboxmail.com` + tunnel `bodega-agent.inkboxwire.com`.
- Phone number: `POST /api/v1/phone/numbers {"agent_handle":"bodega-agent","type":"local","state":"CA"}`; max 1 per identity, 3 per org; `sms_status` must be `ready`.
- iMessage: `inkbox imessage send --to +1... "text"` or `POST /messages {to, text}`. **Two caveats from the docs:** (a) the shared line can only reply to people who first text `connect @bodega-agent` to the router number (`GET` router endpoint), a dedicated line can start 1:1 chats; (b) before the recipient's first reply, a message cannot carry links or media (422 `imessage_reply_required_for_links_or_media`). So Sami connects and replies once before the demo.
- Agent self-signup exists (`POST /api/v1/agent-signup/`, human gets a 6-digit code) but create the identity by hand today.

### 3.4 `human` ($2.00 / 10 min) → `ask_human(task, deadline_s)`
- Sends the task to Sami over iMessage from the identity above, then waits for the reply.
- Reply path: **polling** `GET /messages?conversation_id=...` every 3 s from inside the tool call (Manufact has no inbound webhook target we control, and a single tool call can block for the ten minutes). Webhook `imessage.received` (`POST https://inkbox.ai/api/v1/webhooks/subscriptions {agent_identity_id, url, event_types:["imessage.received"]}`) only in the laptop fallback, through the Inkbox tunnel.
- Photo comes back as a media URL; return it to the agent as an image content block.
- Payout: a ledger line "owed to Sami $2.00" and a test-mode PaymentIntent. Real payouts need Stripe Connect; say so on the slide rather than fake it.
- Fallback: SMS via Kelam REST, `POST /messages {"agent_id","to_number":"+1<sami>","body":"<task>","channel":"sms"}`, replies via `GET /messages` on the same thread.

### 3.5 `sandbox` ($0.05 / min) → `run_sandbox(command)` and `fan_out(commands[])`
- Blaxel, on Kaushik's **$500 YC credits** (apply them in the console at app.blaxel.ai before kickoff). `npm i @blaxel/core` (0.3.30, published 2026-10-15, so the SDK is alive under the Blaxel name after the Baseten acquisition; docs at docs.blaxel.ai do not mention any rename). Env `BL_API_KEY`, `BL_WORKSPACE`. `SandboxInstance.createIfNotExists({name, image: "blaxel/base-image:latest", memory: 1024, region})`, then `sandbox.process.exec({command, waitForCompletion: true})` → `stdout/stderr/exitCode`. Boots in milliseconds, scales to zero after about 5 s idle.
- **The parallel moment: 25 sandboxes at once.** `fan_out` creates `bodega-1…25`, runs one command each, collects results. Cost is trivial (about $0.04 per GB-hour, so 25 × 1 GB × 2 min is under a nickel); the constraint is the **concurrency tier**: Tier 0 allows 10 sandboxes, Tier 1 ($20 top-up) 50, Tier 2 ($50) 200. The pricing page does not say whether promotional credits raise the tier. **Check the tier in the console at kickoff; if the $500 credit leaves it at Tier 0, top up $20 so 25 fits.** Delete the 25 after the run so the limit is free for the demo.
- Demo use: "no human wants this" moment, the agent buys 25 sandboxes and fans out 25 page checks or 25 Kelam sim calls in parallel.
- Fallback: `Promise.all` over the same commands against 10 sandboxes if the tier will not move; never run on the Manufact box itself.

### 3.6 `fetch` ($0.01) → `fetch_page(url, goal)`
- Plain `fetch` + readability-to-markdown, trimmed to the goal (goal-conditioned, token-cheap: the brief's "optimize token spend" line). Use TinyFish's fetch if its API key is handy, otherwise do not spend time here.

---

## 4. Sponsor checklist

Submit to every track below with the same build. Each judge is the founder; each line is the one thing they must see.

| Track | Must see | Done when |
|---|---|---|
| **Manufact** (best MCP server) | Hosted on Manufact Cloud, analytics on, publish checks run; test suite across GPT/Claude/Gemini if time. Using their tooling (deploy CLI, Inspector for the 402 demo) is a plus even without the mcp-use SDK | Hello-world and the hosted spike at `https://<slug>.run.mcp-use.com/mcp` by 12:00 (§5); session timeline screenshot in the submission |
| **Stripe** (agent spends safely) | **MPP 402 challenges over the MCP transport, with receipts.** Show one raw `-32042` challenge in the Inspector, then the retry with the credential, then the receipt in `_meta`, then the same payment in the test dashboard with the listing name. Then the human side: cap, threshold, the `needs_approval` refusal, the receipt email. Say "nobody else here knows MPP has an MCP binding" | `mppx` shelves + `McpClient.wrap` store live (§2). Discovery doc at `/.well-known/mpp`. Stripe Directory preview sign-up sent |
| **Blaxel** (something a human would never want) | Agent buys 25 sandboxes at once and fans a job out, paid per minute from a budget; an app store that bills per call while you work. Mention the $500 YC credits are what it runs on | `run_sandbox` + `fan_out` listings, tier confirmed at kickoff |
| **Inkbox** (persistent identity) | The agent's own identity texts a human over iMessage, the human replies, context carries | `identity` + `human` listings |
| **Primitive** (agent communication) | `ask_by_email` returning a threaded reply in one call; the session receipt arriving as email | `email` listing + receipt |
| **InsForge** (agent-native cloud) | Ledger and listings in InsForge Postgres, created through their MCP from Claude Code | `npx add-mcp https://mcp.insforge.dev/mcp`, then `run-raw-sql` for the two tables |
| **Armature** (agent experience) | Token-light tool results, prices in tool descriptions, `llms.txt`, a "paste this to your agent" onboarding prompt, and Armature's own run against the server with its trace | Sign up self-serve at armature.com (the YC P26 one, not the game studio), point it at the server URL Saturday evening |

**Accounts to create before kickoff** (do these on the way in; all free tiers, no card except Stripe which exists):
Stripe test keys + create a Stripe profile in the dashboard (needed for SPTs/MPP) · Manufact · InsForge project · Inkbox org + API key · Primitive API key · Blaxel workspace + API key · Armature self-serve · Link account for Kaushik (only for Layer B, `npx @stripe/link-cli auth login`).
Put every key in Doppler: new project `bodega`, config `dev`; run the server with `doppler run -p bodega -c dev -- npm run dev`. No keys in files.

Rules to confirm at kickoff: that pre-existing infra (Kelam, accounts) is fine and only the Bodega code must be written during the event. Ask an organizer at 10 AM.

---

## 5. Schedule and split

Core loop demoable by 5 PM dinner. Deploy and `llms.txt` by 9 PM. Two full rehearsals before midnight. Polish 8:00 to 9:30 AM Sunday. Submissions and live demos 10 AM.

**Kaushik:** Manufact two-check smoke test, server core (`need/buy/wallet/use`, registry with disable/enable and the `LOCKED_TOOLS` flag, prices in descriptions), MPP + Stripe test mode, `llms.txt`, demo driver and narration. InsForge wallet only if time.
**Sami:** listings (Kelam call, Inkbox identity + iMessage + human loop, Primitive email, Blaxel sandbox), the test calls, the tunnel, being the human on stage.

| Time | Kaushik | Sami |
|---|---|---|
| 08:00–10:00 (before) | Accounts, Doppler project `bodega`, Stripe profile, read this file | Accounts for Inkbox/Primitive/Blaxel, `kelam init`, test call to own number with `-p "hackathon test"`, text `connect @bodega-agent` to the Inkbox router |
| 10:30–12:00 | **Manufact deploy smoke test, two checks, before any listing work.** Copy `spike/http-server.mjs` into `bodega/`, add a `hello` tool and a Dockerfile, `mcp-use login`, `mcp-use deploy --no-github --dockerfile Dockerfile -y`, `claude mcp add --transport http bodega https://<slug>.run.mcp-use.com/mcp`. Check 1: call `hello` from Claude Code, see it in Manufact analytics. Check 2: run the interactive spike against the hosted URL (`buy_phone` enables `call_phone` after 20 s); if Claude Code sees it, dynamic mode stays on; if not, set `LOCKED_TOOLS=1` and record the row in §2's table. Then `--env-file` with a dummy secret to prove env injection. Deploy still red at 13:00 → laptop + tunnel | Create Inkbox identity + number, send first iMessage to self, confirm polling reply path; verify Kelam REST from curl with `X-Kelam-Password` (`GET /agents`, `GET /quotas`); apply the $500 Blaxel credits and read the tier |
| 12:00–12:45 | Lunch + lightning talks: note Blaxel and Supabase track details, adapt | same |
| 12:45–14:30 | MPP: `mppx` shelves (`Transport.mcpSdk`, `stripe.charge`), `McpClient.wrap` store with `createToken` → test-helper SPT, cap + threshold in `onPaymentRequired`, approve page. `npx mppx@latest validate`. **Go/no-go at 14:30**, else ledger fallback | `email` listing (Primitive send + chat), `identity` + `human` listing with polling |
| 14:30–15:30 | Wire the receipt email after each payment; InsForge wallet table via their MCP only if the core loop is green | Test-call the real restaurant from the deployed server. Decide real vs `front-desk` for the demo |
| 15:30–17:00 | **End-to-end run of the demo script in interactive Claude Code**, fix whatever breaks | `sandbox` listing + the ten-parallel moment; `fetch_page` only if idle |
| 17:00–18:30 | Dinner + lightning talks. Catch sponsor founders at tables: show them their listing, ask what would impress them | same |
| 18:30–21:00 | `llms.txt`, `/.well-known/mpp` discovery doc, onboarding prompt, Manufact analytics + publish checks, Armature run, Stripe Directory preview sign-up. Stop adding features at 21:00 | Tunnel for the server URL, Inkbox tunnel reuse; help with Manufact Dockerfile |
| 21:00–23:00 | Rehearsal 1 (timed, 2 min). Fix. Rehearsal 2 with Sami's phone on the table | Rehearsals; record a backup video of a clean run |
| 23:00 | Freeze. Sleep. | Sleep |
| 08:00–09:30 Sun | Fresh run on the projector laptop; re-run spike; charge phone; speaker volume | Fresh iMessage reply so links/media are allowed; `kelam status` quota check |
| 10:00 | Demo | Human |

**Prep list, first thing** (copy into a checklist): Stripe test keys + profile · Doppler `bodega/dev` · Inkbox identity + number + `connect` · Primitive key + `sending:get-send-permissions` · Blaxel key · InsForge project · Manufact account · Armature account · `kelam init` + test call · Kaushik's Link login (live-mode slide only) · Manufact smoke test · Blaxel credits applied + tier read · YC wifi test for outbound calls.

---

## 6. Risks, ranked, with the fallback

1. **Manufact deploy fights us** (Docker build, env injection, cold starts, a gateway that drops the GET stream, or multiple replicas resetting the in-memory wallet). Two-check smoke test first thing (§5). GET stream dropped → `LOCKED_TOOLS=1`, no rewrite. Replicas → InsForge wallet moves from optional to required. Deploy dead at 13:00 → laptop + tunnel. Never block the listings on it.
2. **The real restaurant goes to voicemail or hold.** Kelam leaves one voicemail by default (`--no-voicemail` to skip). Fallback: the `front-desk` agent-to-agent call, $0, no telephony, deterministic. Test the real place at 14:30 and again Sunday 8:30; if either fails, demo the sim and say so.
3. **iMessage first-contact rules.** No links or media before the recipient's first reply; shared line cannot start a 1:1. Sami connects and replies before the demo; Sunday morning send a fresh message and get a fresh reply. Fallback: SMS via Inkbox or `kelam text`.
4. **`mppx` MCP binding fights us.** The exports exist (verified in `mppx@0.13.5`), but nothing has been run end to end: `Transport.mcpSdk()` with our Streamable HTTP session handling, the `stripe/client` `createToken` path against the test helper, and `McpClient.wrap` as an in-process proxy are all untested. Spend 12:45 to 2:30 PM on it with `npx mppx@latest validate` and the Inspector; if any piece is still red at 2:30, switch to the ledger fallback in §2 and keep the tool surface identical. Preview `Stripe-Version` headers and the Stripe profile id are the likely snags.
5. **Kelam quota or Twilio.** Workspace is `capped: true`; check `plan.quotas` at kickoff. Fallback: agent-to-agent calls cost no telephony.
6. **YC HQ wifi and webhooks.** Polling for iMessage replies, not webhooks. Tunnel only for Manufact/Armature reaching the server; if the tunnel is flaky, record a backup video Saturday night.
7. **Tools don't "appear" for some client.** Headless clients never re-fetch, and Manufact's gateway is unverified until noon. The pitch works either way because prices are on every tool and auto-pay is the same code; `LOCKED_TOOLS=1` is the switch, and the measured client-behaviour table is a slide. Historical note below on why the mcp-use SDK was dropped.

   **Is the limit in the mcp-use SDK or in Manufact hosting? Checked 2026-10-17 11:20 PT.**
   - *SDK:* mcp-use 2.10.0 has no stateful or session mode. Its only related option is `legacy: "stateless" | "reject"` (`config.d.ts`): 2025-era clients get "a fresh instance over a session-less streamable HTTP transport (2025 session operations, GET and DELETE, and HEAD probes get an empty 204)". No `sessionIdGenerator`, no `enableJsonResponse`, no "stateful" anywhere in the shipped types or JS. Its notifications ride the MCP v2 `subscriptions/listen` channel only ("Only clients with an active `subscriptions/listen` request ... receive them"; "There is no session-targeted or arbitrary post-response push channel", notifications page). The Claude Code 2.1.119 binary contains zero occurrences of `subscriptions/listen`, so even a perfectly hosted mcp-use server cannot push a tools-changed notification to the demo client. Closed on both ends.
   - *Hosting:* Manufact's deploy accepts `--dockerfile <path>` (v2 deploy page), so an official-SDK server with sessions and a GET stream can be deployed there. Neither the deploy page nor the self-hosted page says anything about sticky sessions, long-lived GET streams, idle timeouts or notification passthrough, and the "connect external by URL" proxy is undocumented beyond the FAQ sentence. **Unverified either way.** Cost to find out: about 1 hour (Dockerfile the `spike/http-server.mjs` server, `mcp-use deploy --dockerfile`, run the interactive spike against the hosted URL). If it passes, `list_changed` is back on Manufact, but on the official SDK, which breaks the "build with the mcp-use SDK" constraint; the only way to keep both is the mcp-use server as the product plus a second, official-SDK deployment as the demo shim, which is two servers to keep in sync on hackathon day.
   - *Conclusion (superseded 11:30 when the SDK constraint was lifted):* with the mcp-use SDK fixed, the locked-tool pattern was the only Manufact-hosted option. Now the official SDK is hosted via Dockerfile, and the noon smoke test is the one-hour test described above, folded into the schedule.
8. **Scope creep.** MPP, InsForge, Armature and `fetch` are all optional. The demo needs `need/buy/wallet`, phone, email, human. Everything else is a slide line.
9. **Judges read it as "a Kelam demo."** Keep the camera on the store: the catalog, the price, the budget, the tools appearing. Kelam is one shelf.
10. **Headless agents (Codex, scripts) never see new tools.** Say it in the README: dynamic mount for clients that honour `list_changed`, `use()` for the rest. That is a real finding, and judges from the labs will like that it was measured.

---

## Appendix: what was verified today

- Claude Code 2.1.119, Node 26.10, `@modelcontextprotocol/sdk` 1.32.1.
- Spike servers in `spike/` (`stdio-server.mjs` raw JSON-RPC; `http-server.mjs` official SDK + Streamable HTTP with `tool.disable()/enable()`; `mcpuse-server.mjs` mcp-use runtime registration). Logs showed: interactive client re-fetched `tools/list` 3 ms after the notification and the model used the new tool; headless `-p` never re-fetched on either transport.
- Kelam CLI equivalents, for laptop testing only: `kelam call <agent> <number|agent> -p ... -e name:type:desc --wait` (two JSON lines, read the last), `kelam text <agent> <number> <body>`, `kelam status --json`. Workspace agents include `gabe`, `front-desk`, `reservation-caller`, `ivr-mapper`.
- `mcp-use@2.10.0` installed and run (`spike/mcpuse-server.mjs`): `server.tool()` after `listen()` returns an `isError` result with the message quoted in §2; `GET /mcp` returns 204 and `initialize` returns no `mcp-session-id`; interactive Claude Code reported NOT AVAILABLE. `notifyToolsChanged()` exists but only reaches "v2 clients with active subscriptions" per its JSDoc.
- Kelam REST (from `packages/cli/kelam_cli/main.py`): base `https://api.kelam.sh`, header `X-Kelam-Password`, `POST /calls`, `GET /calls/{id}`, `POST /calls/{id}/hangup`, `POST /messages`, `GET /messages`, `GET /agents`, `GET /quotas`, `POST /brief`, `POST /init`.
- `@blaxel/core` 0.3.30 published 2026-10-15; console app.blaxel.ai; tiers 0/1/2 = 10/50/200 sandboxes at free/$20/$50 top-ups.
- `mppx@0.13.5` installed; exports confirmed: `mcp/server` (Transport), `mcp-sdk/server`, `mcp/client` (`McpClient.wrap` with `onPaymentRequired`), `stripe/server` (`charge({client, networkId, paymentMethodTypes})`, `stripe.create` with `livemode`), `stripe/server/spt`, `stripe/client` (`stripe({createToken, paymentMethod})`), `proxy`, `discovery`. MCP binding spec read at mpp.dev/protocol/transports/mcp (error `-32042`, `_meta` keys). Not yet run end to end.
- Sponsor docs read: Primitive (`/v1/send-mail`, `primitive chat`, MCP at `https://www.primitive.dev/mcp`, $5/mo free), Inkbox (`/api/v1` identities, numbers, iMessage, webhooks, CLI), Blaxel (`@blaxel/core` sandboxes, `BL_API_KEY`/`BL_WORKSPACE`, $200 credits), InsForge (`npx add-mcp https://mcp.insforge.dev/mcp`, `@insforge/sdk`), Manufact/mcp-use (`mcp-use deploy --no-github`, URL shape `https://<slug>.run.mcp-use.com/mcp`), Stripe (shared payment tokens seller flow + test helper, MPP with `mppx`, Link Agent Wallet via `@stripe/link-cli`).
- Armature (YC P26): monitors how agents experience your product and replays their traces; self-serve free. armature.com is a different company (game studio).

---

## 7. Sponsor brief check (2026-10-17 12:10 PT, from the event page + YC chat)

Sources: [event page](https://events.ycombinator.com/MakeSomethingAgentsWant), [YC event chat](https://messages.ycombinator.com/messages/267340) (Gmail digests), sponsor docs fetched today. Prize money, judges, and what each sponsor said they want to see.

| Track | Prize (1st) | Judges | What they asked for | Gap vs this plan → add |
|---|---|---|---|---|
| **Manufact** | $2,000 + $6,000 credits (biggest) | Luigi Pederzani, Enrico Toniato, Andrew Khadder | Chat, 11:06: *"mcp-use docs (use typescript)"* + *"Include a demo showing your MCP working in multiple clients."* Deploy docs list "Build the server with `mcp-use`" as prerequisite #1. [Slides](https://www.figma.com/slides/mOvdCkHbcctsbqrCXCAaX8), [Discord](https://discord.com/invite/XkNkSkMz3V) | **Plan dropped the mcp-use SDK at 11:30; the judges just asked for it by name.** Build the product server on mcp-use `MCPServer` in `LOCKED_TOOLS` mode (priced tools visible from the start, 402 auto-pay inline; §2 says it is the same code). Keep `spike/http-server.mjs` (official SDK) only as the "tools appear mid-session" demo shim + the measured client table slide. mcp-use-native extras that cost little: **`server.proxy()`** mounts upstream HTTP MCP servers as namespaced shelves (Primitive's `https://www.primitive.dev/mcp`, Armature's MCP) with zero handler code, so "the inventory is other people's MCP servers, priced"; **MCP Apps View** on `wallet()` (React view, renders the ledger/receipt inside Claude + ChatGPT; `mcp-apps/quickstart`); `server/openapi` turns the Kelam/Inkbox OpenAPI into tools; `docs.mcp-use.com/tunneling` is the laptop fallback tunnel. **Multi-client demo** = Claude Code + Claude Desktop/ChatGPT (the View) + `mcp-use client ... tools list` / Inspector + headless Codex via `use()`. **Risk to test at 12:45:** `mppx` `Transport.mcpSdk()` reads `extra._meta` from the official SDK; mcp-use's `ctx` may not expose it. If not, do MPP at the HTTP layer (`mppx/proxy` in front) or the ledger fallback, same tool surface |
| **Primitive** | **$3,000 cash** (biggest cash) | Ethan Byrd, Ashley Ha, Ben Poile | "Give your agent an identity. Let it ask questions, receive replies, handle attachments & coordinate asynchronously." Docs: managed `*.primitive.email` inbox, **hosted Functions** (JS handler run on every inbound email), `primitive chat` one-call threaded reply, `/llms.txt` | Plan has `ask_by_email` + receipt email. Add the **approval-over-email loop**: an over-threshold `buy()` emails the human from Bodega's managed inbox, the human replies "approve $2", a hosted Function calls Bodega's approve endpoint, the purchase completes. That is "ask, reply, async coordination" in one flow and gives the Stripe track a real human approval. Attach the ledger CSV to the final receipt ("handle attachments") |
| **Stripe** | $3,000 credits + Atlas fee waived; $500 credits to all | — | "safely participate in the economy… clear control over what agents can do and spend" | Plan already deepest here (MPP 402 over MCP, cap/threshold, receipts). Nothing to add; the Primitive approval loop above is the "clear control" demo |
| **Armature** | $1,000 + $1,000 credits | Theodore Otzenberger, Louis Scremin | "Agents can use your product through a dedicated Agent-Facing Interface (MCP, CLI). Build the best experience for them." | **Real site is armature.tech / docs.armature.tech, signup app.armature.tech/signup** (plan said armature.com, the game studio). It is an SDK that wraps the server (listed: official MCP SDK 1.x/2.x, Mastra, fastmcp, mcp-handler; mcp-use not listed, test it) + ingest key; gives scored session replays and **evals where a real agent plays the user**. Add: wrap the server, then write 3 eval cases (buy under threshold; over-threshold refusal; headless `use()` path) and run them Saturday evening. Their own marketing replay shows a `send_invoice 402` step, so the 402 story lands with these judges. Also a CLI (`npx bodega ...`) counts as an agent-facing interface for this track |
| **Inkbox** | $1,000 + $1,000 credits | — | "persistent identity with email, phone, iMessage, and A2A." Chat, 11:26: **100 identities per team, stop by the booth to raise the quota** | Go to the booth first. With 100 identities, `create_identity` can mint a **fresh identity per agent session on stage** (plan said create by hand) and the agent self-signup endpoint becomes demoable. Keep iMessage first-contact caveats (§3.3) |
| **InsForge** | $1,000 + $1,000 credits | Tony Chang Hang Huang | "Agent-native cloud." Docs: Postgres, Auth, Storage, Edge Functions (Deno), Sites, Compute, Model Gateway, plus OpenAPI for `payments`, `email`, `schedules`; MCP at `https://mcp.insforge.dev/mcp` exposes a skill resource `mintlify://skills/insforge` | Keep optional (§2). Cheapest credible use: wallet/ledger tables created through their MCP from Claude Code, and the `approve_url` page hosted as an InsForge Site or Edge Function |
| **Blaxel** | $1,000 gift card | — | "Something a Human Would Never Want." Docs: `bl skills install` gives coding agents Blaxel skills; **Blaxel also hosts streamable-HTTP MCP servers** (15 min max runtime) | 25-sandbox `fan_out` stays. Install the Blaxel skills in both Claude Code sessions before building the listing. Blaxel MCP hosting is a second hosting fallback after laptop+tunnel |
| **Supabase** | none listed on the event page | — | — | Drop from the plan unless a lightning talk announces a track |

**Agent-facing docs to feed our own Claude Code sessions** (add to the repo `CLAUDE.md` so both of us build against current docs): `https://docs.mcp-use.com/llms.txt`, `https://docs.primitive.dev/llms.txt` (`/llms-full.txt` for the corpus), `https://docs.armature.tech/llms.txt`, InsForge MCP skill resource above, Blaxel `bl skills install`.

**Judging logistics from the page:** submissions due + live demos **10:00 AM Sun**, judging completes 11:00, winners 12:15. Lunch lightning talks 12:15 today, dinner talks 6:00 PM.
