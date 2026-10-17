# marketplace-mcp: one MCP for agents to search, browse and compare across marketplaces

| | |
|---|---|
| Status | **demoable** (six marketplaces end to end, 2026-10-17 14:10 PT, branch `exp/marketplace-mcp`) |
| Owner | Kaushik |
| Tracks | Stripe ("buy products… manage spending"), Blaxel (fan out browsing to sandboxes), Manufact (the MCP itself, built on mcp-use), Armature (AX) |
| One-liner | `search` / `item` / `arbitrage` / `add_marketplace` over eBay, Grailed, Amazon plus any server-rendered marketplace onboarded from its URL; Jev (TypeSafe) judges relevance, photo match and "is there a catch" before a spread is quoted. |

## Hypothesis
Agents cannot shop today: every marketplace is a UI, and the few APIs are gated. One normalized search surface over several marketplaces is something agents want on its own, and "find the same item cheaper elsewhere" is a demo with a number at the end.

## Smallest test: passed
Query "arcteryx beta ar jacket", all three marketplaces, one process:

| Marketplace | Path that works | Latency | Notes |
|---|---|---|---|
| Grailed | Algolia index `Listing_production` (app `MNRWEFSS2Q`) queried directly; the hourly secured search key is minted by `POST /api/algolia/keys` behind Cloudflare, so headless Chromium loads one shop page to capture it (1 s, cached to `.cache/grailed-key.json`). `item()` reads the listing page's `__NEXT_DATA__` + the `seller_ratings` API response (1.3 s) | 0.3 s | 60+ fields per hit incl. size, condition, designer, location. `Listing_sold_production` is **refused** for the anonymous key |
| Amazon | Headless Chromium on `amazon.com/s` and `/dp/ASIN` | 1.5–2 s | Title, price, rating, review count, sponsored flag. Review **text** is behind sign-in now; dp pages expose rating + count only. Browser-side scripts are strings (tsx injects `__name` into transpiled callbacks) |
| eBay | TinyFish Fetch (server-side Chromium) of `ebay.com/sch`, markdown + links + image_links; bullet order matches link order once the template `/itm/123456` is dropped (verified against item pages). Queries are lower-cased so equivalent searches share TinyFish's cache; 3 attempts with backoff because a fresh render often meets the bot wall | 10–12 s | Plain curl and local headless Chromium are blocked. TinyFish's HTML/JSON formats strip anchors and classes, so markdown is the only parseable form. The sold/completed filter returns eBay's error page from TinyFish. Upgrade path: official Browse API with `EBAY_CLIENT_ID/SECRET` (needs a developer account) |

`arbitrage("arcteryx beta ar jacket")` through the MCP: 55 listings considered, Jev kept 50 as the product itself, top result an eBay Beta AR at $150 vs a $650 Amazon median (reference = median live ask on the other marketplaces, since no sold comps were reachable). Whole call about 25 s.

## Second run: six marketplaces, photo + catch evidence (14:10 PT)
`add_marketplace` onboarded **poshmark.com, mercari.com, vinted.com** with no site code (it tries ten search-URL shapes, parses title/price/size blocks from the rendered markdown, aligns listing links by order, keeps the shape whose results are relevant to the probe query). Depop, Etsy, TheRealReal, Backcountry block server-side renders; StockX times out.

`arbitrage("arcteryx beta ar jacket")` across all six: 109 listings, Jev kept 73. Top spread is the $150 eBay "READ" listing against a $520 cross-market median, and Jev flags it: **catch_risk 0.88** (the title says READ), photo_match 0.63. The $180 eBay listing one row down has catch_risk 0.09 and photo_match 0.88 against the cheapest Grailed listing. That contrast is the demo. Vinted contributes zero after relevance filtering because its search page shows brand only ("Arc'teryx"), which is honest behaviour.

Jev image path: the API accepts PNG/JPEG with each side 280–1568 px and never resizes, so `sharp` normalizes every photo (Amazon thumbnails are 160 px, Grailed photos 1706 px, eBay serves WebP). Amazon's `_AC_SL1000_` variant is requested in place of the thumbnail.

## Claude Code as the client (14:45 PT)
Registered with `claude mcp add --transport http --scope user marketplace http://localhost:3777/mcp` (shows **Connected** in `claude mcp list`). Headless run, `claude -p --mcp-config .cache/mcp.json --allowedTools "mcp__marketplace__*"`, prompt: *"You are a resale buyer's agent… find Arc'teryx Beta AR jackets listed well below what they sell for elsewhere, decide whether the top 2 are real deals or have a catch."*

