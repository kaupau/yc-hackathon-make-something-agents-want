import { adapters } from "./adapters/index.js";
import { catchRisk, relevance, samePhoto, type CatchReason } from "./jev.js";
import { FEES, tier, type Listing, type Tier } from "./types.js";

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface Opportunity {
  listing: Listing; tier: Tier;
  buy_usd: number; ship_usd: number;
  sell_est_usd: number; comps_n: number; comps_venue: string; comps_tier: string; fee_pct: number;
  net_profit_usd: number; margin_pct: number;
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
  const listings = live.flat().filter((l) => l.id !== "error" && l.price_usd !== null && l.price_usd! > 0 && !l.sponsored && !l.sold);
  const sold = soldSets.flat().filter((s) => (s.sold_price_usd ?? s.price_usd) != null).map((s) => ({ ...s, tier: tier(s.condition, s.title), price: (s.sold_price_usd ?? s.price_usd)! }));

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
    // resell where the comps are: the venue with the most comps for this tier
    const venueCount: Record<string, number> = {}; for (const c of pool) venueCount[c.marketplace] = (venueCount[c.marketplace] ?? 0) + 1;
    const venue = Object.entries(venueCount).sort((a, b) => b[1] - a[1])[0][0];
    const venuePool = pool.filter((c) => c.marketplace === venue);
    const sell = median((venuePool.length >= minComps ? venuePool : pool).map((c) => c.price))!;
    const fee = FEES[venue] ?? 0.15; const ship = l.shipping_usd ?? 0; const buy = l.price_usd!;
    const net = sell * (1 - fee) - buy - ship; const margin = net / (buy + ship);
    if (net < minNet || margin < minMargin) continue;
    opps.push({ listing: l, tier: t, buy_usd: buy, ship_usd: ship, sell_est_usd: Math.round(sell), comps_n: (venuePool.length >= minComps ? venuePool : pool).length, comps_venue: venue, comps_tier: compsTier, fee_pct: fee, net_profit_usd: Math.round(net), margin_pct: r2(margin), reference_usd: Math.round(sell), reference_from: `median of ${(venuePool.length >= minComps ? venuePool : pool).length} sold on ${venue} (${compsTier})`, spread_usd: Math.round(sell - buy), spread_pct: r2((sell - buy) / sell), relevance: r2(r) });
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
