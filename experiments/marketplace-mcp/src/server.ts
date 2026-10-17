import { MCPServer } from "mcp-use";
import { z } from "zod";
import { adapters, marketplaces } from "./adapters/index.js";
import { arbitrage } from "./arbitrage.js";
import { discover } from "./adapters/generic.js";
import { jevAvailable } from "./jev.js";
import { loadRegistry, register } from "./registry.js";
import type { Listing } from "./types.js";

/** Token-light listing for tool results: agents pay per token, so no raw payloads. */
const compact = (l: Listing) => ({ m: l.marketplace, id: l.id, title: l.title.slice(0, 90), usd: l.price_usd, cond: l.condition, url: l.url, ...(l.image ? { img: l.image } : {}), ...(l.size ? { size: l.size } : {}), ...(l.rating != null ? { rating: l.rating, reviews: l.review_count } : {}), ...(l.sold ? { sold: true } : {}), ...(l.shipping_usd != null ? { ship: l.shipping_usd } : {}) });
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], structuredContent: o as any });

loadRegistry();
const server = new MCPServer({ name: "marketplace-mcp", version: "0.2.0" });

server.tool({
  name: "marketplaces",
  description: "List the marketplaces this server can search and how each is reached (live API, headless browser, or server-side render). Free.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => text({ marketplaces: Object.values(adapters).map((a) => ({ name: a.name, via: a.via, item_details: !!a.item })), jev: jevAvailable() ? "on (relevance + same-item judgments)" : "off" }));

server.tool({
  name: "search",
  description: "Search one or more marketplaces (eBay, Grailed, Amazon) for a product and get normalized listings: title, price in USD, condition, URL. Set sold=true for eBay sold/completed comps (what buyers paid). Results are compact; call item() for details and reviews.",
  inputSchema: z.object({ query: z.string().min(2), marketplaces: z.array(z.string()).optional().describe("subset of marketplaces(); default all"), limit: z.number().int().min(1).max(40).default(10), sold: z.boolean().default(false) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, marketplaces: ms, limit, sold }) => {
  const names = ms?.length ? ms.filter((n) => adapters[n]) : marketplaces();
  const out = await Promise.all(names.map(async (n) => { const t = Date.now(); try { const rows = await adapters[n].search(query, { limit, sold }); return { marketplace: n, ms: Date.now() - t, listings: rows.map(compact) }; } catch (e: any) { return { marketplace: n, ms: Date.now() - t, error: e.message.split("\n")[0], listings: [] }; } }));
  return text({ query, results: out });
});

server.tool({
  name: "item",
  description: "Details for one listing: full title, price, rating and top reviews where the marketplace exposes them (Amazon today). Use the marketplace and id from search().",
  inputSchema: z.object({ marketplace: z.string(), id: z.string() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ marketplace, id }) => {
  const a = adapters[marketplace]; if (!a) return text({ error: `unknown marketplace ${marketplace}` });
  if (!a.item) return text({ error: `${marketplace} has no item details yet; open the URL`, url: marketplace === "ebay" ? `https://www.ebay.com/itm/${id}` : `https://www.grailed.com/listings/${id}` });
  const d = await a.item(id);
  return text({ listing: compact(d.listing), description: d.description ?? null, reviews: (d.reviews ?? []).slice(0, 6).map((r) => ({ rating: r.rating, title: r.title, body: r.body.slice(0, 300), date: r.date })) });
});

server.tool({
  name: "arbitrage",
  description: "Find a product listed well below what it sells for elsewhere. Searches every marketplace, uses eBay SOLD comps as the reference price when eBay serves them (else the median live ask on the other marketplaces, stated in reference_from), drops listings that are not the product itself (Jev judgment), and returns the biggest spreads with evidence. Slow: 15-40 s.",
  inputSchema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(10).default(5), min_spread_pct: z.number().min(0).max(0.9).default(0.25) }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, limit, min_spread_pct }) => {
  const r = await arbitrage(query, { limit, min_spread_pct });
  return text({ ...r, opportunities: r.opportunities.map((o) => ({ ...o, listing: compact(o.listing) })) });
});

server.tool({
  name: "add_marketplace",
  description: "Onboard a new marketplace from its URL with no code: tries the common search-URL shapes, recovers listings from the rendered page (title, price, size, link), keeps the shape that returns relevant results, and registers it so search()/arbitrage() include it from now on. Works where the site renders server-side (verified: poshmark.com, mercari.com, vinted.com). 20-50 s.",
  inputSchema: z.object({ url: z.string().describe("homepage, or a search URL with a sample query in it"), probe_query: z.string().default("nike hoodie") }),
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
}, async ({ url, probe_query }) => {
  try {
    const d = await discover(url, probe_query);
    register(d.cfg);
    return text({ added: d.cfg.name, template: d.cfg.template, item_prefix: d.cfg.item_prefix, listings_on_probe: d.cfg.sample_count, sample: d.sample.map(compact), tried: d.tried });
  } catch (e: any) { return text({ error: e.message }); }
});

export default server;
const port = Number(process.env.PORT ?? 3777);
await server.listen(port);
console.log(`marketplace-mcp listening on http://localhost:${port}/mcp  (jev ${jevAvailable() ? "on" : "off"})`);
