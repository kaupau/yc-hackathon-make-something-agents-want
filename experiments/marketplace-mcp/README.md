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
| Grailed | Algolia index `Listing_production` (app `MNRWEFSS2Q`) queried directly; the hourly secured search key is minted by `POST /api/algolia/keys` behind Cloudflare, so headless Chromium loads one shop page to capture it (1 s, cached to `.cache/grailed-key.json`) | 0.3 s | 60+ fields per hit incl. size, condition, designer, location. `Listing_sold_production` is **refused** for the anonymous key |
| Amazon | Headless Chromium on `amazon.com/s` and `/dp/ASIN` | 1.5–2 s | Title, price, rating, review count, sponsored flag. Review **text** is behind sign-in now; dp pages expose rating + count only. Browser-side scripts are strings (tsx injects `__name` into transpiled callbacks) |
| eBay | TinyFish Fetch (server-side Chromium) of `ebay.com/sch`, markdown + links; bullet order matches link order once the template `/itm/123456` is dropped (verified against item pages) | 10–12 s | Plain curl and local headless Chromium are blocked. TinyFish's HTML/JSON formats strip anchors and classes, so markdown is the only parseable form. The sold/completed filter returns eBay's error page from TinyFish. Upgrade path: official Browse API with `EBAY_CLIENT_ID/SECRET` (needs a developer account) |

`arbitrage("arcteryx beta ar jacket")` through the MCP: 55 listings considered, Jev kept 50 as the product itself, top result an eBay Beta AR at $150 vs a $650 Amazon median (reference = median live ask on the other marketplaces, since no sold comps were reachable). Whole call about 25 s.

## Second run: six marketplaces, photo + catch evidence (14:10 PT)
`add_marketplace` onboarded **poshmark.com, mercari.com, vinted.com** with no site code (it tries ten search-URL shapes, parses title/price/size blocks from the rendered markdown, aligns listing links by order, keeps the shape whose results are relevant to the probe query). Depop, Etsy, TheRealReal, Backcountry block server-side renders; StockX times out.

`arbitrage("arcteryx beta ar jacket")` across all six: 109 listings, Jev kept 73. Top spread is the $150 eBay "READ" listing against a $520 cross-market median, and Jev flags it: **catch_risk 0.88** (the title says READ), photo_match 0.63. The $180 eBay listing one row down has catch_risk 0.09 and photo_match 0.88 against the cheapest Grailed listing. That contrast is the demo. Vinted contributes zero after relevance filtering because its search page shows brand only ("Arc'teryx"), which is honest behaviour.

Jev image path: the API accepts PNG/JPEG with each side 280–1568 px and never resizes, so `sharp` normalizes every photo (Amazon thumbnails are 160 px, Grailed photos 1706 px, eBay serves WebP). Amazon's `_AC_SL1000_` variant is requested in place of the thumbnail.

## Tools (mcp-use `MCPServer`, Streamable HTTP on `:3777/mcp`)
- `marketplaces()` – what is searchable and via which path (agents should know the freshness of each)
- `search(query, marketplaces?, limit, sold)` – normalized compact listings per marketplace
- `item(marketplace, id)` – details + reviews where exposed (Amazon: rating/count; eBay/Grailed: URL only for now)
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
