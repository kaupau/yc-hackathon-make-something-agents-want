import { adapters } from "./adapters/index.js";
import { catchRisk, relevance, samePhoto, type CatchReason } from "./jev.js";
import { FEES, inferSize, tier, type Listing, type Tier } from "./types.js";

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const r2 = (n: number) => Math.round(n * 100) / 100;
const STOP = new Set(["the","a","an","and","or","of","for","with","in","on","to","men","mens","women","womens","size","new","used","authentic","genuine","rare","vintage"]);
const toks = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9.+ ]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
/** Overlap coefficient on title tokens, nudged by size agreement: the comps that are the same model and size count most. */
const similarity = (a: Listing, b: Listing) => {
  const A = toks(a.title), B = toks(b.title); let inter = 0; for (const w of A) if (B.has(w)) inter++;
  let sim = inter / Math.max(1, Math.min(A.size, B.size));
  const sa = a.size?.toLowerCase().replace(/^us\s*/, ""), sb = b.size?.toLowerCase().replace(/^us\s*/, "");
  if (sa && sb) sim += sa === sb ? 0.2 : -0.25;
  return sim;
};
/** Median after dropping prices outside 1.5×IQR, so one mis-tagged comp cannot set the sell price. */
const trimmedMedian = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); if (s.length < 4) return median(s); const q1 = s[Math.floor(s.length / 4)], q3 = s[Math.floor((3 * s.length) / 4)], iqr = q3 - q1; const t = s.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr); return median(t.length >= 3 ? t : s); };
/** Inbound shipping when the listing does not state it (buyer-pays norms, 2026). */
const SHIP_IN: Record<string, number> = { ebay: 10, poshmark: 8, mercari: 6, grailed: 12, amazon: 0, vinted: 6, depop: 6 };

export interface Opportunity {
  listing: Listing; tier: Tier;
  buy_usd: number; ship_usd: number;
  sell_est_usd: number; comps_n: number; comps_venue: string; comps_tier: string; comp_basis: string; comp_sample: { title: string; usd: number; url: string; size?: string | null }[]; demand: number; demand_label: string; fee_pct: number; ship_assumed?: boolean;
  net_profit_usd: number; margin_pct: number; net_if_offer_usd?: number;
  // kept for the board and older clients
  reference_usd: number; reference_from: string; spread_usd: number; spread_pct: number;
  relevance: number; counterpart?: { marketplace: string; url: string; price_usd: number | null; sold?: boolean }; photo_match?: number | null; catch_risk?: number; catch_reason?: CatchReason; replica_risk?: number; suspected_replica?: boolean;
}

/**
 * Material arbitrage: buy on one marketplace, resell on another, and clear a margin after fees and shipping.
 * Sell side = SOLD listings (what buyers actually paid), matched to the buy listing's condition tier, from the
 * marketplaces that expose sold data (Poshmark, Mercari; eBay/Grailed hide it from us). Buy side = every live
 * listing. Jev filters relevance, replica risk and catches on the ranked results.
 */
