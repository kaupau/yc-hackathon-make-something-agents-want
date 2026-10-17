import { MCPServer } from "mcp-use";
import { z } from "zod";
import { adapters, marketplaces } from "./src/adapters/index.js";
import { arbitrage } from "./src/arbitrage.js";
import { discover } from "./src/adapters/generic.js";
import { jevAvailable } from "./src/jev.js";
import { loadRegistry, register } from "./src/registry.js";
import type { Listing } from "./src/types.js";

/** Token-light listing for tool results: agents pay per token, so no raw payloads. */
const compact = (l: Listing) => ({ m: l.marketplace, id: l.id, title: l.title.slice(0, 90), usd: l.price_usd, cond: l.condition, url: l.url, ...(l.image ? { img: l.image } : {}), ...(l.size ? { size: l.size } : {}), ...(l.rating != null ? { rating: l.rating, reviews: l.review_count } : {}), ...(l.sold ? { sold: true } : {}), ...(l.shipping_usd != null ? { ship: l.shipping_usd } : {}) });
const compactSchema = z.object({ m: z.string(), id: z.string(), title: z.string(), usd: z.number().nullable(), cond: z.string().nullable(), url: z.string(), img: z.string().optional(), size: z.string().optional(), rating: z.number().nullable().optional(), reviews: z.number().nullable().optional(), sold: z.boolean().optional(), ship: z.number().nullable().optional() });
const arbitrageOutput = z.object({
  query: z.string(),
  reference: z.object({ sold_comps: z.number(), sold_median_usd: z.number().nullable(), sold_venues: z.array(z.string()).optional() }),
  by_marketplace: z.record(z.string(), z.object({ n: z.number(), min: z.number().nullable(), median: z.number().nullable(), sold_n: z.number().optional(), sold_median: z.number().nullable().optional() })),
  considered: z.number(), kept_after_relevance: z.number(),
  opportunities: z.array(z.object({ listing: compactSchema, tier: z.string().optional(), buy_usd: z.number().optional(), ship_usd: z.number().optional(), sell_est_usd: z.number().optional(), comps_n: z.number().optional(), comps_venue: z.string().optional(), comps_tier: z.string().optional(), comp_basis: z.string().optional(), comp_sample: z.array(z.object({ title: z.string(), usd: z.number(), url: z.string(), size: z.string().nullable().optional() })).optional(), demand: z.number().optional(), demand_label: z.string().optional(), ship_assumed: z.boolean().optional(), fee_pct: z.number().optional(), net_profit_usd: z.number().optional(), margin_pct: z.number().optional(), reference_usd: z.number(), reference_from: z.string(), spread_usd: z.number(), spread_pct: z.number(), relevance: z.number(), counterpart: z.object({ marketplace: z.string(), url: z.string(), price_usd: z.number().nullable(), sold: z.boolean().optional() }).optional(), photo_match: z.number().nullable().optional(), catch_risk: z.number().optional(), catch_reason: z.string().optional(), replica_risk: z.number().optional(), suspected_replica: z.boolean().optional() })),
  errors: z.array(z.string()),
  sources: z.array(compactSchema.extend({ relevance: z.number().optional() })).optional(),
});
const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], structuredContent: o as any });

loadRegistry();
const server = new MCPServer({ name: "marketplace-mcp", title: "Marketplace", version: "0.3.0", description: "Search, compare and spot arbitrage across eBay, Grailed, Amazon and any server-rendered marketplace", instructions: "Use search for listings, item for details, arbitrage for cross-marketplace spreads (renders a board), add_marketplace to onboard a new site from its URL." });

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

export const itemTool = server.tool({
  name: "item",
  description: "Details for one listing: title, price, condition, photos, description, seller and reviews where the marketplace exposes them (eBay, Grailed, Amazon). Use the marketplace and id from search() or arbitrage().",
  inputSchema: z.object({ marketplace: z.string(), id: z.string() }),
  outputSchema: z.object({ error: z.string().optional(), listing: compactSchema.optional(), description: z.string().nullable().optional(), photos: z.array(z.string()).optional(), reviews: z.array(z.object({ rating: z.number().nullable(), title: z.string().nullable().optional(), body: z.string(), date: z.string().nullable().optional() })).optional() }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ marketplace, id }) => {
  const a = adapters[marketplace]; if (!a) return text({ error: `unknown marketplace ${marketplace}` });
  if (!a.item) return text({ error: `${marketplace} has no item details yet; open the listing URL` });
  try {
    const d = await a.item(id);
    return text({ listing: compact(d.listing), description: d.description ?? null, photos: d.photos ?? (d.listing.image ? [d.listing.image] : []), reviews: (d.reviews ?? []).slice(0, 6).map((r) => ({ rating: r.rating, title: r.title, body: r.body.slice(0, 300), date: r.date })) });
  } catch (e: any) { return text({ error: e.message.split("\n")[0] }); }
});

