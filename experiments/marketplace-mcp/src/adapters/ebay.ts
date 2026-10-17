import { tinyfishFetch } from "../tinyfish.js";
import type { Adapter, Listing, Review, SearchOptions } from "../types.js";
import { money } from "../types.js";

/**
 * eBay blocks plain curl and a local headless Chromium ("Error Page"), but TinyFish's
 * server-side render passes when a cached entry is allowed (ttl omitted). TinyFish's HTML and
 * JSON formats strip anchors and classes, so the markdown bullets + ordered links are parsed.
 * Upgrade path: the official Browse API (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET) when a dev account exists.
 */
function searchUrl(q: string, sold: boolean) {
  const base = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sop=15`;
  return sold ? `${base}&LH_Sold=1&LH_Complete=1` : base;
}

function fromMarkdown(md: string, links: string[], sold: boolean, images: string[] = []): Listing[] {
  // listing photos are i.ebayimg.com/images/g/<id>/s-l*.webp in result order; Jev needs JPEG so swap the extension
  // search-result thumbnails are the s-l500 renditions; the page also carries promo/hero images (s-l1600) that would shift the alignment
  const imgs = [...new Set(images.filter((u) => /i\.ebayimg\.com\/images\/g\/[^/]+\/s-l500\.(webp|jpg)$/.test(u)))].map((u) => u.replace(/\.webp$/, ".jpg"));
  // eBay's page template carries a dummy /itm/123456 link; with it removed, link order matches bullet order (verified against item pages 2026-10-17)
  const ids = [...new Set(links.map((l) => l.match(/\/itm\/(\d+)/)?.[1]).filter((x) => x && x !== "123456"))] as string[];
  const bullets = md.split("\n").filter((l) => l.startsWith("* ") && /\$\s?\d/.test(l));
  // auction / price-range rows have no title before the price ("$1.88 to $788.88Buy It Now…"); keep them out rather than misalign
  return bullets.map((b, i): Listing => {
    const text = b.slice(2);
    const title = text.split(/Opens in a new window or tab/)[0].replace(/New Listing/i, "").trim();
    if (!title || /^\$/.test(title)) return null as any;
    const cond = text.match(/(Pre-Owned|Brand New|New with tags|New without tags|Open box|Parts Only|Certified - Refurbished|Excellent - Refurbished|Very Good - Refurbished|Good - Refurbished)/i)?.[1] ?? null;
    const prices = [...text.matchAll(/\$\s?([\d,]+(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    const ship = text.match(/\+\$\s?([\d,]+(?:\.\d\d)?)/)?.[1];
    const id = ids[i] ?? `md-${i}`;
    return { marketplace: "ebay", id, title, price_usd: prices[0] ?? null, condition: cond, url: `https://www.ebay.com/itm/${id}`, image: imgs[i] ?? null, best_offer: /or Best Offer/i.test(text), shipping_usd: ship ? Number(ship.replace(/,/g, "")) : /Free (shipping|delivery)/i.test(text) ? 0 : null, sold };
  }).filter(Boolean);
}

export const ebay: Adapter = {
  name: "ebay",
  via: "TinyFish server-side render of ebay.com/sch (cached up to a few minutes); Browse API when creds are set",
  async item(id: string) {
    const r = await tinyfishFetch([`https://www.ebay.com/itm/${id}`], { format: "markdown", images: true, purpose: "read one product listing's photos, price, condition and description" });
    const res = r.results[0]; if (!res) throw new Error(`ebay item ${id}: ${r.errors[0]?.error ?? "no result"}`);
    const text = res.text ?? "";
    if (/Checking your browser|Something went wrong on our end/i.test(text)) throw new Error(`ebay item ${id}: bot wall`);
    const photos = [...new Set((res.image_links ?? []).map((u) => u.match(/i\.ebayimg\.com\/images\/g\/([^/]+)\//)?.[1]).filter(Boolean))].slice(0, 8).map((k) => `https://i.ebayimg.com/images/g/${k}/s-l1600.jpg`);
    const price = money(text.match(/US \$([\d,]+(?:\.\d\d)?)/)?.[1] ?? text.match(/\$([\d,]+(?:\.\d\d)?)/)?.[1]);
    const cond = text.match(/Condition:?\s*\n*\s*([^\n]{3,60})/i)?.[1]?.trim() ?? null;
    const seller = text.match(/([A-Za-z0-9_.\-]{3,30})\s*\(\d[\d,]*\)\s*\n?\s*[\d.]+% positive/i)?.[1] ?? null;
    const fb = text.match(/([\d.]+)% positive/i)?.[1];
    const descIdx = text.search(/About this item|Item description from the seller|Item specifics/i);
    const description = (descIdx >= 0 ? text.slice(descIdx) : text).replace(/\s+/g, " ").slice(0, 900);
    const listing: Listing = { marketplace: "ebay", id, title: (res.title ?? "").replace(/\s*\|\s*eBay$/, ""), price_usd: price, condition: cond, url: `https://www.ebay.com/itm/${id}`, image: photos[0] ?? null, seller, rating: fb ? Number(fb) / 20 : null };
    const reviews: Review[] = [];
    return { listing, description, reviews, photos };
  },
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20; const sold = !!opts.sold;
    // lowercase + collapsed whitespace so equivalent queries share TinyFish's cache (a cached render is what gets past eBay's bot check)
    const url = searchUrl(query.toLowerCase().replace(/\s+/g, " ").trim(), sold);
    let rows: Listing[] = []; let lastErr = "";
    for (let attempt = 0; attempt < 3 && rows.length === 0; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 2500 * attempt));
      const md = await tinyfishFetch([url], { format: "markdown", links: true, images: true, purpose: "read product listings for price comparison" });
      if (md.errors.length) { lastErr = md.errors.map((e) => e.error).join(","); continue; }
      const text = md.results[0]?.text ?? "";
      if (/Checking your browser|Something went wrong on our end|Pardon Our Interruption/i.test(text)) { lastErr = "ebay bot wall / error page"; continue; }
      rows = fromMarkdown(text, md.results[0].links ?? [], sold, (md.results[0] as any).image_links ?? []);
      (ebay as any).lastPath = `markdown (attempt ${attempt + 1})`;
    }
    if (rows.length === 0 && lastErr) throw new Error(`ebay via tinyfish: ${lastErr}`);
    return rows.filter((r) => r.title && !/Shop on eBay/i.test(r.title)).slice(0, limit);
  },
};
