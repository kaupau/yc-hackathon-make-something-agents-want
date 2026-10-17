# marketplace-mcp: one MCP for agents to search, browse and read reviews across marketplaces

| | |
|---|---|
| Status | building (started 2026-10-17 12:30) |
| Owner | Kaushik |
| Tracks | Stripe ("buy products… manage spending"), Blaxel (fan out browsing to sandboxes), Manufact (the MCP itself), Armature (AX) |
| One-liner | `search(query)` / `item(id)` / `reviews(id)` routed to eBay, Grailed and Amazon adapters, with Jev (TypeSafe, multimodal) extracting structure from pages, so an agent can hunt arbitrage across marketplaces. |

## Hypothesis
Agents cannot shop today: every marketplace is a UI, and the few APIs are gated. One normalized search surface over several marketplaces, with a generic page-reading adapter that onboards a new marketplace from its URL, is something agents want on its own, and "find the same item cheaper elsewhere" is a demo with a number at the end.

## Done looks like
Claude Code asks for a product. The MCP searches three marketplaces, normalizes listings (title, price, condition, seller, URL, images), pulls reviews or seller feedback, and an `arbitrage(query)` tool returns pairs where the same item is listed cheaper on one marketplace than another, with the spread. `add_marketplace(url)` onboards a fourth site live by having Jev work out the search URL and extraction.

## Smallest test
Pull live listings for one query ("Arc'teryx Beta AR jacket") from each of eBay (official Browse API), Grailed (its Algolia endpoint) and Amazon (page fetch + Jev extraction) into one normalized JSON shape. If Amazon blocks, demo with two and treat Amazon as the "onboarded via add_marketplace" example.

## Access paths (checked 2026-10-17)
_filled in below as recon lands._

## Result
_fill in._