export const arbitrageTool = server.tool({
  name: "arbitrage",
  description: "Find resale flips: live listings you can buy on one marketplace and resell on another for a net profit after fees and shipping. Sell price = median of SOLD listings (Poshmark, Mercari) in the same condition tier; only candidates with >= min_comps sold comps, net >= min_net_usd and margin >= min_spread_pct are returned, ranked by net profit, each with evidence: relevance, photo_match against a real sale, catch_risk + catch_reason, replica_risk. Listings marked suspected_replica are likely counterfeits: never recommend them, say why. Renders a board. 20-50 s.",
  inputSchema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(10).default(5), min_spread_pct: z.number().min(0).max(0.9).default(0.2).describe("minimum margin after fees, as a fraction of cost"), min_net_usd: z.number().min(0).default(25), min_comps: z.number().int().min(1).default(3) }),
  outputSchema: arbitrageOutput,
  view: { name: "arbitrage-board", description: "Cross-marketplace spreads with photo, relevance and catch-risk evidence", prefersBorder: false, csp: { resourceDomains: ["https://i.ebayimg.com", "https://m.media-amazon.com", "https://media-assets.grailed.com"] } },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, limit, min_spread_pct, min_net_usd, min_comps }) => {
  const r = await arbitrage(query, { limit, min_spread_pct, min_net_usd, min_comps });
  // sources ride in structuredContent (the View's data channel); _meta is reserved for host UI metadata and broke rendering
  const out = { ...r, opportunities: r.opportunities.map((o) => ({ ...o, listing: compact(o.listing) })), sources: r.sources.slice(0, 120).map((l) => ({ ...compact(l), relevance: (l as any).relevance })) };
  const reps = out.opportunities.filter((o) => o.suspected_replica);
  const top = out.opportunities.find((o) => !o.suspected_replica) ?? out.opportunities[0];
  const replicaNote = reps.length ? ` WARNING: ${reps.length} of the cheapest listings look like replicas or counterfeits (${reps.map((o) => `${o.listing.m} $${o.listing.usd}`).join(", ")}); do not recommend or buy those, say why, and prefer the genuine finds.` : "";
  const summary = (top
    ? `${out.opportunities.length} flips for "${query}". Best genuine-looking: buy ${top.listing.m} $${top.listing.usd} (${top.tier}), sells ~$${top.sell_est_usd} on ${top.comps_venue} (${top.comps_n} sold, ${top.comp_basis}; demand ${top.demand_label}), net ~$${top.net_profit_usd} after ${Math.round((top.fee_pct ?? 0) * 100)}% fees (${Math.round((top.margin_pct ?? 0) * 100)}% margin; catch_risk ${top.catch_risk ?? "n/a"}, photo_match ${top.photo_match ?? "n/a"}, replica_risk ${top.replica_risk ?? "n/a"}). Sell side: ${out.reference.sold_comps} sold listings on ${(out.reference.sold_venues ?? []).join("+") || "none"}. ${out.considered} live listings, ${out.kept_after_relevance} relevant.`
    : `No flip for "${query}" clears $${min_net_usd} and ${Math.round(min_spread_pct * 100)}% after fees with ≥${min_comps} sold comps; ${out.considered} live listings and ${out.reference.sold_comps} sold comps seen.`) + replicaNote;
  return { content: [{ type: "text" as const, text: summary + " " + JSON.stringify(out.opportunities.map((o) => ({ m: o.listing.m, buy: o.listing.usd, ship: o.ship_usd, sells: o.sell_est_usd, on: o.comps_venue, comps: o.comps_n, demand: o.demand_label, net: o.net_profit_usd, margin: o.margin_pct, catch: o.catch_risk, why: o.catch_reason, replica: o.replica_risk, suspected_replica: o.suspected_replica || undefined, url: o.listing.url }))) }], structuredContent: out as any };
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
