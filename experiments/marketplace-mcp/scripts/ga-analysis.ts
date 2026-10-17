import { writeFileSync } from "node:fs";
import { adapters } from "../src/adapters/index.js";
import { loadRegistry } from "../src/registry.js";
import { catchRisk, relevance, samePhoto } from "../src/jev.js";
import { inferSize, tier, type Listing } from "../src/types.js";
import { closeBrowser } from "../src/browser.js";
loadRegistry();
const ITEMS = [
  ["Enfants Riches Deprimes", "Western Leather Jacket", 3500, "XXL", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/2C399C8A-FD83-427A-B463-9AC720FB1BCE.jpg", "erd-western-leather-jacket-size-xxl"],
  ["Chrome Hearts", "Las Vegas Horseshoe Shirt", 550, "L", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/29FF47F3-582A-4609-948B-18A90D8F0581.jpg", "chrome-hearts-las-vegas-horseshoe-shirt-size-large"],
  ["Chrome Hearts", "Diamond Baby Floral Ring", 4000, "6.5", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/500D53D4-3600-4149-8567-F286F91AD406.jpg", "chrome-hearts-diamond-baby-floral-ring-size-6-5"],
  ["Chrome Hearts", "Matty Boy 99 Eyes Spacer Ring", 1000, "8", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/F71B5E32-983E-4831-98F7-66C70841514C.jpg", "matty-boy-99-eyes-spacer-size-8"],
  ["Chrome Hearts", "True Fucking Punk Spacer Ring", 500, "8", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/443D2B55-220B-4DB3-8F09-619C1E653538.jpg", "true-fucking-punk-spacer-size-8"],
  ["Chrome Hearts", "Paper Chain Necklace", 1700, "20 in", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/FE4BF881-F138-403F-A0F7-FA05693A52ED.jpg", "paperchain-necklace-20"],
  ["Chrome Hearts", "White Script Tee", 450, "XXL", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/81E97EF6-D1D1-45C4-85A5-FBD7D9083C33.jpg", "chrome-hearts-white-script-tee"],
  ["Chrome Hearts", "CH Plus Magnet", 500, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/8A77C2A9-D68B-4053-B747-14496CB4DAA5.jpg", "chrome-hearts-ch-plus-magnet"],
  ["Kapital", "Moto Pants", 850, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/0c546d20bd0849d4a69cb08bc65d5b68.jpg", "kapital-moto-pants"],
  ["Dries Van Noten", "Zip Bomber", 1200, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/f5c59fabf7264238a0fa4f70a14f0fa9.jpg", "dries-van-noten-zip-bomber"],
  ["Acne Studios", "Long Baggy Denim Shorts", 500, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/e5d5e5da3890455ebf3e0244962d816c.jpg", "acne-studios-acne-long-baggy-denim-shorts"],
  ["Chrome Hearts", "Green Gunslinger Ring", 7000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/9f84c48302f54f0aab5199853a3f3b32.jpg", "chrome-hearts-green-gunslinger"],
  ["Chrome Hearts", "Black Reversible Jersey", 905, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/7f6d19f9acba4d02a98b2b3cd46d0ef5.jpg", "chrome-hearts-black-reversible-jersey"],
  ["Chrome Hearts", "Gold Diamond CH Plus Stud Earrings", 7000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/03d41e03d50549f3984a50be71365d51.jpg", "chrome-hearts-gold-diamond-ch-plus-stud-earrings"],
  ["Chrome Hearts", "22k Gold Blue Sapphire Star Stud Earrings", 7500, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/d8baf78d63cc44488e03e562b244a497.jpg", "chrome-hearts-22k-gold-blue-sapphire-star-stud-earrings"],
  ["Chrome Hearts", "Championship Ring with Diamonds", 4000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/cbfd820cf4bb4261936740f20bfa050a.jpg", "chrome-hearts-championship-ring-w-diamonds"],
  ["Chrome Hearts", "Sillichrome Hoop Earrings", 650, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/fd2fc1c533384233a71af62c27d5934b.jpg", "chrome-hearts-sillichrome-hoop-earrings"],
  ["Chrome Hearts", "True Fucking Love Diamond Pave Ring", 4500, "7.5", "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/eb117bc1a25441f09fb414e42e4fd7d5.jpg", "chrome-hearts-true-fucking-love-diamond-pave-ring-size-7-5"],
  ["Chrome Hearts", "Gold Star Stud Earrings", 4000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/a979dbc4c4d64325ae7929b93432175b.jpg", "chrome-hearts-gold-star-stud-earrings"],
  ["Chrome Hearts", "Wave Ring", 1850, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/483de3213ad84a01b4aebc3165f4f891.jpg", "chrome-hearts-wave-ring"],
  ["Chrome Hearts", "Long Dice Wallet Chain Double Clasp", 14000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/d6154c6d99254fa19f6037a6beef14cd.jpg", "chrome-hearts-long-dice-wallet-chain-double-clasp"],
  ["Chrome Hearts", "Cemetery Ring", 2000, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/1B5C3E10-ECB5-4016-BDA3-1D67CDFF8D1A.jpg", "chrome-hearts-cemetery-ring"],
  ["Chrome Hearts", "Fancy Wallet Chain Double Clasp", 9250, null, "https://cdn.shopify.com/s/files/1/0750/9075/5636/files/5F424B28-7175-45A4-B0BE-C38358AFADBD.jpg", "double-clasp-fancy-wallet-chain"],
  ["Chrome Hearts", "Cross and Ball Pendant with Ball Chain", 1400, null, null, "chrome-hearts-cross-and-ball-pendant-w-ball-chain"],
] as const;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const out: any[] = []; const OUT = ".cache/ga-analysis.json";
for (const [brand, title, price, size, img, slug] of ITEMS) {
  const q = `${brand} ${title}`.replace(/ Ring with Diamonds/, " Ring").replace(/ with Ball Chain/, "");
  const t0 = Date.now(); const rec: any = { brand, title, price, size, img, url: `https://greenairlines.us/products/${slug}`, query: q, errors: [] as string[] };
  try {
    const liveVenues = ["grailed", "ebay", "poshmark", "mercari"]; const soldVenues = ["poshmark", "mercari"];
    const [live, sold] = await Promise.all([
      Promise.all(liveVenues.map(async (v) => { try { return await adapters[v].search(q, { limit: 25 }); } catch (e: any) { rec.errors.push(`${v}: ${e.message.split("\n")[0]}`); return [] as Listing[]; } })),
      Promise.all(soldVenues.map(async (v) => { try { return await adapters[v].search(q, { limit: 40, sold: true }); } catch (e: any) { rec.errors.push(`${v} sold: ${e.message.split("\n")[0]}`); return [] as Listing[]; } })),
    ]);
    const L = live.flat().filter((l) => l.price_usd && l.price_usd > 0 && !l.sponsored && !l.sold).map((l) => ({ ...l, size: l.size ?? inferSize(l.title) }));
    const S = sold.flat().filter((s) => (s.sold_price_usd ?? s.price_usd)).map((s) => ({ ...s, price: (s.sold_price_usd ?? s.price_usd)! }));
    const [rl, rs] = await Promise.all([relevance(q, L), relevance(q, S)]);
    const liveRel = L.filter((_, i) => rl[i] >= 0.7); const soldRel = S.filter((_, i) => rs[i] >= 0.7);
    // replica screen on every relevant live listing cheaper than his price, and on sold comps below 35% of his price (the fake band)
    const cheap = liveRel.filter((l) => l.price_usd! < price).sort((a, b) => a.price_usd! - b.price_usd!).slice(0, 8);
    const judged = await Promise.all(cheap.map(async (l) => ({ l, j: await catchRisk(l, price) })));
    const soldSuspect = soldRel.filter((s) => s.price < price * 0.35);
    const soldJudged = await Promise.all(soldSuspect.slice(0, 6).map(async (s) => ({ s, j: await catchRisk(s as any, price) })));
    const fakeSold = new Set(soldJudged.filter((x) => x.j.replica >= 0.5).map((x) => x.s.id));
    const soldClean = soldRel.filter((s) => !fakeSold.has(s.id) && !(s.price < price * 0.35 && !soldJudged.some((x) => x.s.id === s.id)));
    const grailedAsks = liveRel.filter((l) => l.marketplace === "grailed").map((l) => l.price_usd!);
    const candidates = judged.filter((x) => x.j.replica < 0.5 && x.j.risk < 0.6).map((x) => ({ ...x.l, replica_risk: Math.round(x.j.replica * 100) / 100, catch_risk: Math.round(x.j.risk * 100) / 100, catch_reason: x.j.reason, net_at_store_price: Math.round(price * 0.97 - x.l.price_usd! - (x.l.shipping_usd ?? 10)) }));
    const rejected = judged.filter((x) => !(x.j.replica < 0.5 && x.j.risk < 0.6)).map((x) => ({ ...x.l, replica_risk: Math.round(x.j.replica * 100) / 100, catch_risk: Math.round(x.j.risk * 100) / 100, catch_reason: x.j.reason }));
    for (const c of candidates.slice(0, 3)) { if (img && c.image) { const pm = await samePhoto({ ...c, image: img, title: `${brand} ${title}` } as any, c); (c as any).photo_match = pm == null ? null : Math.round(pm * 100) / 100; } }
    Object.assign(rec, { live_n: L.length, live_relevant: liveRel.length, grailed_ask_median: median(grailedAsks), grailed_ask_min: grailedAsks.length ? Math.min(...grailedAsks) : null, grailed_n: grailedAsks.length, sold_n: soldClean.length, sold_median: median(soldClean.map((s) => s.price)), sold_fakes_removed: fakeSold.size,
      sources: liveRel.map((l) => ({ m: l.marketplace, usd: l.price_usd, title: l.title.slice(0, 70), url: l.url, size: l.size ?? null })).concat(soldClean.map((s) => ({ m: s.marketplace, usd: s.price, title: s.title.slice(0, 70), url: s.url, size: s.size ?? null, sold: true }))),
      candidates: candidates.sort((a, b) => b.net_at_store_price - a.net_at_store_price).map((c) => ({ m: c.marketplace, usd: c.price_usd, ship: c.shipping_usd ?? null, title: c.title.slice(0, 80), url: c.url, img: c.image, size: c.size ?? null, cond: c.condition, replica_risk: c.replica_risk, catch_risk: c.catch_risk, catch_reason: c.catch_reason, photo_match: (c as any).photo_match ?? null, net_at_store_price: c.net_at_store_price })),
      rejected: rejected.map((r) => ({ m: r.marketplace, usd: r.price_usd, title: r.title.slice(0, 80), url: r.url, img: r.image, replica_risk: r.replica_risk, catch_risk: r.catch_risk, catch_reason: r.catch_reason })), ms: Date.now() - t0 });
  } catch (e: any) { rec.errors.push(e.message.split("\n")[0]); }
  out.push(rec); writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`${brand} ${title} $${price}: live ${rec.live_relevant ?? 0}/${rec.live_n ?? 0} grailed med $${rec.grailed_ask_median ?? "—"} (n=${rec.grailed_n ?? 0}) sold med $${rec.sold_median ?? "—"} (n=${rec.sold_n ?? 0}, fakes ${rec.sold_fakes_removed ?? 0}) candidates ${rec.candidates?.length ?? 0} rejected ${rec.rejected?.length ?? 0} ${Math.round((rec.ms ?? 0) / 1000)}s ${rec.errors.length ? "| " + rec.errors.join("; ").slice(0, 80) : ""}`);
}
await closeBrowser();
