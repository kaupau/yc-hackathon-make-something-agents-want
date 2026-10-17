import { adapters } from "./adapters/index.js";
import { ebay } from "./adapters/ebay.js";
import { relevance } from "./jev.js";
import type { Listing } from "./types.js";

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

export interface Opportunity { listing: Listing; reference_usd: number; reference_from: string; spread_usd: number; spread_pct: number; relevance: number }

/**
 * Cross-marketplace price gaps for one product query.
 * Reference price = median of eBay SOLD+completed comps when available (what buyers actually paid;
 * Grailed's sold index is closed to the anonymous search key),
 * else the median live ask across the other marketplaces. Jev filters listings that are not
 * the product itself (accessories, other models) before any spread is quoted.
 */
export async function arbitrage(query: string, opts: { limit?: number; min_spread_pct?: number; marketplaces?: string[] } = {}) {
  const names = opts.marketplaces?.length ? opts.marketplaces : Object.keys(adapters);
  const [live, soldComps] = await Promise.all([
    Promise.all(names.map(async (n) => { try { return await adapters[n].search(query, { limit: 20 }); } catch (e: any) { return [{ marketplace: n, id: "error", title: `ERROR ${e.message.split("\n")[0]}`, price_usd: null, condition: null, url: "", image: null } as Listing]; } })),
    ebay.search(query, { limit: 30, sold: true }).catch(() => [] as Listing[]),
  ]);
  const errors = live.flat().filter((l) => l.id === "error").map((l) => `${l.marketplace}: ${l.title}`);
  const listings = live.flat().filter((l) => l.id !== "error" && l.price_usd !== null && !l.sponsored);
  const rel = await relevance(query, listings);
  const kept = listings.map((l, i) => ({ l, r: rel[i] })).filter((x) => x.r >= 0.6);
  const soldPrices = soldComps.map((s) => s.sold_price_usd ?? s.price_usd).filter((p): p is number => p !== null);
  const soldMedian = median(soldPrices);
  const byMarket: Record<string, { n: number; min: number | null; median: number | null }> = {};
  for (const n of names) { const ps = kept.filter((x) => x.l.marketplace === n).map((x) => x.l.price_usd!); byMarket[n] = { n: ps.length, min: ps.length ? Math.min(...ps) : null, median: median(ps) }; }
  const opps: Opportunity[] = [];
  for (const { l, r } of kept) {
    const others = kept.filter((x) => x.l.marketplace !== l.marketplace).map((x) => x.l.price_usd!);
    const ref = soldMedian ?? median(others); const from = soldMedian ? "ebay sold comps (median)" : "median live ask on other marketplaces";
    if (ref === null) continue;
    const spread = ref - l.price_usd!; const pct = spread / ref;
    if (pct >= (opts.min_spread_pct ?? 0.25)) opps.push({ listing: l, reference_usd: ref, reference_from: from, spread_usd: Math.round(spread), spread_pct: Math.round(pct * 100) / 100, relevance: Math.round(r * 100) / 100 });
  }
  opps.sort((a, b) => b.spread_usd - a.spread_usd);
  return { query, reference: { sold_comps: soldPrices.length, sold_median_usd: soldMedian }, by_marketplace: byMarket, considered: listings.length, kept_after_relevance: kept.length, opportunities: opps.slice(0, opts.limit ?? 5), errors };
}