The agent discovered the four tools, called `arbitrage(query, limit 5, min_spread_pct 0.15)`, then `item()` on its top two Grailed picks, and wrote the report: 7 turns, 60 s, **$0.14**. It called the $129 "worn" listing *risky, pass or inspect* (catch_risk 0.31, the highest in the set) and the $372 vintage one *a real deal*. `item()` on Grailed was not implemented at that moment; it is now, and the $129 listing's description reads *"Jacket need to be fixed. zipper some times doesn't work properly."* The agent's call was right from the tool's evidence alone.

Gotcha: a stored Claude Code login that has expired is preferred over `ANTHROPIC_API_KEY`; run headless with `CLAUDE_CONFIG_DIR=<scratch>` to force the key without logging the user out.

## Jev vs OpenAI Decisions API (checked 2026-10-17)
OpenAI announced the Decisions API at DevDay (2026-09-29) and opened the public beta 2026-10-06: GPT-6 Luna constrained to predicates (probability), choices (with confidence) and scores, text **and image** input, "150 ms vs 1.6 s" on their slide, **$0.10 per 1M input tokens**, output free. Jev 1.14 (2026-10-14): same three primitives plus Box, **$0.042 per 1M input tokens**, ~0.2 s P50 measured by OpenRouter, images behind an experimental header (the path this server uses, it works). A third-party benchmark in the OpenAI forum thread found Jev more accurate on nuanced judgments and Luna making about 3x as many confident wrong answers. For this server the judgment bill is noise either way (an arbitrage run is ~100 judgments of ~300 tokens: under a cent on Jev, about two on Decisions), so the choice is accuracy and integration, and Jev stays. The four judgment calls live in `src/jev.ts`; a Decisions backend would be a drop-in behind the same functions if a side-by-side is ever wanted.

## Browser layer: local Chromium or Browserbase
`src/browser.ts` runs a local headless Chromium by default. With `BROWSER=browserbase` plus `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (both in Doppler `agents-want/dev`, taken from Kelam's SSM parameter and Browserbase's projects endpoint) it creates a Browserbase session and attaches over CDP.

**Tested 2026-10-17 15:10 with Kelam's account (free plan, project "Production project", concurrency 3, shared with Kelam prod):**

| Site | Through Browserbase | Note |
|---|---|---|
| eBay | **blocked** ("Error Page") | same as local Chromium; eBay blocks datacenter egress |
| Amazon | **blocked** (results never render) | worse than local Chromium, which passes |
| Grailed | works | key refresh and `item()` fine |

`advancedStealth` is Enterprise-only (403) and residential proxies are paid-plan only (402), so on this account Browserbase is a hosting path for the Grailed browser work, not a way past eBay. It is opt-in so a key in Doppler does not silently switch the server off the working local path.

## Tools (mcp-use `MCPServer`, Streamable HTTP on `:3777/mcp`)
- `marketplaces()` – what is searchable and via which path (agents should know the freshness of each)
- `search(query, marketplaces?, limit, sold)` – normalized compact listings per marketplace
- `item(marketplace, id)` – details: Amazon (rating/count, bullets), Grailed (description, photos, seller + seller ratings from the listing page data); eBay URL only for now
- `arbitrage(query, limit, min_spread_pct)` – cross-marketplace spreads; per opportunity: relevance, `photo_match` vs the cheapest photographed listing elsewhere, `catch_risk` from the listing text
- `add_marketplace(url, probe_query)` – onboard a server-rendered marketplace from its URL; persisted in `.cache/marketplaces.json` and live for search/arbitrage immediately

## Run
```bash
cd experiments/marketplace-mcp && npm install
doppler run -p agents-want -c dev -- npm run smoke -- "arcteryx beta ar jacket"   # all adapters, prints a table
doppler run -p agents-want -c dev -- npm run dev                                   # MCP server on http://localhost:3777/mcp
```
Secrets in Doppler project `agents-want`, config `dev`: `TINYFISH_API_KEY`, `TYPESAFE_API_KEY`.

## Where Jev fits (and where it does not)
Jev answers typed yes/no questions, it does not extract. Extraction is code (Algolia JSON, DOM selectors, markdown parsing). Jev does `relevance(query, listing)` per listing and `sameItem(a, b)` per pair. Image path and the catch check are live (see the second run above).

## Known gaps
- No sold comps yet (Grailed sold index needs a logged-in key; eBay sold filter blocked from TinyFish). Reference price is the live median elsewhere.
- Generic adapter URLs rely on link order matching listing order (true on the three verified sites); no images for generic listings yet.
- Not deployed to Manufact yet; Playwright in the container is the open question (Blaxel sandbox is the fallback for the browser work).

## Result
_fill in after the demo or when dropped._
