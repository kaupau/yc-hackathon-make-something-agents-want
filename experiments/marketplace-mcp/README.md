# marketplace-mcp: one MCP for agents to search, browse and compare across marketplaces

| | |
|---|---|
| Status | **demoable** (end-to-end run 2026-10-17 13:20 PT on branch `exp/marketplace-mcp`) |
| Owner | Kaushik |
| Tracks | Stripe ("buy products… manage spending"), Blaxel (fan out browsing to sandboxes), Manufact (the MCP itself, built on mcp-use), Armature (AX) |
| One-liner | `search` / `item` / `arbitrage` over eBay, Grailed and Amazon with normalized listings; Jev (TypeSafe) judges which listings are the real product before a spread is quoted. |

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

## Tools (mcp-use `MCPServer`, Streamable HTTP on `:3777/mcp`)
- `marketplaces()` – what is searchable and via which path (agents should know the freshness of each)
- `search(query, marketplaces?, limit, sold)` – normalized compact listings per marketplace
- `item(marketplace, id)` – details + reviews where exposed (Amazon: rating/count; eBay/Grailed: URL only for now)
- `arbitrage(query, limit, min_spread_pct)` – cross-marketplace spreads with evidence, relevance-filtered by Jev

## Run
```bash
cd experiments/marketplace-mcp && npm install
doppler run -p agents-want -c dev -- npm run smoke -- "arcteryx beta ar jacket"   # all adapters, prints a table
doppler run -p agents-want -c dev -- npm run dev                                   # MCP server on http://localhost:3777/mcp
```
Secrets in Doppler project `agents-want`, config `dev`: `TINYFISH_API_KEY`, `TYPESAFE_API_KEY`.

## Where Jev fits (and where it does not)
Jev answers typed yes/no questions, it does not extract. Extraction is code (Algolia JSON, DOM selectors, markdown parsing). Jev does `relevance(query, listing)` per listing and `sameItem(a, b)` per pair. Next: the image path (`TypeSafe-Danger-Zone-Images`), asking whether the eBay photo and the Amazon photo show the same jacket, and a "is there a catch?" Noul over the listing's condition text (the $150 eBay listing says "READ").

## Known gaps
- No sold comps yet (Grailed sold index needs a logged-in key; eBay sold filter blocked from TinyFish). Reference price is the live median elsewhere.
- No `add_marketplace(url)` auto-onboarding yet; the three adapters are hand-written. A generic adapter would be TinyFish markdown + an LLM extraction into the `Listing` shape, with Jev verifying fields.
- Not deployed to Manufact yet; Playwright in the container is the open question (Blaxel sandbox is the fallback for the browser work).

## Result
_fill in after the demo or when dropped._
