# Bodega + Trials: team plan

Shared, editable version with diagrams: [Bodega + Trials: Team Plan](https://claude.ai/code/artifact/78d6f078-f841-45e5-b234-31de0fdf445e). Written Sat 2026-10-17 12:30 PT. Demo Sun 10:00.

Bodega gains try-before-you-buy. Vendors list competing dev tools and fund a trial allotment. The agent tests each tool in a Blaxel sandbox, compares them head to head, and buys the winner from the human's budget. Three streams build in parallel from 12:45 against the shared contracts and mocks in `bodega/`.

**Still holds from `PLAN.md`:** §2 hosting and payments, §3.2–3.3 Primitive and Inkbox API details, §4 accounts, §6 risks, §7 sponsor asks. **Superseded:** §1 demo script and §5 split/schedule.

---

## What changes in Bodega

*Agents only have the tools a human wired in. Bodega lets them shop mid-task. They find competing tools, test each one in a sandbox on the vendor's dime, compare them, and buy the winner within the human's limit.*

| Who | Gets |
|---|---|
| Agent | Free sandboxed trials and a neutral side-by-side comparison |
| Human | A cap, an approval threshold and receipts. Pays only for the tool that proved itself |
| Vendor | Distribution to agents, plus a funnel: trial → check passed → chosen or rejected (with reason) → bought |
| Bodega | Vendors fund trials and pay per conversion |

**Catalog:** real APIs for one category, agent email, with **Primitive vs Inkbox** plus a mocked third vendor, PostPigeon. Every other category is seeded with mocked vendors. The old capability listings (phone, human) stay in the catalog as buy-only.

## Agent tools

Eight tools, four of them new (★). Every result stays under ~200 tokens. Prices and trial allotments go in the tool descriptions.

| Tool | Does |
|---|---|
| `need(capability)` | Searches the catalog. Returns competing listings: id, vendor, one line, trial left and who funds it, price after trial, supported checks |
| ★ `start_trial(listing_id)` | Vendor-funded, $0 to the human. Boots a Blaxel sandbox with the vendor SDK installed and injects a Bodega trial token (never the vendor key). Returns the quickstart, env var names and quota |
| ★ `run_trial(trial_id, command or file)` | Runs the agent's own code in that sandbox. Returns exit code, trimmed stdout/stderr and quota left |
| ★ `compare(listing_ids[], check?)` | Runs the category's standard check (e.g. `email.roundtrip`) across N sandboxes in parallel. Returns a side-by-side table and a suggestion |
| `buy(listing_id, reason?)` | As in PLAN.md: cap, threshold, MPP/Stripe, receipt. Adds: returns a metered project key + base URL for the repo, and the vendor's tools appear in the session |
| `wallet()` | As in PLAN.md, plus a trials section (vendor-funded, $0) |
| ★ `review(listing_id, verdict, reason)` | Feedback that lands in the vendor's funnel. Filed automatically after `compare` and `buy` |
| `use(listing_id, tool, args)` | Unchanged fallback for headless clients |

**The metering proxy is the one mechanism behind both trials and purchases.** The sandbox gets `BODEGA_TOOL_BASE_URL=https://<host>/proxy/<token>` and `BODEGA_TOOL_KEY=<token>`. The proxy swaps in the real vendor credential, counts every upstream call against the token's quota, and returns 402 when the quota runs out. A trial token draws on the vendor's pool; a purchased key draws on what the human bought.

Vendor credential modes:
- `pooled_key`: the vendor hands Bodega one restricted key. Primitive and Inkbox run this way, on our accounts.
- `provision_webhook`: the vendor mints a scoped key per trial. PostPigeon demonstrates it.

## How it fits together

One Node process on Manufact, one public URL: `/mcp` (A), `/proxy/:token/*` (B), `/portal` + `/approve/:id` (C), plus `/llms.txt` and `/.well-known/mpp`.

```
 Vendor APIs  <-- real key --  B Trial runtime  <-- calls --  A Storefront  <-- MCP --  Agent
 (Primitive,                   (sandboxes,                    (8 tools,
  Inkbox,                       proxy, compare)                wallet, buy)  -- buy() --> Stripe
  PostPigeon)                    |   ^                              |
                     create,exec |   | trial token                  | calls
                                 v   |                              v
                               Blaxel sandboxes             C Vendor side  <-- email, /portal --  Human, vendor
                                                            (Catalog, Vault, Ledger,
                                                             Approvals, portal)  -- reads, writes --> InsForge
```

Arrows point from caller to provider. B leases vendor keys from C's `Vault` and records usage in C's `Ledger`.

## Demo (2 minutes)

Claude Code on the projector, with only Bodega connected, inside a small sample repo.

1. Prompt: *"Our support bot must email customers and read their replies. Pick a provider, prove it works, buy it (budget $5), and wire it into `src/notify.ts`."*
2. `need("agent email, send + receive")` returns Primitive, Inkbox and PostPigeon, each with a vendor-funded trial and a price after trial.
3. `compare([...])` boots 3 Blaxel sandboxes in parallel and runs `email.roundtrip` in each. Target result: Primitive ✅ 2.1 s / 9 LOC, Inkbox ✅ 3.4 s / 14 LOC, PostPigeon ❌ 401 on receive. Wallet: $0 spent.
4. `buy("primitive-email")` costs $2.00, which is over the $1 threshold. An approval email reaches Kaushik; he replies "approve"; the Stripe test payment appears; the project key comes back.
5. The agent writes `notify.ts` and runs it. A real email lands on screen.
6. Cut to the vendor portal. Primitive's funnel shows the win and the agent's reason; Inkbox's shows the loss and why.
7. Optional kicker, only if Stream B finishes it: the phone and human beats from PLAN.md.

Closing line: *"Nothing was pre-installed. The agent found three tools, tried them on the vendors' dime, and bought the one that worked, within the limit the human set."*

---

## Stream A: Storefront

**Owner:** Kaushik (suggested). **Directory:** `bodega/src/store/`. **Owns:** the agent-facing MCP server and the buy path.

- [ ] Manufact smoke test from PLAN.md §5, plus one extra check: a plain non-`/mcp` GET route is reachable on the hosted URL (the proxy and portal need it)
- [ ] All 8 tools, built against the mocks first, with prices and trial info in the descriptions
- [ ] `buy()`, wallet, cap and threshold, MPP + Stripe test mode. Go/no-go at 15:30, else the ledger fallback from PLAN.md §2
- [ ] Over-threshold buys call `Approvals.request` (built by Stream C)
- [ ] `main.ts` composes real implementations or mocks per component via `BODEGA_MOCK=catalog,runtime,...`
- [ ] Dockerfile, deploy, `llms.txt`, `/.well-known/mpp`
- [ ] Multi-client demo for the Manufact judges: Claude Code, plus a second client, plus a headless client via `use()`
- [ ] Armature evals: trial → compare → buy; over-threshold refusal; headless `use()`

**Done when:** the demo script runs in interactive Claude Code against the hosted URL.

## Stream B: Trial runtime

**Owner:** Sami (suggested). **Directory:** `bodega/src/runtime/`. **Owns:** sandboxes, metering and `compare`. Implements `TrialRuntime`.

- [ ] Blaxel sandbox per trial: create from the listing's image and install steps, inject the `BODEGA_TOOL_*` env, exec, delete on `end`, TTL reaper for strays
- [ ] Metering proxy at `/proxy/:token/*`: `Vault.lease` for the upstream credential, swap the auth header per vendor, `Ledger.recordUsage` on every call, 402 with an MPP challenge body once the quota is gone. Serves purchased project keys too
- [ ] `email.roundtrip` adapters for Primitive (REST) and Inkbox (REST), run inside the sandbox. Self-loop: create or get the inbox, send to itself, poll until received; measure send_ms and deliver_ms. Fallback: the two trial inboxes cross-send
- [ ] 13:15: verify each vendor allows an inbox per trial. If not, use one inbox per vendor with a per-trial subject tag
- [ ] `compare`: run all sandboxes with `Promise.all`, normalize each into a `CheckResult` (ok, metrics, LOC, error, log tail), apply a simple suggestion rule
- [ ] Pre-warm the three demo sandboxes so `compare` stays under 60 s
- [ ] Stretch: the real Kelam phone and Inkbox human listings from PLAN.md §3

**Done when:** `compare(["primitive-email","inkbox-email","postpigeon-email"])` returns real results in under 60 s.

## Stream C: Vendor side

**Owner:** third teammate. **Directory:** `bodega/src/vendor/`. **Owns:** data, the vendor portal, the mock vendor and approvals. Implements `Catalog`, `Vault`, `Ledger`, `Approvals`.

- [ ] InsForge Postgres versions of `Catalog`, `Vault`, `Ledger`, with tables created through the InsForge MCP (InsForge track). The in-memory mocks stay as the fallback
- [ ] Seed the real catalog: Primitive and Inkbox listings with sandbox setup, quickstarts and `pooled_key` credentials read from env/Doppler
- [ ] PostPigeon mock vendor: a tiny HTTP API plus a `provision_webhook` that mints scoped keys. Its receive endpoint fails on purpose, so the demo always shows one ❌
- [ ] Vendor portal at `/portal`: create and edit a listing, set the trial allotment, pick the credential mode, view the funnel (trials → passed → chosen/rejected + top reasons → purchases and revenue)
- [ ] Approval over email (PLAN.md §7 Primitive ask): `Approvals.request` emails the human from Bodega's Primitive inbox; a reply or the `/approve/:id` link approves; `status()` flips
- [ ] Stretch: Stripe test Checkout so a vendor can fund its trial pool

**Done when:** the portal shows a live funnel from a real compare + buy, and the approval email round trip works.

---

## Schedule (Saturday, PT)

| Time | All | A | B | C |
|---|---|---|---|---|
| 12:45–13:00 | Pull `bodega/`, contract review | | | |
| 13:00–15:00 | Build against mocks | Smoke test, tools on mocks | Sandbox, proxy, Primitive adapter | Schema, seed, PostPigeon |
| 15:00 | **Sync 1:** swap in the first real component | | | |
| 15:00–17:00 | | `buy()`, MPP, Stripe (go/no-go 15:30) | Inkbox adapter, `compare` | Portal, approvals |
| 17:00 | **Sync 2:** end-to-end demo with ≥1 real email vendor | | | |
| 17:00–18:30 | Dinner, pitch sponsor founders at their tables | | | |
| 18:30–21:00 | | `llms.txt`, multi-client, evals | Pre-warm, harden, stretch | Funnel polish, stretch |
| 21:00 | **Feature freeze.** Rehearsals until 23:00, plus a backup video | | | |

Sunday: fresh run 08:00, demo 10:00.

## Shared contracts

Code lives in `bodega/src/contracts/`; in-memory mocks in `bodega/src/mocks/`. The contracts change only by team agreement, in one PR.

| Interface | Built by | Used by | Methods |
|---|---|---|---|
| `Catalog` | C | A | `search`, `get`, `listByVendor`, `upsert` |
| `Vault` | C | B | `upstream`, `lease`, `revoke` |
| `Ledger` | C | A, B | trials (incl. `getTrialByToken`), `recordUsage` (atomic pool decrement), reviews, purchases, comparisons, `funnel(vendor_id)` |
| `Approvals` | C | A | `request`, `status` |
| `TrialRuntime` | B | A | `start`, `run`, `compare`, `end` |

Shared types (`types.ts`):
- Catalog and access: `Vendor`, `Listing` (public, safe to return to agents), `UpstreamConfig` (secret: base URL, auth header format, credential mode), `TrialPolicy`
- Trial runs: `Trial`, `RunRequest` / `RunResult`, `CheckSpec` / `CheckResult` / `ComparisonReport`
- Outcomes and analytics: `Review`, `Purchase`, `WalletView`, `VendorFunnel`

```bash
cd bodega && npm install
npm run typecheck   # contracts + mocks compile under strict
npm run demo:mock   # need -> compare -> review -> buy -> wallet -> funnel, all in memory
```

**Integration rule:** each stream exports a factory that satisfies its interface. `BODEGA_MOCK` swaps one component back to its mock, so anyone can integrate early, and the demo can fall back one piece at a time.

## Payments: MPP, not x402

Stay on MPP, the payment protocol PLAN.md §2 already chose. x402 (Coinbase: HTTP 402 settled in USDC on Base) is the same pattern, and adding it buys nothing here:
- It's a second protocol doing the same job.
- It needs a crypto wallet and testnet funds.
- No sponsor on the event page asks for it. MPP is Stripe's, Stripe is a judged track, and MPP settles to the Stripe test dashboard.

There's no true agent-to-agent payment in this design. Vendors pre-fund their trial pools, and the human's budget pays the vendor through Stripe at `buy()`. The one place a 402 helps is the metering proxy: when a trial runs out, its 402 carries an MPP payment request, so a payment-aware client could pay inline. x402 stays one slide line at most.

## Risks

New, on top of PLAN.md §6.

| Risk | Fallback | Owner |
|---|---|---|
| Manufact routes only `/mcp`, so the proxy and portal can't be reached | Run the proxy and portal on the laptop with a tunnel, or host them on Blaxel. Their URL comes from env | A (smoke test) |
| Vendor SDKs hardcode their base URL | Adapters and quickstarts call the REST APIs through `BODEGA_TOOL_BASE_URL` | B |
| Vendors don't allow an inbox per trial | One inbox per vendor, with a per-trial subject tag | B |
| Blaxel cold starts push `compare` past 60 s | Pre-warm the three demo sandboxes; `createIfNotExists` reuses them | B |
| MPP fights us | Ledger fallback at 15:30, same tool surface | A |
| InsForge blocks the core loop | Keep the in-memory mocks behind `BODEGA_MOCK` | C |