export async function arbitrage(query: string, opts: { limit?: number; min_spread_pct?: number; min_net_usd?: number; min_comps?: number; marketplaces?: string[] } = {}) {
  const names = opts.marketplaces?.length ? opts.marketplaces : Object.keys(adapters);
  const minMargin = opts.min_spread_pct ?? 0.2, minNet = opts.min_net_usd ?? 25, minComps = opts.min_comps ?? 3;
  const soldVenues = Object.keys(adapters).filter((n) => ["poshmark", "mercari", "ebay"].includes(n));
  const soldErrors: string[] = [];
  const [live, soldSets] = await Promise.all([
    Promise.all(names.map(async (n) => { try { return await adapters[n].search(query, { limit: 25 }); } catch (e: any) { return [{ marketplace: n, id: "error", title: `ERROR ${e.message.split("\n")[0]}`, price_usd: null, condition: null, url: "", image: null } as Listing]; } })),
    Promise.all(soldVenues.map(async (n) => { try { return await adapters[n].search(query, { limit: 40, sold: true }); } catch (e: any) { soldErrors.push(`${n} sold: ${e.message.split("\n")[0]}`); return [] as Listing[]; } })),
  ]);
  const errors = [...live.flat().filter((l) => l.id === "error").map((l) => `${l.marketplace}: ${l.title}`), ...soldErrors];
  const listings = live.flat().filter((l) => l.id !== "error" && l.price_usd !== null && l.price_usd! > 0 && !l.sponsored && !l.sold).map((l) => ({ ...l, size: l.size ?? inferSize(l.title) }));
  const sold = soldSets.flat().filter((s) => (s.sold_price_usd ?? s.price_usd) != null).map((s) => ({ ...s, size: s.size ?? inferSize(s.title), tier: tier(s.condition, s.title), price: (s.sold_price_usd ?? s.price_usd)! }));

  // relevance on both sides so a kids' jacket or a MoonSwatch never becomes a comp
  const [relLive, relSold] = await Promise.all([relevance(query, listings), relevance(query, sold)]);
  const kept = listings.map((l, i) => ({ l, r: relLive[i] })).filter((x) => x.r >= 0.6);
  const comps = sold.filter((_, i) => relSold[i] >= 0.6);

  const byMarket: Record<string, { n: number; min: number | null; median: number | null; sold_n: number; sold_median: number | null }> = {};
  for (const n of names) { const ps = kept.filter((x) => x.l.marketplace === n).map((x) => x.l.price_usd!); const ss = comps.filter((c) => c.marketplace === n).map((c) => c.price); byMarket[n] = { n: ps.length, min: ps.length ? Math.min(...ps) : null, median: median(ps), sold_n: ss.length, sold_median: median(ss) }; }

  const opps: Opportunity[] = [];
  for (const { l, r } of kept) {
    const t = tier(l.condition, l.title);
    const sameTier = comps.filter((c) => c.tier === t || (t === "like_new" && c.tier === "used") || (t === "used" && c.tier === "like_new"));
    const pool = sameTier.length >= minComps ? sameTier : comps;
    const compsTier = sameTier.length >= minComps ? t : "any";
    if (pool.length < minComps) continue;
    // closest comps first: same model words, same size; need at least minComps that look like the same thing
    const ranked = pool.map((c) => ({ c, sim: similarity(l, c) })).sort((a, b) => b.sim - a.sim);
    const close = ranked.filter((x) => x.sim >= 0.34).slice(0, Math.max(8, minComps));
    const chosen = (close.length >= minComps ? close : ranked.slice(0, Math.max(5, minComps))).map((x) => x.c);
    const basis = close.length >= minComps ? `${chosen.length} closest matches by title${l.size ? ` and size ${l.size}` : ""}` : `${chosen.length} nearest comps (titles only loosely match)`;
    // resell where those comps sold: the venue with the most of them
    const venueCount: Record<string, number> = {}; for (const c of chosen) venueCount[c.marketplace] = (venueCount[c.marketplace] ?? 0) + 1;
    const venue = Object.entries(venueCount).sort((a, b) => b[1] - a[1])[0][0];
    const venuePool = chosen.filter((c) => c.marketplace === venue);
    const basisPool = venuePool.length >= minComps ? venuePool : chosen;
    const sell = trimmedMedian(basisPool.map((c) => c.price))!;
    const fee = FEES[venue] ?? 0.15; const shipAssumed = l.shipping_usd == null; const ship = l.shipping_usd ?? SHIP_IN[l.marketplace] ?? 8; const buy = l.price_usd!;
    const net = sell * (1 - fee) - buy - ship; const margin = net / (buy + ship);
    if (net < minNet || margin < minMargin) continue;
    const liveOnVenue = byMarket[venue]?.n ?? 0, soldOnVenue = byMarket[venue]?.sold_n ?? 0;
    const demand = soldOnVenue / Math.max(1, liveOnVenue);
    const demandLabel = demand >= 1 ? "sells fast" : demand >= 0.4 ? "steady" : "slow";
    const netOffer = l.best_offer ? Math.round(sell * (1 - fee) - buy * 0.9 - ship) : undefined;
    opps.push({ listing: l, tier: t, buy_usd: buy, ship_usd: ship, ship_assumed: shipAssumed, net_if_offer_usd: netOffer, sell_est_usd: Math.round(sell), comps_n: basisPool.length, comps_venue: venue, comps_tier: compsTier, comp_basis: basis, comp_sample: basisPool.slice(0, 3).map((c) => ({ title: c.title.slice(0, 70), usd: c.price, url: c.url, size: c.size ?? null })), demand: r2(demand), demand_label: demandLabel, fee_pct: fee, net_profit_usd: Math.round(net), margin_pct: r2(margin), reference_usd: Math.round(sell), reference_from: `trimmed median of ${basisPool.length} sold on ${venue} (${compsTier}; ${basis})`, spread_usd: Math.round(sell - buy), spread_pct: r2((sell - buy) / sell), relevance: r2(r) });
  }
  opps.sort((a, b) => b.net_profit_usd - a.net_profit_usd);
  const top = opps.slice(0, Math.max(opts.limit ?? 5, 8));
  await Promise.all(top.map(async (o) => {
    const cp = comps.filter((c) => c.image && c.marketplace === o.comps_venue).sort((a, b) => Math.abs(a.price - o.sell_est_usd) - Math.abs(b.price - o.sell_est_usd))[0]
      ?? kept.map((x) => x.l).filter((l) => l.marketplace !== o.listing.marketplace && l.image && l.price_usd !== null).sort((a, b) => a.price_usd! - b.price_usd!)[0];
    const [pm, cr] = await Promise.all([cp ? samePhoto(o.listing, cp) : Promise.resolve(null), catchRisk(o.listing, o.sell_est_usd)]);
    if (cp) o.counterpart = { marketplace: cp.marketplace, url: cp.url, price_usd: (cp as any).price ?? cp.price_usd, sold: !!cp.sold };
    o.photo_match = pm === null ? null : r2(pm); o.catch_risk = r2(cr.risk); o.catch_reason = cr.reason; o.replica_risk = r2(cr.replica);
    o.suspected_replica = cr.replica >= 0.5 || (cr.reason === "replica_or_authenticity" && cr.risk >= 0.3);
  }));
  // suspected replicas and likely catches sink; genuine, clean finds lead
  top.sort((a, b) => Number(!!a.suspected_replica) - Number(!!b.suspected_replica) || Number((a.catch_risk ?? 0) >= 0.6) - Number((b.catch_risk ?? 0) >= 0.6) || b.net_profit_usd - a.net_profit_usd);
  return {
    query, reference: { sold_comps: comps.length, sold_median_usd: median(comps.map((c) => c.price)), sold_venues: soldVenues.filter((v) => comps.some((c) => c.marketplace === v)) },
    by_marketplace: byMarket, considered: listings.length, kept_after_relevance: kept.length,
    opportunities: top.slice(0, opts.limit ?? 5), errors,
    sources: [...kept.map(({ l, r }) => ({ ...l, relevance: r2(r) })), ...comps.map((c) => ({ ...c, price_usd: c.price, relevance: 1 }))].sort((a, b) => a.marketplace.localeCompare(b.marketplace) || Number(!!a.sold) - Number(!!b.sold) || (a.price_usd ?? 0) - (b.price_usd ?? 0)),
  };
}
